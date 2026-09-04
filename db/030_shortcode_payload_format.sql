-- Per-shortcode handler payload format: 'gateway' (default) | 'legacy'.
--
-- Pre-030 every handler received the unified snake_case body:
--     {operator, msisdn, session_id, service_code, ussd_string,
--      event, raw_payload}
--
-- Clients migrating off the pre-gateway PHP stack already have handlers
-- built against the shape their old aggregator-direct integration sent,
-- and rewriting those handlers is not always on their critical path.
-- Rather than make every such client change code to move behind the
-- gateway, a shortcode can now ask for the legacy body instead:
--     {sessionId, msisdn, networkProvider, serviceCode, UssdString}
-- (still POSTed as application/json; reply is the same CON/END text).
--
-- `networkProvider` is derived, not stored: uppercase(operators.name), so
-- vodacom -> VODACOM, airtel -> AIRTEL, tigo -> TIGO, halotel -> HALOTEL.
-- Tigo's rebrand to Yas is a rename of the same operator, not a second
-- one, so it stays under the gateway's canonical `tigo` (db/001_init.sql,
-- display "Tigo (Yas) Tanzania"). If the wire value ever needs to become
-- YAS it is an operator rename in one place -- never a per-shortcode
-- setting, which would let two shortcodes on one network disagree.
--
-- The key names are NOT stylistic choices -- they are the wire contract
-- those handlers already parse, capital U in `UssdString` included. See
-- /var/www/html/{jubileetigo,jubileeair,karata3voda}/index_patch.php for
-- the senders this reproduces.
--
-- DEFAULT 'gateway' is the important half of this migration: every
-- existing row and every newly-created shortcode keeps the unified body,
-- so nothing changes for anyone until a super_admin opts a specific
-- shortcode in. Only `shortcodes.manage` (super_admin) can set it --
-- the owner-facing /my-shortcodes form never writes this column.
--
-- Idempotent. Safe to re-run.

ALTER TABLE shortcodes
    ADD COLUMN IF NOT EXISTS payload_format VARCHAR(16) NOT NULL DEFAULT 'gateway';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'ck_shortcodes_payload_format'
    ) THEN
        ALTER TABLE shortcodes
        ADD CONSTRAINT ck_shortcodes_payload_format
        CHECK (payload_format IN ('gateway', 'legacy'));
    END IF;
END$$;

COMMENT ON COLUMN shortcodes.payload_format IS
    'Body shape POSTed to handler_url: gateway (unified snake_case) | legacy (pre-gateway sessionId/UssdString shape).';
