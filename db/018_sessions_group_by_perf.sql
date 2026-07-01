-- 018_sessions_group_by_perf.sql
--
-- Adds the composite index the /sessions page's DISTINCT ON needs.
--
-- Why this index
-- --------------
-- `loadSessionPage()` (dashboard/src/lib/reports.ts) rolls each
-- session's summary via:
--
--   SELECT DISTINCT ON (session_id, operator_name)
--          session_id, operator_name, …
--     FROM ussd_session_logs
--    WHERE ts BETWEEN … AND …
--      AND operator_id = …
--    ORDER BY session_id, operator_name, ts DESC
--
-- Without an index on (session_id, operator_name, ts DESC), PG plans
-- this as HashAggregate + per-group Sort — which spills to disk once
-- the working set outgrows work_mem. On 30-day windows over a busy
-- gateway that yields the 57014 statement_timeout the page catches.
--
-- With the index, PG walks it directly in the required order and
-- streams the DISTINCT ON — no sort, no spill.
--
-- Partitioned-table-aware pattern (PG 12 / 13 / 14 / 15 / 16)
-- ----------------------------------------------------------
-- PG < 17 does not allow CREATE INDEX CONCURRENTLY on a partitioned
-- parent. This migration therefore creates the index as a "template"
-- ON ONLY the parent (catalog-only, no data lock), then attaches a
-- matching index on every existing child partition.
--
-- Empty partition: CREATE INDEX inline is instantaneous — safe to
--   auto-apply via db_init.py on fresh installs and staging.
-- Partition with real data (current week on a busy gateway): CREATE
--   INDEX inline takes an ACCESS EXCLUSIVE lock proportional to row
--   count. Freeze the gateway. DO NOT let db_init.py apply this file
--   as-is against a hot production DB. Instead, run the CONCURRENTLY
--   dance below out-of-band FIRST — then this migration becomes a
--   no-op (CREATE INDEX IF NOT EXISTS + ATTACH-skip guard).
--
-- Out-of-band CONCURRENTLY runbook (production)
-- ---------------------------------------------
--   docker run --rm -i --network=host -e PGPASSWORD="$USSD_PG_PASSWORD" \
--     postgres:12-alpine \
--     psql "host=$USSD_PG_HOST port=$USSD_PG_PORT user=$USSD_PG_USER \
--           dbname=$USSD_PG_DB sslmode=${USSD_PG_SSLMODE:-prefer}" <<'SQL'
--     -- 1) Parent template (fast, catalog-only, no data lock)
--     CREATE INDEX IF NOT EXISTS idx_ussd_logs_session_op_ts_desc
--         ON ONLY ussd_session_logs (session_id, operator_name, ts DESC);
--
--     -- 2) Build each child CONCURRENTLY (one at a time; only the
--     --    current-week partition is slow, the rest complete in ms).
--     SELECT format(
--       'CREATE INDEX CONCURRENTLY IF NOT EXISTS %I ON %I (session_id, operator_name, ts DESC);',
--       c.relname || '__sess_op_ts_desc',
--       c.relname
--     )
--       FROM pg_inherits i
--       JOIN pg_class c ON c.oid = i.inhrelid
--      WHERE i.inhparent = 'ussd_session_logs'::regclass
--      ORDER BY c.relname
--     \gexec
--
--     -- 3) Attach each child to the parent template. When the last
--     --    child is attached, the parent auto-flips to VALID.
--     SELECT format(
--       'ALTER INDEX idx_ussd_logs_session_op_ts_desc ATTACH PARTITION %I;',
--       c.relname || '__sess_op_ts_desc'
--     )
--       FROM pg_inherits i
--       JOIN pg_class c ON c.oid = i.inhrelid
--      WHERE i.inhparent = 'ussd_session_logs'::regclass
--      ORDER BY c.relname
--     \gexec
--
--     -- 4) Verify + refresh planner stats
--     SELECT c.relname, i.indisvalid, i.indisready
--       FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
--      WHERE c.relname = 'idx_ussd_logs_session_op_ts_desc';
--     ANALYZE ussd_session_logs;
--   SQL
--
-- After the out-of-band build succeeds on production, applying this
-- migration file is a series of catalog no-ops (< 100 ms total).
--
-- Ongoing hook — see db/019
-- -------------------------
-- Every new weekly/daily partition created by the cron would ship
-- WITHOUT an attached child index, which flips the parent template
-- back to INVALID and defeats the whole point. db/019 rewires
-- ensure_session_log_partitions_weekly/_daily so every new partition
-- gets its child index built + attached at creation time.

BEGIN;

-- (1) Parent template on the partitioned parent. ON ONLY = no
-- recurse into children, so this takes no data lock. Comes up
-- INVALID until every child has an attached matching index.
CREATE INDEX IF NOT EXISTS idx_ussd_logs_session_op_ts_desc
    ON ONLY ussd_session_logs (session_id, operator_name, ts DESC);

-- (2) Reconcile every existing child partition:
--   * CREATE INDEX IF NOT EXISTS on the child (idempotent).
--   * ATTACH the child index to the parent template — but only
--     when it isn't already attached (repeat ATTACH would error).
-- Fresh install: partitions are empty, so CREATE INDEX is
-- instantaneous. Post-CONCURRENTLY-dance production: everything is
-- already in place, so this is a series of pg_catalog no-ops.
DO $$
DECLARE
    child_relname text;
    child_idxname text;
BEGIN
    FOR child_relname IN
        SELECT c.relname
          FROM pg_inherits i
          JOIN pg_class c ON c.oid = i.inhrelid
          JOIN pg_class p ON p.oid = i.inhparent
         WHERE p.relname = 'ussd_session_logs'
    LOOP
        child_idxname := child_relname || '__sess_op_ts_desc';

        EXECUTE format(
            'CREATE INDEX IF NOT EXISTS %I ON %I (session_id, operator_name, ts DESC)',
            child_idxname, child_relname
        );

        IF NOT EXISTS (
            SELECT 1
              FROM pg_inherits pi
              JOIN pg_class    ci       ON ci.oid       = pi.inhrelid
              JOIN pg_class    parent_i ON parent_i.oid = pi.inhparent
             WHERE ci.relname       = child_idxname
               AND parent_i.relname = 'idx_ussd_logs_session_op_ts_desc'
        ) THEN
            EXECUTE format(
                'ALTER INDEX idx_ussd_logs_session_op_ts_desc ATTACH PARTITION %I',
                child_idxname
            );
        END IF;
    END LOOP;
END $$;

-- (3) Post-condition — parent template MUST be VALID. If any
-- partition is missing an attached child index, PG keeps the
-- parent INVALID; the planner ignores it and /sessions drops
-- back to the sort-spill plan. Fail loud so the operator sees it.
DO $$
DECLARE
    is_valid boolean;
BEGIN
    SELECT i.indisvalid INTO is_valid
      FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
     WHERE c.relname = 'idx_ussd_logs_session_op_ts_desc';

    IF is_valid IS NULL THEN
        RAISE EXCEPTION
          'idx_ussd_logs_session_op_ts_desc was not created — check earlier output';
    END IF;

    IF NOT is_valid THEN
        RAISE EXCEPTION
          'idx_ussd_logs_session_op_ts_desc is INVALID after reconcile — one or more child partitions missing attached index. Re-run the CONCURRENTLY runbook in this file''s header.';
    END IF;
END $$;

COMMIT;
