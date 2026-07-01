-- 018_sessions_group_by_perf.sql
--
-- Adds the composite index the /sessions page's GROUP BY needs.
--
-- Why this is expensive on 7d / 30d filters
-- -----------------------------------------
-- `loadSessionPage()` builds this query (dashboard/src/lib/reports.ts):
--
--   WITH grouped AS (
--     SELECT session_id, operator_name,
--            (array_agg(service_code  ORDER BY ts DESC NULLS LAST))[1] AS ...,
--            (array_agg(msisdn        ORDER BY ts DESC NULLS LAST))[1] AS ...,
--            MIN(ts), MAX(ts), COUNT(*),
--            (array_agg(handler_response_action ORDER BY ts DESC NULLS LAST))[1] AS ...,
--            (array_agg(error_class             ORDER BY ts DESC NULLS LAST))[1] AS ...,
--            (array_agg(ussd_string             ORDER BY ts DESC NULLS LAST))[1] AS ...,
--            (array_agg(handler_response_text   ORDER BY ts DESC NULLS LAST))[1] AS ...
--       FROM ussd_session_logs l
--      WHERE ts BETWEEN … AND …
--        AND operator_id = …
--      GROUP BY session_id, operator_name
--   ) …
--
-- Six `array_agg(x ORDER BY ts DESC)` aggregates over 30 days of legs
-- means PG has to sort every group by ts per-aggregate. Existing
-- indexes cover (ts), (session_id, ts), (operator_id, ts) but NOT
-- the full (session_id, operator_name, ts DESC) tuple that the
-- GroupAggregate step would use — so PG falls back to HashAggregate +
-- an in-memory Sort per group, which spills to disk once the working
-- set outgrows work_mem.
--
-- The composite index below lets the planner switch to a MergeJoin +
-- streaming GroupAggregate, which returns rows in the sort order the
-- aggregates need without a Sort at all.
--
-- Deploy pattern
-- --------------
-- CREATE INDEX in a migration takes an ACCESS EXCLUSIVE lock — that
-- would freeze the gateway during business hours. Same rule as
-- db/013: run the CONCURRENTLY variant out-of-band during a low-
-- traffic window, then this migration is a no-op via
-- `CREATE INDEX IF NOT EXISTS`.
--
--   docker exec -it ussd-postgres \
--     psql -U "$USSD_PG_USER" -d "$USSD_PG_DB" -c "
--       CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ussd_logs_session_op_ts_desc
--         ON ussd_session_logs (session_id, operator_name, ts DESC);
--     "
--
-- If you're on a fresh install with no traffic, apply this file
-- normally via the migrator sidecar — the ACCESS EXCLUSIVE lock is
-- a no-op on an empty table.

BEGIN;

CREATE INDEX IF NOT EXISTS idx_ussd_logs_session_op_ts_desc
    ON ussd_session_logs (session_id, operator_name, ts DESC);

COMMIT;
