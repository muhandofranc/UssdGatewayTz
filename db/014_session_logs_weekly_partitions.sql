-- 014_session_logs_weekly_partitions.sql
--
-- Switch ussd_session_logs from MONTHLY partitions (db/004) to WEEKLY
-- partitions going forward, with a forward-compatible DAILY function
-- ready for the planned cutover when volume crosses ~5M sessions/day.
--
-- Retention: 90 days. Buffer: 2 weeks ahead (covers ≥ 7 days of
-- runway against cron lapses).
--
-- Why this shape:
--   * The CURRENT month's monthly partition stays in place — it
--     already has data and rewriting it inline is invasive. New
--     weekly partitions start at the first day AFTER the current
--     month ends, so there's never an overlap with the existing
--     monthly range. The June (or whatever current) monthly serves
--     out the rest of the month; weekly takes over from month-end.
--   * Empty FUTURE monthly partitions created by db/004 (next 6
--     months) are dropped — they'd otherwise overlap with the new
--     weekly partitions.
--   * Two new functions: `..._weekly(weeks_ahead)` (used now) and
--     `..._daily(days_ahead)` (used after the future cutover). Both
--     compute the next start-date from the LATEST existing partition,
--     so weekly + daily can coexist during a cutover transition
--     without conflict.
--   * The retention function rewrites in terms of DAYS (was months
--     in db/013) so 90-day retention is expressible exactly. It
--     recognises all three partition-name patterns:
--         monthly: ussd_session_logs_YYYY_MM
--         weekly:  ussd_session_logs_w_YYYY_MM_DD
--         daily:   ussd_session_logs_d_YYYY_MM_DD
--
-- Operational changes (cron):
--   * REPLACE the old monthly cron with a WEEKLY cron:
--       0 2 * * MON  postgres  psql -d ussd -c "SELECT ensure_session_log_partitions_weekly(2);"
--   * Keep retention at any frequency you like (weekly is fine):
--       30 2 * * MON  postgres  psql -d ussd -c "SELECT drop_old_session_log_partitions(90);"
--
-- When to switch from weekly → daily (future):
--   Sustained ≥ 5M sessions/day for several weeks, OR weekly
--   partition size exceeds ~150M rows. Procedure:
--     1. Run ensure_session_log_partitions_daily(7) — creates 7 days
--        of daily partitions starting from the latest existing
--        weekly's end date. No overlap, no data move.
--     2. Update the cron to call _daily(7) every day instead of
--        _weekly(2) every Monday.
--     3. Existing weekly + monthly partitions keep serving their
--        ranges; daily takes over from the cutover day onward.
--
-- ============================================================
-- PRODUCTION NOTE — CREATE INDEX and partition recreations
-- take ACCESS EXCLUSIVE locks. This migration's CREATEs are
-- all on EMPTY future partitions (no data), so they're
-- instantaneous regardless of overall table size. Safe to
-- auto-apply via db_init.py.
-- ============================================================


-- ---------- (1) Drop empty FUTURE monthly partitions ---------------
-- db/004 created partitions for the next 6 months. Those are empty
-- on day-1; drop them so weekly can fit in their place without an
-- overlap error. The CURRENT month's monthly partition stays — it
-- holds the data so far this month, and serves out the rest of the
-- month. Weekly takes over from the first day AFTER current month.

DO $$
DECLARE
    cur_month_start date := date_trunc('month', now())::date;
    rec             record;
BEGIN
    FOR rec IN
        SELECT c.relname AS name
          FROM pg_inherits i
          JOIN pg_class c ON c.oid = i.inhrelid
          JOIN pg_class p ON p.oid = i.inhparent
         WHERE p.relname = 'ussd_session_logs'
           AND c.relname ~ '^ussd_session_logs_[0-9]{4}_[0-9]{2}$'
           AND to_date(right(c.relname, 7), 'YYYY_MM') > cur_month_start
    LOOP
        EXECUTE format('DROP TABLE %I', rec.name);
        RAISE NOTICE 'dropped empty future monthly partition: %', rec.name;
    END LOOP;
END $$;


-- ---------- (2) Replace the monthly ensure function with weekly + daily

-- Drop the old monthly-only ensure function from db/013. The new
-- pair below covers weekly + daily; nothing should be creating new
-- monthly partitions after this migration.
DROP FUNCTION IF EXISTS ensure_session_log_partitions(int);

-- Helper: compute the LATEST end-date among all child partitions,
-- regardless of naming convention. Returns NULL when no partitions
-- exist (fresh DB before db/004 had a chance to seed anything).
CREATE OR REPLACE FUNCTION _ussd_logs_latest_partition_end()
RETURNS date
LANGUAGE plpgsql
AS $$
DECLARE
    latest date;
BEGIN
    SELECT MAX(end_date) INTO latest FROM (
        SELECT
            CASE
                WHEN c.relname ~ '^ussd_session_logs_[0-9]{4}_[0-9]{2}$'
                  THEN (to_date(right(c.relname, 7), 'YYYY_MM') + interval '1 month')::date
                WHEN c.relname ~ '^ussd_session_logs_w_[0-9]{4}_[0-9]{2}_[0-9]{2}$'
                  THEN (to_date(right(c.relname, 10), 'YYYY_MM_DD') + interval '7 day')::date
                WHEN c.relname ~ '^ussd_session_logs_d_[0-9]{4}_[0-9]{2}_[0-9]{2}$'
                  THEN (to_date(right(c.relname, 10), 'YYYY_MM_DD') + interval '1 day')::date
                ELSE NULL
            END AS end_date
          FROM pg_inherits i
          JOIN pg_class c ON c.oid = i.inhrelid
          JOIN pg_class p ON p.oid = i.inhparent
         WHERE p.relname = 'ussd_session_logs'
    ) x;
    RETURN latest;
END;
$$;


-- ensure_session_log_partitions_weekly(weeks_ahead)
--   Ensure partition coverage extends at least `weeks_ahead` weeks
--   beyond TODAY. Idempotent — calling repeatedly between cron
--   runs is a no-op once the runway is full. Returns the number
--   created.
--
--   Semantics: TARGET = today + weeks_ahead × 7 days. New 7-day
--   partitions are appended starting from the latest existing
--   partition's end-date until the target is reached. A cron
--   firing more often than once a week is fine — extra calls
--   are no-ops.
--
--   Weekly partitions are NOT ISO-Monday-aligned by design: the
--   start date is determined by whichever partition currently has
--   the latest end-date (typically the current month's monthly
--   partition, which ends on day-1 of next month). Strict ISO
--   alignment would need a stub partition to bridge the gap.
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
    -- Fresh DB / no partitions: start from this week.
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
            created := created + 1;
        END IF;
        range_start := range_end;
    END LOOP;
    RETURN created;
END;
$$;


-- ensure_session_log_partitions_daily(days_ahead)
--   Same target-date semantics as the weekly variant, but with
--   1-day partitions and the 'd_' name prefix. Reserved for the
--   post-cutover cron when volume justifies daily.
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
            created := created + 1;
        END IF;
        range_start := range_end;
    END LOOP;
    RETURN created;
END;
$$;


-- ---------- (3) Replace retention helper (days-precision) ----------

-- db/013's drop function used MONTHS-precision retention; 90-day
-- retention isn't expressible as months. Replace with a DAYS-precision
-- function that recognises all three partition-name patterns.
DROP FUNCTION IF EXISTS drop_old_session_log_partitions(int);

CREATE OR REPLACE FUNCTION drop_old_session_log_partitions(days_to_keep int)
RETURNS int
LANGUAGE plpgsql
AS $$
DECLARE
    dropped  int := 0;
    cutoff   date := (now() - make_interval(days => days_to_keep))::date;
    rec      record;
    part_end date;
BEGIN
    FOR rec IN
        SELECT c.relname AS name
          FROM pg_inherits i
          JOIN pg_class c ON c.oid = i.inhrelid
          JOIN pg_class p ON p.oid = i.inhparent
         WHERE p.relname = 'ussd_session_logs'
    LOOP
        -- Skip the catch-all DEFAULT partition (db/004 creates one).
        -- Operators can manually move/drop default-partition rows.
        IF rec.name = 'ussd_session_logs_default' THEN
            CONTINUE;
        END IF;

        IF    rec.name ~ '^ussd_session_logs_[0-9]{4}_[0-9]{2}$' THEN
            part_end := (to_date(right(rec.name, 7), 'YYYY_MM') + interval '1 month')::date;
        ELSIF rec.name ~ '^ussd_session_logs_w_[0-9]{4}_[0-9]{2}_[0-9]{2}$' THEN
            part_end := (to_date(right(rec.name, 10), 'YYYY_MM_DD') + interval '7 day')::date;
        ELSIF rec.name ~ '^ussd_session_logs_d_[0-9]{4}_[0-9]{2}_[0-9]{2}$' THEN
            part_end := (to_date(right(rec.name, 10), 'YYYY_MM_DD') + interval '1 day')::date;
        ELSE
            -- Unknown naming — leave alone, don't drop.
            CONTINUE;
        END IF;

        -- Drop only when the WHOLE partition is older than cutoff.
        IF part_end <= cutoff THEN
            EXECUTE format('DROP TABLE %I', rec.name);
            dropped := dropped + 1;
        END IF;
    END LOOP;
    RETURN dropped;
END;
$$;


-- ---------- (4) Bootstrap: create runway + apply retention ---------

-- Create the next 2 weekly partitions starting from the end of the
-- current monthly partition. Idempotent — re-running the migration
-- after a cron has filled in further weeks is a no-op.
SELECT ensure_session_log_partitions_weekly(2);

-- Apply 90-day retention. On a brand-new DB this is a no-op (nothing
-- older than today exists yet); on an existing DB it drops anything
-- whose range ends > 90 days ago.
SELECT drop_old_session_log_partitions(90);
