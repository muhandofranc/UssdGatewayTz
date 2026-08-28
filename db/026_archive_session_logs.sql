-- 026_archive_session_logs.sql
--
-- Retention becomes ARCHIVAL: instead of dropping partitions older than
-- the retention window, re-parent them onto a separate archive table
-- that no part of the platform queries.
--
-- Pre-026: `drop_old_session_log_partitions(90)` ran nightly from
-- app/scheduler.py and DROPped every partition whose range ended more
-- than 90 days ago. Fast, but the legs were gone for good — MSISDNs,
-- dialed strings, handler responses, per-session detail. Only the
-- `daily_session_summary` aggregates survived.
--
-- Post-026: `archive_old_session_log_partitions(120)` DETACHes each
-- expired partition from `ussd_session_logs` and ATTACHes it to
-- `ussd_session_logs_archive`. The window also widens 90 → 120 days.
--
-- Why re-parenting rather than INSERT INTO … SELECT:
--   The partition's files never move. Postgres only changes which
--   table owns them, so archiving a week is metadata work — measured
--   at ~13 ms to detach and ~90 ms to attach a 2M-row partition, vs
--   minutes of WAL-logged copying for the same rows.
--
-- Why the archive is a SEPARATE parent, not a flag on the live table:
--   Query planning cost scales with the live table's partition count,
--   and every dashboard query would have to be taught to exclude
--   archived rows. A separate parent means nothing plans them, nothing
--   locks them, and no query can accidentally include them.
--
-- Why the archive has NO indexes:
--   Indexes are ~72% of a partition's size (540 MB of index against
--   208 MB of heap, on the 2M-row partition measured). The archive is
--   cold and partitioned by ts, so pruning already narrows any lookup
--   to a single week; a seq scan within one week is acceptable for the
--   rare forensic query. Dropping them took that partition from 747 MB
--   to 268 MB. Rebuild one by hand if a real access pattern appears.
--
-- Why a PROCEDURE and not a FUNCTION:
--   A function body is one transaction, so it would hold the
--   ACCESS EXCLUSIVE lock on ussd_session_logs — taken by DETACH —
--   until every expired partition had been processed, queueing the
--   gateway's writes behind it. A procedure can COMMIT between
--   partitions, so the lock is held for milliseconds at a time.
--
-- Why plain DETACH and not DETACH … CONCURRENTLY:
--   CONCURRENTLY is refused outright while a DEFAULT partition exists
--   ("cannot detach partitions concurrently when a default partition
--   exists"), and db/004's default partition must stay — it is the
--   safety net that keeps the gateway's inserts succeeding if the
--   partition-creation cron ever lapses. Plain DETACH takes the
--   exclusive lock for ~13 ms, guarded by lock_timeout below.
--
-- Idempotent. Safe to re-run.

-- ---------- (1) The archive parent ----------------------------------
-- LIKE (without INCLUDING) copies the column list, types and NOT NULLs
-- and nothing else: no indexes to maintain, no defaults, no PK. Column
-- order matches exactly, which is what ATTACH PARTITION requires.
--
-- No DEFAULT partition here, deliberately: a row that matches no range
-- should fail loudly rather than land in an archive catch-all nobody
-- reads.
CREATE TABLE IF NOT EXISTS ussd_session_logs_archive
    (LIKE ussd_session_logs)
    PARTITION BY RANGE (ts);

COMMENT ON TABLE ussd_session_logs_archive IS
    'Cold storage for expired ussd_session_logs partitions. Re-parented '
    'by archive_old_session_log_partitions(); never queried by the '
    'gateway, dashboard or rollups. Unindexed by design — prune by ts.';


-- ---------- (2) The archival procedure -------------------------------
CREATE OR REPLACE PROCEDURE archive_old_session_log_partitions(
    days_to_keep int,
    INOUT archived int DEFAULT 0
)
LANGUAGE plpgsql
AS $$
DECLARE
    cutoff      timestamptz := now() - make_interval(days => days_to_keep);
    rec         record;
    upper_bound timestamptz;
    base_name   text;
    new_name    text;
    suffix      int;
    failed      text;
    con         record;
    idx         record;
BEGIN
    archived := 0;

    FOR rec IN
        SELECT c.oid                              AS child_oid,
               c.relname                          AS name,
               pg_get_expr(c.relpartbound, c.oid) AS bound
          FROM pg_inherits i
          JOIN pg_class c ON c.oid = i.inhrelid
          JOIN pg_class p ON p.oid = i.inhparent
         WHERE p.relname = 'ussd_session_logs'
           -- The catch-all never expires: it holds whatever fell
           -- outside every range, and its rows span all time.
           AND c.relname <> 'ussd_session_logs_default'
         ORDER BY c.relname
    LOOP
        -- Read the real upper bound out of the catalogue rather than
        -- parsing the partition NAME. Naming conventions have already
        -- changed twice here (monthly → weekly → daily); the bound is
        -- the truth regardless of what the table is called.
        upper_bound := (regexp_match(rec.bound, 'TO \(''([^'']+)''\)'))[1]::timestamptz;
        CONTINUE WHEN upper_bound IS NULL;          -- DEFAULT / odd shape
        CONTINUE WHEN upper_bound > cutoff;         -- still inside the window

        -- Rename so an operator reading \dt can tell at a glance which
        -- side of the fence a partition is on. Metadata-only.
        --
        -- The name can already be taken: partition names encode a start
        -- date, and a range that was archived once can be recreated in
        -- the live table (a hand-made partition, a back-fill). Find a
        -- free name rather than letting the collision abort the run.
        base_name := replace(rec.name, 'ussd_session_logs_', 'ussd_logs_arch_');
        new_name  := base_name;
        suffix    := 1;
        WHILE to_regclass(new_name) IS NOT NULL LOOP
            suffix   := suffix + 1;
            new_name := base_name || '_' || suffix;
        END LOOP;

        failed := NULL;
        BEGIN
            -- Bound the wait, not the work: DETACH needs ACCESS EXCLUSIVE
            -- on the live table, and while it waits every gateway INSERT
            -- queues behind it. If a long report is in flight, give up —
            -- retention has 30+ days of slack.
            SET LOCAL lock_timeout = '5s';

            EXECUTE format('ALTER TABLE ussd_session_logs DETACH PARTITION %I', rec.name);
            EXECUTE format('ALTER TABLE %I RENAME TO %I', rec.name, new_name);
            -- Re-use the bound expression verbatim, so the archive's
            -- range is identical to the one the live table had.
            EXECUTE format('ALTER TABLE ussd_session_logs_archive ATTACH PARTITION %I %s',
                           new_name, rec.bound);

            -- Shed the indexes. Constraint-backed ones (the (id, ts) PK)
            -- can't be dropped with DROP INDEX, so clear constraints first.
            FOR con IN
                SELECT conname FROM pg_constraint
                 WHERE conrelid = new_name::regclass AND contype IN ('p', 'u')
            LOOP
                EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', new_name, con.conname);
            END LOOP;

            FOR idx IN
                SELECT indexrelid::regclass::text AS iname
                  FROM pg_index WHERE indrelid = new_name::regclass
            LOOP
                EXECUTE format('DROP INDEX %s', idx.iname);
            END LOOP;
        EXCEPTION
            WHEN lock_not_available THEN
                -- Something long-running holds the live table. Stop the
                -- whole run: the next partition would only queue behind
                -- the same reader. Tonight's work so far stays committed.
                failed := 'lock';
            WHEN OTHERS THEN
                -- One unhappy partition must not strand every later one
                -- behind it, so record and carry on.
                failed := format('%s (%s)', SQLERRM, SQLSTATE);
        END;

        -- COMMIT lives OUTSIDE the block above: PL/pgSQL forbids it
        -- inside a block carrying an EXCEPTION clause.
        IF failed IS NULL THEN
            archived := archived + 1;
            RAISE NOTICE 'archived % → % (ended %)', rec.name, new_name, upper_bound;
            COMMIT;                 -- release the exclusive lock now
        ELSIF failed = 'lock' THEN
            ROLLBACK;
            RAISE NOTICE 'live table busy — stopping after % partition(s); retry next run', archived;
            EXIT;
        ELSE
            ROLLBACK;
            RAISE WARNING 'skipped %: %', rec.name, failed;
        END IF;
    END LOOP;
END;
$$;

COMMENT ON PROCEDURE archive_old_session_log_partitions(int, int) IS
    'Re-parents ussd_session_logs partitions older than days_to_keep '
    'onto ussd_session_logs_archive. Metadata-only: no rows are copied. '
    'Commits per partition so the live table''s exclusive lock is held '
    'for milliseconds at a time.';


-- ---------- (3) Archive retention (deliberately UNSCHEDULED) ---------
-- The archive grows without bound, so it needs an end-of-life story.
-- This is the lever for it — left out of app/scheduler.py on purpose,
-- because the intended path is: ship the partition to S3 first, verify,
-- and only then drop it locally.
CREATE OR REPLACE PROCEDURE drop_old_archive_partitions(days_to_keep int)
LANGUAGE plpgsql
AS $$
DECLARE
    cutoff      timestamptz := now() - make_interval(days => days_to_keep);
    rec         record;
    upper_bound timestamptz;
BEGIN
    FOR rec IN
        SELECT c.relname AS name, pg_get_expr(c.relpartbound, c.oid) AS bound
          FROM pg_inherits i
          JOIN pg_class c ON c.oid = i.inhrelid
          JOIN pg_class p ON p.oid = i.inhparent
         WHERE p.relname = 'ussd_session_logs_archive'
    LOOP
        upper_bound := (regexp_match(rec.bound, 'TO \(''([^'']+)''\)'))[1]::timestamptz;
        CONTINUE WHEN upper_bound IS NULL OR upper_bound > cutoff;
        EXECUTE format('DROP TABLE %I', rec.name);
        RAISE NOTICE 'dropped archive partition % (ended %)', rec.name, upper_bound;
        COMMIT;
    END LOOP;
END;
$$;


-- ---------- (4) What's in the archive --------------------------------
-- The inventory an export job iterates: one row per archived partition
-- with its exact date range and on-disk size. A future S3 shipper can
-- COPY each partition out by name, confirm the upload, then call
-- drop_old_archive_partitions() — or DROP TABLE the individual one.
CREATE OR REPLACE VIEW ussd_session_log_archive_partitions AS
SELECT c.relname                                                   AS partition_name,
       (regexp_match(pg_get_expr(c.relpartbound, c.oid),
                     'FROM \(''([^'']+)''\)'))[1]::timestamptz      AS covers_from,
       (regexp_match(pg_get_expr(c.relpartbound, c.oid),
                     'TO \(''([^'']+)''\)'))[1]::timestamptz        AS covers_to,
       c.reltuples::bigint                                          AS approx_rows,
       pg_total_relation_size(c.oid)                                AS bytes,
       pg_size_pretty(pg_total_relation_size(c.oid))                AS size
  FROM pg_inherits i
  JOIN pg_class c ON c.oid = i.inhrelid
  JOIN pg_class p ON p.oid = i.inhparent
 WHERE p.relname = 'ussd_session_logs_archive'
 ORDER BY 2;

COMMENT ON VIEW ussd_session_log_archive_partitions IS
    'Inventory of archived partitions — name, covered range, size. '
    'Intended as the work-list for an S3 export job.';
