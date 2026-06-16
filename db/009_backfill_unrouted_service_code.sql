-- Backfill the canonical TZ short code into ussd_session_logs.service_code
-- for historic rows where the column carries something other than the
-- TZ-canonical *<digits>*<digits># form.
--
-- Bug-affected rows came in two flavours pre-fix:
--   1. partner-slug adapters (Airtel / Tigo) wrote the URL slug
--      ('airtel', 'airfun', 'glptigo', …) into service_code when no
--      shortcode was registered.
--   2. canonical-form adapters (Vodacom / Halotel) wrote the FULL
--      dialed string into service_code (e.g.
--      '*148*69*255689492319#') — the registered short code is just
--      '*148*69#'; the trailing segments are the customer's menu
--      shortcut.
--
-- This migration derives the canonical TZ short code from
-- raw_request_payload['dialed_code'] (the value every adapter sets
-- on START) by taking the first 2 dial segments and re-wrapping as
-- '*<seg1>*<seg2>#'. One-segment codes (e.g. '*123#') stay as
-- '*<seg1>#'.
--
-- Safe / idempotent / narrowly scoped:
--   * only touches rows where raw_request_payload has 'dialed_code'
--     (the only place we can derive the canonical short code)
--   * only writes when the derived value DIFFERS from the column —
--     re-running the migration is a no-op after the first apply
--   * skips empty / malformed dialed_code values

DO $$
DECLARE
    n_updated bigint;
BEGIN
    WITH parsed AS (
        SELECT
            id,
            -- Strip leading '*' / trailing '#' / URL-encoded '%23' so
            -- string_to_array sees just the digit segments.
            string_to_array(
                regexp_replace(
                    replace(raw_request_payload->>'dialed_code', '%23', '#'),
                    '^\*+|#+$', '', 'g'
                ),
                '*'
            ) AS segments
          FROM ussd_session_logs
         WHERE raw_request_payload ? 'dialed_code'
           AND raw_request_payload->>'dialed_code' IS NOT NULL
           AND raw_request_payload->>'dialed_code' <> ''
    ),
    canonical AS (
        SELECT
            id,
            -- Filter out empty segments first (defensive against
            -- '*148**69#' noise), then take the first 2.
            '*' || array_to_string(
                (array_remove(segments, ''))[1:2],
                '*'
            ) || '#' AS short_code
          FROM parsed
         -- Ensure we still have at least one non-empty segment.
         WHERE array_length(array_remove(segments, ''), 1) >= 1
    ),
    updated AS (
        UPDATE ussd_session_logs l
           SET service_code = c.short_code
          FROM canonical c
         WHERE l.id = c.id
           AND l.service_code IS DISTINCT FROM c.short_code
       RETURNING l.id
    )
    SELECT count(*) INTO n_updated FROM updated;
    RAISE NOTICE
        'migration 009: backfilled % rows to canonical TZ short code',
        n_updated;
END
$$;
