-- 034_password_reset.sql
--
-- Self-service password reset by email, and signing out a user's other
-- sessions when their password changes.
--
-- 1. portal_users.password_version — bumped on EVERY password change:
--    the user's own change (/account), an admin reset (/users), and a
--    reset link. Each session JWT carries the version it was minted
--    under (claim `pwv`); dashboard/src/lib/auth.ts getSession() rejects
--    a session whose version no longer matches, or whose user is no
--    longer active. That is what makes a password change sign out every
--    OTHER device: sessions are otherwise stateless and live for 8h.
--    Sessions minted before this column existed carry no `pwv` and are
--    treated as version 0, so deploying this logs nobody out.
--
-- 2. password_reset_tokens — one row per emailed reset link. Only the
--    SHA-256 of the token is stored: the token itself exists only in the
--    email, so a read of this table (backup, replica, support query)
--    cannot be replayed into a reset. Single use (used_at), 30-minute
--    expiry set by the dashboard, and a new request or a completed reset
--    retires the user's other outstanding links. The dashboard deletes
--    rows a day past expiry as it goes; no scheduler job.
--
-- Idempotent: safe to re-run.

ALTER TABLE portal_users
    ADD COLUMN IF NOT EXISTS password_version INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id              BIGSERIAL PRIMARY KEY,
    portal_user_id  INTEGER NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
    token_hash      CHAR(64) NOT NULL UNIQUE,          -- sha256 hex of the emailed token
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL,
    used_at         TIMESTAMPTZ,                       -- set on use OR when superseded
    requested_ip    TEXT
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user
    ON password_reset_tokens (portal_user_id);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_expires
    ON password_reset_tokens (expires_at);
