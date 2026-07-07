-- 019_partition_index_hook.sql
--
-- Rewires the partition-creation helpers from db/014 so every new
-- weekly (and future daily) partition automatically:
--   1) Gets its own child index matching the parent template defined
--      in db/018 — (session_id, operator_name, ts DESC).
--   2) Attaches that child index to the parent template so the parent
--      stays VALID.
--
-- Why this file exists
-- --------------------
-- PG < 17 does not allow CREATE INDEX CONCURRENTLY on a partitioned
-- parent (see db/018 header). Instead the parent index is a
-- "template" and each child partition needs its own matching index
-- attached to it. If ONE child is missing an attached index, the
-- parent template flips to INVALID and the planner stops using it —
-- the /sessions DISTINCT ON silently degrades back to the sort-spill
-- plan and the 30-day filter starts timing out again.
--
-- Without this hook, next Monday's weekly partition (created by the
-- cron in app/scheduler.py -> ensure_session_log_partitions_weekly)
-- ships without an attached child index and invalidates the parent.
-- The operator would need to re-run db/018's reconcile loop manually
-- every week. This file makes the fix automatic and permanent.
--
-- Idempotency
-- -----------
--   * The helper guards on the parent template's existence, so
--     calling it BEFORE db/018 has applied is a silent no-op. This
--     matters during db/014's bootstrap `SELECT
--     ensure_session_log_partitions_weekly(2)` on a fresh install,
--     which runs BEFORE db/018.
--   * The ATTACH is guarded by an "is-not-already-attached" check
--     so re-invoking the ensure function against a partition that
--     already has an attached index is a no-op (ATTACH twice would
--     otherwise error).
--   * `CREATE INDEX IF NOT EXISTS` on the child covers rebuild-after-
--     partial-failure without hand-cleanup.

BEGIN;

-- ---------- Shared helper --------------------------------------------
-- Build a child index on the given partition and attach it to the
-- parent template. No-op when:
--   * The parent template doesn't exist yet (db/018 not applied).
--   * The child index is already attached to the parent.
--
-- Uses plain CREATE INDEX (not CONCURRENTLY) because this is called
-- inline from the ensure-partitions cron path — the partition was
-- JUST created, has zero rows, and CREATE INDEX is instantaneous.
-- CONCURRENTLY cannot run inside a plpgsql function anyway
-- (transactional context).
CREATE OR REPLACE FUNCTION _ussd_logs_attach_sess_op_ts_desc_index(partname text)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    child_idxname text := partname || '__sess_op_ts_desc';
    already_attached boolean;
BEGIN
    -- Silent no-op when db/018 hasn't run yet — the parent template
    -- can't be attached to something that doesn't exist. db/018's
    -- reconcile loop will pick these partitions up when it applies.
    IF NOT EXISTS (
        SELECT 1 FROM pg_class WHERE relname = 'idx_ussd_logs_session_op_ts_desc'
    ) THEN
        RETURN;
    END IF;

    -- If the partition ALREADY has a child index attached to the
    -- parent template, we're done. This is the common path in
    -- practice: PG 12+ auto-inherits parent indexes onto new
    -- partitions at `CREATE TABLE ... PARTITION OF …` time, so by
    -- the time this helper runs, an auto-generated child index
    -- (`<partition>_<cols>_idx`) is already attached. Attempting a
    -- second CREATE + ATTACH under our own name would then fail
    -- with `Another index is already attached for partition …`.
    --
    -- The check keys on the PARTITION (not the index name) so it
    -- correctly recognises PG's auto-inherited index alongside our
    -- own reconcile-loop naming.
    SELECT EXISTS (
        SELECT 1
          FROM pg_inherits pi
          JOIN pg_class    ci        ON ci.oid       = pi.inhrelid
          JOIN pg_index    xi        ON xi.indexrelid = ci.oid
          JOIN pg_class    part      ON part.oid = xi.indrelid
          JOIN pg_class    parent_i  ON parent_i.oid = pi.inhparent
         WHERE part.relname     = partname
           AND parent_i.relname = 'idx_ussd_logs_session_op_ts_desc'
    ) INTO already_attached;

    IF already_attached THEN
        RETURN;
    END IF;

    -- Only reached when the partition somehow lacks an inherited
    -- child (e.g. the parent template was created AFTER this
    -- partition and the reconcile loop hasn't picked it up yet).
    EXECUTE format(
        'CREATE INDEX IF NOT EXISTS %I ON %I (session_id, operator_name, ts DESC)',
        child_idxname, partname
    );
    EXECUTE format(
        'ALTER INDEX idx_ussd_logs_session_op_ts_desc ATTACH PARTITION %I',
        child_idxname
    );
END;
$$;


-- ---------- Rewire the ensure functions to call the hook -------------
-- Bodies mirror db/014's originals EXACTLY except for the single
-- PERFORM line added inside the "just created a new partition" branch.
-- Keeping the rest identical means db/014 stays the canonical source
-- for scheduling / naming / target-window semantics; this file only
-- extends the post-CREATE step.

CREATE OR REPLACE FUNCTION ensure_session_log_partitions_weekly(weeks_ahead int)
RETURNS int
LANGUAGE plpgsql
AS $$
DECLARE
    created     int := 0;
    range_start date;
    range_end   date;
    partname    text;
    target_end  date := CURRENT_DATE + make_interval(weeks => weeks_ahead);
BEGIN
    range_start := _ussd_logs_latest_partition_end();
    IF range_start IS NULL THEN
        range_start := date_trunc('week', now())::date;
    END IF;

    WHILE range_start < target_end LOOP
        range_end := (range_start + interval '7 day')::date;
        partname  := 'ussd_session_logs_w_' || to_char(range_start, 'YYYY_MM_DD');

        IF NOT EXISTS (
            SELECT 1 FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE c.relname = partname AND n.nspname = 'public'
        ) THEN
            EXECUTE format(
                'CREATE TABLE %I PARTITION OF ussd_session_logs ' ||
                'FOR VALUES FROM (%L) TO (%L)',
                partname, range_start, range_end
            );
            -- Attach the sess_op_ts_desc child index — see db/019
            -- header for why this matters. No-op before db/018 applies.
            PERFORM _ussd_logs_attach_sess_op_ts_desc_index(partname);
            created := created + 1;
        END IF;
        range_start := range_end;
    END LOOP;
    RETURN created;
END;
$$;


CREATE OR REPLACE FUNCTION ensure_session_log_partitions_daily(days_ahead int)
RETURNS int
LANGUAGE plpgsql
AS $$
DECLARE
    created     int := 0;
    range_start date;
    range_end   date;
    partname    text;
    target_end  date := CURRENT_DATE + make_interval(days => days_ahead);
BEGIN
    range_start := _ussd_logs_latest_partition_end();
    IF range_start IS NULL THEN
        range_start := CURRENT_DATE;
    END IF;

    WHILE range_start < target_end LOOP
        range_end := (range_start + interval '1 day')::date;
        partname  := 'ussd_session_logs_d_' || to_char(range_start, 'YYYY_MM_DD');

        IF NOT EXISTS (
            SELECT 1 FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE c.relname = partname AND n.nspname = 'public'
        ) THEN
            EXECUTE format(
                'CREATE TABLE %I PARTITION OF ussd_session_logs ' ||
                'FOR VALUES FROM (%L) TO (%L)',
                partname, range_start, range_end
            );
            PERFORM _ussd_logs_attach_sess_op_ts_desc_index(partname);
            created := created + 1;
        END IF;
        range_start := range_end;
    END LOOP;
    RETURN created;
END;
$$;

COMMIT;
