-- 023_billing_ceil_to_second_alignment.sql
--
-- Documentation/parity alignment (NO numeric change).
--
-- Express per-session billing the SAME way everywhere: round each session's
-- duration UP to a whole second FIRST, then CEIL over the operator's billing
-- window. This mirrors the dashboard Sessions view and the whole-second
-- Duration column shown there.
--
-- Why it's a no-op on the numbers: for any integer window w,
--     CEIL(x / w) == CEIL(CEIL(x) / w)
-- (proved by exhaustive sweep 0..600s over the 20s/30s windows). So
-- billable_units are byte-for-byte identical to the previous
-- CEIL(duration / window) form. Because nothing changes, existing
-- daily_session_summary rows do NOT need re-refreshing — this only makes
-- future refreshes and the today MV read the same as the live Sessions query.

-- ---------------------------------------------------------------------------
-- 1) Daily rollup function — inner CEIL rounds the duration up to the second.
-- ---------------------------------------------------------------------------
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
                            -- round the session duration UP to a whole second,
                            -- then CEIL over the window (== CEIL(duration/window))
                            CEIL(EXTRACT(EPOCH FROM (ps.last_ts - ps.first_ts)))::float8
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

-- ---------------------------------------------------------------------------
-- 2) Today MV — same inner-CEIL form. A materialised view's query can't be
--    CREATE OR REPLACE'd, so drop + recreate (with its indexes) and repopulate.
--    Identical numbers; the swap is contained in this migration.
--    The refresh_today_session_summary_mv() function references the MV by name
--    (resolved at runtime), so it survives the drop and needs no change.
-- ---------------------------------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS today_session_summary_mv;

CREATE MATERIALIZED VIEW today_session_summary_mv AS
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
                      CEIL(EXTRACT(EPOCH FROM (ps.last_ts - ps.first_ts)))::float8
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

-- Recreate the indexes the drop removed (unique index is required for the
-- CONCURRENTLY refresh the cron uses).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_today_session_summary_mv
    ON today_session_summary_mv (date, operator_id, shortcode_id);
CREATE INDEX IF NOT EXISTS idx_today_mv_operator
    ON today_session_summary_mv (operator_id);
CREATE INDEX IF NOT EXISTS idx_today_mv_shortcode
    ON today_session_summary_mv (shortcode_id);

-- Populate (non-concurrent — required after CREATE … WITH NO DATA).
REFRESH MATERIALIZED VIEW today_session_summary_mv;
