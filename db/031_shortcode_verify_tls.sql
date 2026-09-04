-- Per-shortcode TLS verification for the handler call.
--
-- Default TRUE: every existing and every new shortcode verifies the
-- handler's certificate, which is the behaviour before this migration
-- (httpx and Node fetch both verify by default). Nothing changes until a
-- super_admin turns it off for one specific shortcode.
--
-- Why the escape hatch exists at all: a client handler is sometimes
-- fronted by an appliance still carrying its vendor's placeholder
-- certificate -- e.g. a Kong instance answering on an IP with the stock
-- self-signed `CN=localhost` cert it ships with. Verification then cannot
-- succeed no matter whose trust store you edit, because the name does not
-- match the address either. The pre-gateway PHP senders papered over
-- exactly this with `CURLOPT_SSL_VERIFYPEER => false` (see
-- /var/www/html/jubileetigo/index_patch.php).
--
-- Deliberately PER-SHORTCODE and not an env var: a global switch would
-- silently drop verification for every client to accommodate one UAT box,
-- and would outlive the reason it was set. Scoped this way the exposure
-- is one handler, it is visible in the list view, and turning it back on
-- is a one-field edit.
--
-- This IS a real reduction in security for the shortcode it is set on:
-- that handler leg becomes interceptable, and USSD legs carry MSISDNs and
-- menu selections. It is a temporary accommodation while a proper
-- certificate is obtained, not a setting to leave on.
--
-- Idempotent. Safe to re-run.

ALTER TABLE shortcodes
    ADD COLUMN IF NOT EXISTS verify_tls BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN shortcodes.verify_tls IS
    'FALSE skips TLS certificate verification on the handler call. Default TRUE. super_admin only; see db/031.';
