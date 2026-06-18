-- 015_daily_session_summary_rollup.sql
--
-- Pre-aggregated daily rollup over ussd_session_logs, backing the
-- new /summary page. At 5M sessions/day live aggregation across even
-- 7 days = 140M rows scanned per page-load — unusable. This rollup
-- shifts the per-row work to a nightly batch and lets the page do
-- index-lookup-fast aggregations against a tiny derived table.
--
-- Scope (Option A — past days only):
--   The rollup contains rows for yesterday-and-earlier. Today's
--   traffic is NOT in the rollup; the /summary page renders a
--   "data through <yesterday>" stamp so users know what's in view.
--   To switch to "include rolling today", just add a second cron
--   line: */15 * * * * SELECT refresh_daily_session_summary(
--   CURRENT_DATE, CURRENT_DATE);  (no migration change needed.)
--
-- Grain: (date, operator_id, shortcode_id). One row per (date,
-- operator, shortcode) combination. shortcode_id=0 is a sentinel
-- for the 'shortcode_not_found' legs (live table has
-- shortcode_id IS NULL on those; PG primary keys can't include
-- NULL, hence the sentinel).
--
-- Refresh idempotency: refresh_daily_session_summary(start, end)
-- DELETEs every existing rollup row in [start, end] then re-inserts
-- the aggregates. Safe to run any number of times for any window —
-- catches late-arriving rows and corrects after any backfill.
--
-- Operational note: the bootstrap call at the bottom populates the
-- last 7 days. Daily refresh is on the operator (see cron snippet
-- in the deploy notes).

CREATE TABLE IF NOT EXISTS daily_session_summary (
    date            DATE         NOT NULL,
    operator_id     SMALLINT     NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
    -- 0 = sentinel for 'shortcode_not_found' legs (shortcode_id IS
    -- NULL on the live table). Keeps the PK NULL-free.
    shortcode_id    INTEGER      NOT NULL,
    sessions        BIGINT       NOT NULL,
    legs            BIGINT       NOT NULL,
    errors          BIGINT       NOT NULL,
    -- Sum across the day's sessions of:
    --   GREATEST(1, CEIL(duration_secs / operator.billable_window_secs))
    -- for operators with a window. For per-leg MNOs (window NULL,
    -- e.g. Halotel) it's 1 unit per session. Window value is
    -- SNAPSHOTTED at refresh time — re-billing historical days after
    -- an admin changes operator.billable_window_secs requires a
    -- manual refresh call for that window.
    billable_units  BIGINT       NOT NULL,
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    PRIMARY KEY (date, operator_id, shortcode_id)
);

CREATE INDEX IF NOT EXISTS idx_dss_date_desc
    ON daily_session_summary (date DESC);
CREATE INDEX IF NOT EXISTS idx_dss_shortcode_date
    ON daily_session_summary (shortcode_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_dss_operator_date
    ON daily_session_summary (operator_id, date DESC);


-- refresh_daily_session_summary(start_date, end_date)
--   Idempotent rebuild of the rollup for the inclusive date window.
--   Common usage:
--
--     SELECT refresh_daily_session_summary(CURRENT_DATE - 1, CURRENT_DATE - 1);
--     -- nightly: rebuild yesterday only (cheap)
--
--     SELECT refresh_daily_session_summary(CURRENT_DATE - 7, CURRENT_DATE - 1);
--     -- weekly reconcile: rebuild the past week (catches late-arriving rows)
--
--   Returns the number of rollup rows inserted (post-DELETE).
CREATE OR REPLACE FUNCTION refresh_daily_session_summary(
    start_date DATE,
    end_date   DATE
) RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
    inserted bigint := 0;
BEGIN
    IF start_date IS NULL OR end_date IS NULL OR end_date < start_date THEN
        RAISE EXCEPTION 'invalid window: start=% end=%', start_date, end_date;
    END IF;

    DELETE FROM daily_session_summary
     WHERE date >= start_date AND date <= end_date;

    -- One pass over the live table: per-session row (with operator +
    -- shortcode dimensions + min/max timestamps + leg count + had_error
    -- boolean), then aggregate per (date, operator, shortcode).
    WITH per_session AS (
        SELECT
            l.ts::date                       AS d,
            l.operator_id,
            COALESCE(l.shortcode_id, 0)      AS shortcode_id,
            l.session_id,
            MIN(l.ts)                        AS first_ts,
            MAX(l.ts)                        AS last_ts,
            COUNT(*)                         AS legs_in_session,
            BOOL_OR(l.error_class IS NOT NULL) AS had_error
          FROM ussd_session_logs l
         WHERE l.ts >= start_date::timestamptz
           AND l.ts <  (end_date + 1)::timestamptz
         GROUP BY 1, 2, 3, 4
    )
    INSERT INTO daily_session_summary
        (date, operator_id, shortcode_id, sessions, legs, errors, billable_units)
    SELECT
        ps.d,
        ps.operator_id,
        ps.shortcode_id,
        COUNT(*)::bigint                                AS sessions,
        SUM(ps.legs_in_session)::bigint                 AS legs,
        COUNT(*) FILTER (WHERE ps.had_error)::bigint    AS errors,
        SUM(
            CASE WHEN o.billable_window_secs IS NOT NULL
                 THEN GREATEST(1,
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
     GROUP BY 1, 2, 3;

    GET DIAGNOSTICS inserted = ROW_COUNT;
    RETURN inserted;
END;
$$;


-- Bootstrap: populate the last 7 days right now. Idempotent — calling
-- this in db_init on every container start just rebuilds those days
-- from the live table (fast on an empty DB; the cron handles ongoing
-- refreshes once data starts flowing).
SELECT refresh_daily_session_summary(
    (CURRENT_DATE - INTERVAL '7 day')::date,
    (CURRENT_DATE - INTERVAL '1 day')::date
);
