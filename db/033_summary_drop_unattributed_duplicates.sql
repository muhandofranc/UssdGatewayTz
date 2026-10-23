-- 033_summary_drop_unattributed_duplicates.sql
--
-- Stop the session rollups counting one session twice. Rebuilds only
-- the CURRENT month (not yet billed, see step 3). Days of earlier
-- months have been billed and stay exactly as they are.
--
-- Both rollups (refresh_daily_session_summary, db/023, and
-- today_session_summary_mv) count one session per
-- (day, operator, COALESCE(shortcode_id, 0), session_id). A session
-- whose legs disagree on shortcode_id therefore counts once under its
-- shortcode and AGAIN under the synthetic 0 bucket -- and since a
-- 0-second session still bills GREATEST(1, ...) = 1 unit, the
-- duplicate adds a billable unit too.
--
-- That happens whenever a network notice arrives after the gateway has
-- already dropped the session from ussd_active_sessions (the handler's
-- END, the shortcode_not_found path, or the idle sweeper). The adapter
-- finds no cached session, so the notice is logged with
-- shortcode_id NULL and service_code '' -- and db/022's
-- (operator_id, service_code) backfill cannot recover it either.
-- Vodacom (cancel) and Halotel (timeout) send such notices; Airtel and
-- Tigo don't, which is why only those two were inflated.
--
-- Measured on production for September 2026 (sessions in the summary
-- vs distinct session ids in ussd_session_logs):
--
--     operator   summary     distinct ids   split sessions
--     vodacom    871,038       721,995        148,601 (user_cancelled)
--     halotel    226,606       174,908         51,688 (timeout)
--     airtel     819,672       819,549         (midnight crossings only)
--     tigo     1,148,204     1,147,761         (midnight crossings only)
--
-- October 2026, 1st-22nd (the month step 3 rebuilds), duplicates this
-- fix drops: vodacom 9,893 (2.6% of the summary), halotel 11,371
-- (9.9%), tigo 886 (0.1%), airtel 118 (0.0%). Far fewer than September,
-- most likely because the idle sweeper (db/032) now waits past
-- Vodacom's 60s cut-off, so its cancel usually finds the cached session.
--
-- The fix drops a session's 0-bucket group when the same
-- (day, operator, session_id) also has an attributed group. Every
-- per-shortcode number -- sessions, legs, errors, billable_units -- is
-- unchanged. Only the 0 bucket shrinks, and with it the per-network
-- totals. Sessions that never resolved a shortcode (genuinely unrouted
-- traffic) keep their 0 row as before.
--
-- Deliberately NOT done: folding the stray notice into its session.
-- That would stretch the session's first-to-last span up to the late
-- notice and change billable_units on the owner's shortcode.
--
-- NOTE: a manual refresh_daily_session_summary() over a day of an
-- already-billed month would now recount it the new way -- don't,
-- unless that is intended.

-- ---------------------------------------------------------------------------
-- 1) Daily rollup function.
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

    WITH per_group AS (
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
    ),
    per_session AS (
        SELECT pg.*,
               BOOL_OR(pg.shortcode_id <> 0)
                   OVER (PARTITION BY pg.d, pg.operator_id, pg.session_id) AS attributed
          FROM per_group pg
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
     -- A 0 group is a duplicate when the session is attributed elsewhere.
     WHERE ps.shortcode_id <> 0 OR NOT ps.attributed
     GROUP BY 1, 2, 3;

    GET DIAGNOSTICS inserted = ROW_COUNT;
    RETURN inserted;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2) Today MV -- same filter. Drop + recreate as db/023 does; the
--    refresh_today_session_summary_mv() function resolves the MV by name
--    at runtime and needs no change. Today is not billed yet, so
--    repopulating it here is not a rebuild of billed data.
-- ---------------------------------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS today_session_summary_mv;

CREATE MATERIALIZED VIEW today_session_summary_mv AS
WITH per_group AS (
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
),
per_session AS (
    SELECT pg.*,
           BOOL_OR(pg.shortcode_id <> 0)
               OVER (PARTITION BY pg.date, pg.operator_id, pg.session_id) AS attributed
      FROM per_group pg
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
 WHERE ps.shortcode_id <> 0 OR NOT ps.attributed
 GROUP BY 1, 2, 3
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_today_session_summary_mv
    ON today_session_summary_mv (date, operator_id, shortcode_id);
CREATE INDEX IF NOT EXISTS idx_today_mv_operator
    ON today_session_summary_mv (operator_id);
CREATE INDEX IF NOT EXISTS idx_today_mv_shortcode
    ON today_session_summary_mv (shortcode_id);

REFRESH MATERIALIZED VIEW today_session_summary_mv;

-- ---------------------------------------------------------------------------
-- 3) Rebuild the current month, 1st to yesterday -- it has not been
--    billed yet. "Current" is the month this migration RUNS in, so a
--    deploy that slips into the next month leaves the previous month
--    (by then billed) alone. On the 1st there is nothing to rebuild.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    month_start date := date_trunc('month', CURRENT_DATE)::date;
BEGIN
    IF CURRENT_DATE > month_start THEN
        PERFORM refresh_daily_session_summary(month_start, CURRENT_DATE - 1);
        RAISE NOTICE 'migration 033: rebuilt daily_session_summary % to %',
            month_start, CURRENT_DATE - 1;
    END IF;
END
$$;
