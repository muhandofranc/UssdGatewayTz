-- 027_backfill_shortcode_labels.sql
--
-- Rewrite every existing shortcode label into the generated form
-- `Owner · Code · Network`.
--
-- Context: labels used to be free text an admin typed, so the table
-- carries whatever people wrote over the years — "Vodacom smoke",
-- "Airtel GLP smoke", NULL. The dashboard now DERIVES the label on every
-- write (dashboard/src/lib/shortcodes.ts buildShortcodeLabel) and the
-- form field is read-only, but a derived value only lands when a row is
-- next saved. Without this backfill, reports grouped by label would keep
-- splitting one estate across two naming schemes indefinitely.
--
-- The format, mirroring buildShortcodeLabel exactly:
--   production →  'Acme Ltd · *123# · Vodacom Tanzania'
--   sandbox    →  'Acme Ltd · *123# · SANDBOX'
-- Owner name falls back to the login e-mail when `name` is blank; empty
-- parts are dropped rather than leaving a dangling separator; and when
-- the whole thing would exceed label's VARCHAR(120), the OWNER is
-- clipped with an ellipsis so the code and network — the two parts that
-- identify the shortcode — always survive.
--
-- Shipped as a FUNCTION plus a one-time call, not a bare UPDATE: labels
-- also drift when a portal user is renamed or a shortcode changes hands,
-- and this gives an operator a way to put that right without waiting for
-- each shortcode to be saved:
--     SELECT regenerate_shortcode_labels();
--
-- `updated_at` is deliberately left alone. This is a cosmetic
-- normalisation, not a configuration change, and moving the timestamp
-- would make every shortcode look freshly edited in the admin list.
--
-- Idempotent: the UPDATE only touches rows whose label differs from the
-- generated value, so re-running returns 0.

CREATE OR REPLACE FUNCTION regenerate_shortcode_labels()
RETURNS int
LANGUAGE plpgsql
AS $$
DECLARE
    updated int;
BEGIN
    WITH parts AS (
        SELECT s.id,
               -- Same fallback as labelPartsFor(): a user with a blank
               -- name is identified by the address they log in with.
               COALESCE(NULLIF(BTRIM(u.name), ''), u.email) AS owner_name,
               BTRIM(s.code)                                AS code,
               CASE WHEN s.environment = 'sandbox'
                    THEN 'SANDBOX'
                    -- Sandbox carries no network because it never
                    -- reaches one; the real operator is chosen at
                    -- promotion.
                    ELSE BTRIM(COALESCE(o.display_name, ''))
               END                                          AS network
          FROM shortcodes s
          JOIN portal_users u ON u.id = s.owner_user_id
          JOIN operators    o ON o.id = s.operator_id
    ),
    budgeted AS (
        SELECT p.*,
               -- What's left of the 120 chars once the code, the network
               -- and their ' · ' separators (3 chars each) are reserved.
               120
                 - CASE WHEN char_length(p.code)    > 0 THEN char_length(p.code)    + 3 ELSE 0 END
                 - CASE WHEN char_length(p.network) > 0 THEN char_length(p.network) + 3 ELSE 0 END
                 AS budget
          FROM parts p
    ),
    clipped AS (
        SELECT b.id, b.code, b.network,
               CASE
                 WHEN char_length(b.owner_name) <= b.budget THEN b.owner_name
                 WHEN b.budget > 1 THEN LEFT(b.owner_name, b.budget - 1) || U&'\2026'
                 ELSE ''
               END AS owner_name
          FROM budgeted b
    ),
    final AS (
        -- concat_ws skips NULLs, which is how the empty parts get
        -- dropped without leaving a leading or doubled separator.
        SELECT c.id,
               concat_ws(U&' \00B7 ',
                         NULLIF(c.owner_name, ''),
                         NULLIF(c.code, ''),
                         NULLIF(c.network, '')) AS label
          FROM clipped c
    )
    UPDATE shortcodes t
       SET label = f.label
      FROM final f
     WHERE t.id = f.id
       AND t.label IS DISTINCT FROM f.label;

    GET DIAGNOSTICS updated = ROW_COUNT;
    RETURN updated;
END;
$$;

COMMENT ON FUNCTION regenerate_shortcode_labels() IS
    'Rewrites shortcodes.label to the generated Owner · Code · Network '
    'form (mirrors buildShortcodeLabel in the dashboard). Safe to re-run; '
    'returns the number of rows changed. Useful after a portal user is '
    'renamed, which the per-write generation alone will not pick up.';

-- The one-time backfill.
DO $$
DECLARE n int;
BEGIN
    SELECT regenerate_shortcode_labels() INTO n;
    RAISE NOTICE 'shortcode labels regenerated: %', n;
END $$;
