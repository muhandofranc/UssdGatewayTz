-- ----------------------------------------------------------------------
-- 008: register canonical dialed-code shortcodes for Tigo partners
-- ----------------------------------------------------------------------
-- Background
-- ----------
-- The Tigo aggregator carries the dialed USSD code on every START leg
-- in either `Ussd_string` (Scheme A) or `SHORT_CODE` (Scheme B), both
-- in canonical `*<digits>` form. Production observation:
--
--     glptigo      → *148*43       (Scheme A: Ussd_string)
--     kopagastigo  → *148*33       (Scheme B: SHORT_CODE)
--     tz411tigo    → *147*04       (Scheme B: SHORT_CODE)
--     zolatigo     → (TBD — fill in once a START leg is observed)
--
-- The gateway's adapter does a longest-prefix shortcode lookup on the
-- canonical (`*<digits>#`) form BEFORE falling back to URL-slug-based
-- routing (lib/db.py :: lookup_shortcode_by_dial_prefix). Adding the
-- rows below enables two production features for these partners:
--
--   1. "Shortcut in initial dial": a subscriber who dials
--      *148*43*0666743790# lands on the glptigo handler with
--      '0666743790' already populating ussd_string on the very
--      first leg — no need for a separate input leg.
--
--   2. Canonical routing parity with Vodacom/Halotel/Airtel: any
--      adapter that resolves a `*<digits>#` form against the
--      shortcodes table now finds this row, independent of which
--      MNO landed the request.
--
-- These rows COEXIST with the existing slug-based ones
-- (code='glptigo' etc.). The canonical prefix-match wins when it
-- succeeds; slug routing remains the fallback so traffic that
-- hits /ussd/glptigo/ keeps working even if the canonical row is
-- ever deleted.
--
-- Method
-- ------
-- INSERT…SELECT mirrors the existing slug row's metadata (owner,
-- handler_url, auth, timeouts, status) so the new canonical row
-- points at the same backend with the same permissions and the same
-- maintenance window. No owner/handler hand-fill required — if the
-- slug row exists, the canonical row inherits from it. Idempotent
-- via the (operator_id, code) UNIQUE index.

WITH mapping(slug, canonical) AS (
    VALUES
        ('glptigo',     '*148*43#'),
        ('kopagastigo', '*148*33#'),
        ('tz411tigo',   '*147*04#')
        -- ('zolatigo',  '*xxxxx#')   -- uncomment once the START leg
                                       -- dial code is captured.
)
INSERT INTO shortcodes (
    operator_id, code, label, owner_user_id, handler_url,
    auth_mode, bearer_token, timeout_secs, active,
    status, status_message
)
SELECT
    s.operator_id,
    m.canonical,
    -- Tag the label so an operator scanning the dashboard can spot
    -- canonical-vs-slug rows at a glance. Falls back to the slug
    -- row's label when one was set.
    COALESCE(s.label, m.slug) || ' (canonical)',
    s.owner_user_id,
    s.handler_url,
    s.auth_mode,
    s.bearer_token,
    s.timeout_secs,
    s.active,
    s.status,
    s.status_message
  FROM mapping m
  JOIN shortcodes s ON s.code = m.slug
  JOIN operators  o ON o.id   = s.operator_id AND o.name = 'tigo'
ON CONFLICT (operator_id, code) DO NOTHING;

-- Rollback (manual, if ever needed):
-- DELETE FROM shortcodes s
--  USING operators o
--  WHERE s.operator_id = o.id
--    AND o.name = 'tigo'
--    AND s.code IN ('*148*43#', '*148*33#', '*147*04#');
