-- 013_ussd_session_logs_perf.sql
--
-- Performance pack for `ussd_session_logs` — closes the index gaps
-- that show up when the table grows past ~1M rows and the dashboard's
-- /reports + /sessions filter dropdowns become slow.
--
-- Gaps closed:
--
--   (1) operator_name filter — `dashboard/src/lib/reports.ts`
--       filters via `operator_name = ANY(text[])`, but the legacy
--       index in 001_init.sql is on operator_id. The query was doing
--       a seq scan whenever the operator dropdown was used. Added an
--       index on (operator_name, ts DESC).
--
--   (2) error_class filter — partial index for the very common
--       "show errors only" filter (`error_class IS NOT NULL`), plus
--       a B-tree on the specific error_class values so dropdown
--       lookups like `error_class = 'handler_timeout'` are O(log n).
--
--   (3) Planner statistics on `ts` — the default 100-bucket histogram
--       is too coarse at million-row scale; the planner under/over-
--       estimates row counts for date ranges and picks a suboptimal
--       join order. Bumping to 1000 makes selectivity estimates sharp.
--
-- Partition lifecycle helpers (rolling create + retention drop)
-- finish the migration — db/004 sets up monthly partitions for a
-- ~12-month window from the deploy date but never extends them. The
-- two plpgsql functions below let ops call them on a schedule
-- (or call them manually):
--
--   SELECT ensure_session_log_partitions(6);     -- 6 months ahead
--   SELECT drop_old_session_log_partitions(12);  -- keep last 12 months
--
-- ============================================================
-- PRODUCTION NOTE — applying to a non-empty ussd_session_logs
-- ============================================================
-- The CREATE INDEX statements below take an ACCESS EXCLUSIVE lock
-- on each partition while building. On an empty / dev DB this is
-- instant. On a hot prod DB with millions of rows it blocks writes
-- for the duration of the build (potentially minutes).
--
-- For prod, apply this file MANUALLY with CONCURRENTLY swapped in
-- for each CREATE INDEX:
--
--   psql "$DATABASE_URL" \
--     -c "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ussd_logs_operator_name_ts \
--           ON ussd_session_logs (operator_name, ts DESC);"
--   (... and so on for each index)
--   psql "$DATABASE_URL" -f db/013_ussd_session_logs_perf.sql  -- the rest
--
-- CONCURRENTLY cannot run inside a transaction, so the auto-apply via
-- `app/db_init.py` (which runs the whole file in one go) can't do it
-- safely. Idempotent CREATE INDEX IF NOT EXISTS here means a second
-- file-apply after the manual CONCURRENTLY step is a no-op.
-- ============================================================

-- ---------- (1) operator_name filter coverage ----------------------

CREATE INDEX IF NOT EXISTS idx_ussd_logs_operator_name_ts
    ON ussd_session_logs (operator_name, ts DESC);

-- ---------- (2) error_class filter coverage ------------------------

-- Partial index — only indexes ERROR rows (typically <5% of traffic).
-- Smaller, faster, perfect for "errors in the last hour" triage.
CREATE INDEX IF NOT EXISTS idx_ussd_logs_errors_ts
    ON ussd_session_logs (ts DESC)
 WHERE error_class IS NOT NULL;

-- Equality lookups for specific classes (e.g. error_class = 'handler_timeout').
-- Partial again so it ignores the NULL "success" rows.
CREATE INDEX IF NOT EXISTS idx_ussd_logs_error_class_ts
    ON ussd_session_logs (error_class, ts DESC)
 WHERE error_class IS NOT NULL;

-- ---------- (3) Better planner stats for ts ------------------------

-- 1000 stats targets ≈ 10× the default histogram resolution. Cost is
-- a one-shot ANALYZE; benefit is more accurate row-estimates for
-- date-range filters (the dominant predicate on this table). Worth
-- bumping at million-row scale.
ALTER TABLE ussd_session_logs ALTER COLUMN ts SET STATISTICS 1000;
ANALYZE ussd_session_logs;

-- ---------- (4) Partition lifecycle helpers ------------------------

-- ensure_session_log_partitions(N)
--   Create monthly partitions from the current month up to N months
--   ahead. Idempotent — existing partitions are left alone. Returns
--   the number of new partitions created.
--
-- Operational pattern: run on a monthly cron from ops (e.g. a cron
-- in /etc/cron.d/ on the DB host or a scheduled `psql -c` from the
-- gateway container) — calling `ensure_session_log_partitions(6)`
-- monthly keeps a permanent 6-month buffer ahead of incoming rows.
-- A row falling into the DEFAULT partition is non-fatal but signals
-- that the cron has lapsed; ops should re-run this and then move the
-- DEFAULT rows into the correct monthly partitions with a manual
-- INSERT/DELETE.
CREATE OR REPLACE FUNCTION ensure_session_log_partitions(months_ahead int)
RETURNS int
LANGUAGE plpgsql
AS $$
DECLARE
    created     int := 0;
    i           int;
    m           date;
    partname    text;
    range_start date;
    range_end   date;
BEGIN
    FOR i IN 0..months_ahead LOOP
        m := date_trunc('month', now() + make_interval(months => i))::date;
        partname := 'ussd_session_logs_' || to_char(m, 'YYYY_MM');
        range_start := m;
        range_end   := (m + interval '1 month')::date;

        -- Skip if the partition already exists.
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
            created := created + 1;
        END IF;
    END LOOP;
    RETURN created;
END;
$$;

-- drop_old_session_log_partitions(N)
--   Drop monthly partitions older than the start of the current
--   month minus N months. Returns the number of partitions dropped.
--
-- Operational pattern: a SECOND cron (separate from the create
-- helper). Dropping a partition is a fast metadata-only operation —
-- no row-level VACUUM/DELETE. If you need cold-storage of dropped
-- months, snapshot to a separate archive table or S3 export BEFORE
-- calling this.
CREATE OR REPLACE FUNCTION drop_old_session_log_partitions(months_to_keep int)
RETURNS int
LANGUAGE plpgsql
AS $$
DECLARE
    dropped int := 0;
    cutoff  date := date_trunc('month', now() - make_interval(months => months_to_keep))::date;
    rec     record;
BEGIN
    FOR rec IN
        SELECT c.relname
          FROM pg_inherits i
          JOIN pg_class c ON c.oid = i.inhrelid
          JOIN pg_class p ON p.oid = i.inhparent
         WHERE p.relname = 'ussd_session_logs'
           AND c.relname ~ '^ussd_session_logs_[0-9]{4}_[0-9]{2}$'
           AND to_date(right(c.relname, 7), 'YYYY_MM') < cutoff
    LOOP
        EXECUTE format('DROP TABLE %I', rec.relname);
        dropped := dropped + 1;
    END LOOP;
    RETURN dropped;
END;
$$;

-- Extend the partition runway 6 months ahead right now. Safe to call
-- on every migration apply — idempotent.
SELECT ensure_session_log_partitions(6);
