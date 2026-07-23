-- Backfill ussd_session_logs.shortcode_id for historic rows left NULL on
-- legs the pipeline short-circuits BEFORE resolve_shortcode() runs:
--   * terminal events (user-cancelled / timeout / charge-failed)
--   * delivery-ack (Halotel type=103)
--   * auth-failed (dormant per-shortcode auth path)
--
-- These legs recover service_code from the session cache (prior.service_code
-- = the canonical matched code, e.g. '*147*03#') but never carried the
-- shortcode_id, so the row logged NULL. The daily rollup then folds NULL
-- into a synthetic shortcode_id = 0 bucket (COALESCE(shortcode_id, 0) in
-- refresh_daily_session_summary, db/015), which conflates these
-- attributable legs with genuinely-unrouted traffic.
--
-- This migration attributes each NULL leg to its shortcode using the same
-- match resolve_shortcode() uses at request time: exact (operator_id, code).
--
-- Safe / idempotent / narrowly scoped:
--   * shortcodes UNIQUE (operator_id, code) => at most one match per row
--   * guarded by shortcode_id IS NULL => re-running is a no-op
--   * do NOT filter on active/status: resolve_shortcode() ignores them, so
--     matching them here keeps attribution faithful (maintenance/deactivated
--     shortcodes still owned their traffic)
--   * EXCLUDE error_class = 'shortcode_not_found' rows. Those legs were
--     genuinely unroutable AT LOG TIME (no shortcode registered for the
--     dialed code then). If the same code was registered LATER, an exact
--     (operator_id, code) join would now match and retroactively attribute
--     that traffic to a service that wasn't live yet -- and leave a row that
--     both carries a shortcode_id AND says error_class='shortcode_not_found'.
--     Skipping them keeps history honest; they stay NULL -> the 0 bucket.
--     The attributable legs we DO want never carry this marker: terminal
--     events + delivery-ack log error_class = NULL, auth-failed logs
--     'auth_failed'.
--
-- After the backfill we reconcile daily_session_summary across the retained
-- 90-day window so historical days reflect the corrected attribution. The
-- today materialized view self-heals on the next intraday scheduler tick
-- (its REFRESH ... CONCURRENTLY cannot run inside this migration's txn).

DO $$
DECLARE
    n_updated bigint;
BEGIN
    UPDATE ussd_session_logs l
       SET shortcode_id = s.id
      FROM shortcodes s
     WHERE l.shortcode_id IS NULL
       AND l.error_class IS DISTINCT FROM 'shortcode_not_found'
       AND s.operator_id = l.operator_id
       AND s.code        = l.service_code;

    GET DIAGNOSTICS n_updated = ROW_COUNT;
    RAISE NOTICE
        'migration 022: backfilled shortcode_id on % session-log row(s)',
        n_updated;
END
$$;

-- Rebuild the historical rollup from the corrected live table. Idempotent
-- (DELETE-then-reinsert per day); collapses the inflated 0 rows into correct
-- per-shortcode rows plus a residual genuine-unrouted 0 row.
SELECT refresh_daily_session_summary(
    (CURRENT_DATE - INTERVAL '90 day')::date,
    (CURRENT_DATE - INTERVAL '1 day')::date
);
