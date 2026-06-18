-- 016_today_session_summary_mv.sql
--
-- Materialised view of TODAY's per-(operator, shortcode) summary.
-- Same shape as `daily_session_summary` (db/015) but covers just
-- today (Africa/Nairobi day boundary) and refreshes on a fast cron
-- so the /overview chart can show near-live numbers for today
-- without re-aggregating millions of legs at request time.
--
-- Read pattern (lib/overview.ts):
--   * Past days of the month       → `daily_session_summary` (db/015,
--                                      refreshed nightly)
--   * Today (Africa/Nairobi)       → `today_session_summary_mv` (this
--                                      file, refreshed via cron)
--
-- Refresh cron (operator action):
--   */5 * * * *  postgres  psql -d ussd -c "SELECT refresh_today_session_summary_mv();"
--
-- Tune the interval to taste — every minute is fine at low volume;
-- at 5M sessions/day each REFRESH scans the day-so-far slice of the
-- live partition, so cost grows linearly through the day. Every 5
-- minutes is a sensible default. CONCURRENTLY avoids blocking
-- readers; it requires the unique index below to exist.
--
-- Idempotent — CREATE MATERIALIZED VIEW IF NOT EXISTS / CREATE INDEX
-- IF NOT EXISTS / CREATE OR REPLACE FUNCTION.

CREATE MATERIALIZED VIEW IF NOT EXISTS today_session_summary_mv AS
WITH per_session AS (
    SELECT
        (l.ts AT TIME ZONE 'Africa/Nairobi')::date AS date,
        l.operator_id,
        COALESCE(l.shortcode_id, 0) AS shortcode_id,
        l.session_id,
        MIN(l.ts) AS first_ts,
        MAX(l.ts) AS last_ts,
        COUNT(*) AS legs_in_session,
        BOOL_OR(l.error_class IS NOT NULL) AS had_error
      FROM ussd_session_logs l
     WHERE (l.ts AT TIME ZONE 'Africa/Nairobi')::date
           = (now() AT TIME ZONE 'Africa/Nairobi')::date
     GROUP BY 1, 2, 3, 4
)
SELECT
    ps.date,
    ps.operator_id,
    ps.shortcode_id,
    COUNT(*)::bigint                                AS sessions,
    SUM(ps.legs_in_session)::bigint                 AS legs,
    COUNT(*) FILTER (WHERE ps.had_error)::bigint    AS errors,
    SUM(
        CASE WHEN o.billable_window_secs IS NOT NULL
             THEN GREATEST(
                    1,
                    CEIL(
                      EXTRACT(EPOCH FROM (ps.last_ts - ps.first_ts))::float8
                      / o.billable_window_secs::float8
                    )
                  )::int
             ELSE 1   -- per-leg MNO: 1 unit per session
        END
    )::bigint                                       AS billable_units
  FROM per_session ps
  JOIN operators   o ON o.id = ps.operator_id
 GROUP BY 1, 2, 3
WITH NO DATA;

-- Unique index — required for REFRESH MATERIALIZED VIEW CONCURRENTLY.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_today_session_summary_mv
    ON today_session_summary_mv (date, operator_id, shortcode_id);

-- Indexes the /overview chart query relies on for fast date/operator slicing.
CREATE INDEX IF NOT EXISTS idx_today_mv_operator
    ON today_session_summary_mv (operator_id);
CREATE INDEX IF NOT EXISTS idx_today_mv_shortcode
    ON today_session_summary_mv (shortcode_id);


-- refresh_today_session_summary_mv()
--   CONCURRENTLY-refreshes the MV. CONCURRENTLY requires the MV to
--   already be populated, which is why this function only handles
--   subsequent refreshes — the migration's initial populate uses a
--   plain REFRESH (see bottom of file).
CREATE OR REPLACE FUNCTION refresh_today_session_summary_mv()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY today_session_summary_mv;
END;
$$;


-- Bootstrap: populate the MV (non-concurrently — required for the
-- first refresh after CREATE … WITH NO DATA). Subsequent refreshes
-- via the function above use CONCURRENTLY so reads aren't blocked.
-- Skip if already populated (the relispopulated check) — re-running
-- the migration is then a no-op, and the cron handles ongoing refresh.
DO $$
BEGIN
    IF NOT (SELECT relispopulated FROM pg_class WHERE relname = 'today_session_summary_mv') THEN
        REFRESH MATERIALIZED VIEW today_session_summary_mv;
    END IF;
END $$;
