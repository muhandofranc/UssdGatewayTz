-- One row per LIVE USSD session — opened on the first leg (type=1
-- for Vodacom/TruRoute; equivalent "new session" on other MNOs) and
-- expired on any terminal event (RELEASE / TIMEOUT / CHARGE-failure
-- / handler END reply).
--
-- Purpose: most MNO USSD wire protocols only carry the dialed
-- service_code on the FIRST leg of a session. Subsequent legs carry
-- just the user's most-recent input. To route by service_code on
-- every leg we have to remember it for the duration of the session.
-- We also accumulate ussd_string here so handlers see the menu trail.
--
-- This table is HOT — read+upsert on every USSD leg. Keep it small:
--   * sweeper deletes rows older than 10 minutes (a USSD session
--     that hasn't seen activity in 10 min is dead by definition;
--     gateway TTLs vary 30-120s in practice).
--   * we never JOIN this table from the dashboard; it's pure
--     in-flight session state.

CREATE TABLE IF NOT EXISTS ussd_active_sessions (
    session_id      VARCHAR(128) NOT NULL,
    operator_id     SMALLINT     NOT NULL REFERENCES operators(id),
    service_code    VARCHAR(64)  NOT NULL,
    shortcode_id    INTEGER      REFERENCES shortcodes(id),  -- resolved on first leg, cached
    msisdn          VARCHAR(20),
    ussd_string     TEXT         NOT NULL DEFAULT '',         -- accumulated menu trail
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    last_seen_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, operator_id)
);

CREATE INDEX IF NOT EXISTS idx_active_sessions_last_seen
    ON ussd_active_sessions (last_seen_at);

-- Cleanup helper — run periodically (cron / Phase 4 sweeper):
--   DELETE FROM ussd_active_sessions WHERE last_seen_at < now() - interval '10 minutes';
