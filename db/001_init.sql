-- UssdGatewayTz — Phase 1 schema.
--
-- Apply once into an empty database (or via the bundled `app.db_init`
-- helper which executes this file idempotently). External Postgres
-- ≥ 13 expected.
--
-- Splits:
--   * Gateway core:       operators, shortcodes, ussd_session_logs
--   * Dashboard (auth):   portal_users, roles, permissions,
--                         role_permissions, portal_audit_log
--   * Allocation:         portal_user_shortcodes  (a portal user can
--                         own MANY shortcodes; one shortcode has
--                         exactly one owner — owner_user_id on
--                         shortcodes. The junction table is included
--                         as scaffolding for the day we want
--                         many-to-many (e.g. a "viewer" role per
--                         shortcode separate from "owner"). Phase 1
--                         queries don't use it yet.)

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------- operators ------------------------------------------------
-- Tanzania MNO catalogue. `name` is the canonical lowercase key the
-- route module routes by (e.g. /ussd/<name>). `display_name` is what
-- the dashboard shows. Seeded with the four MNOs we know.

CREATE TABLE IF NOT EXISTS operators (
    id              SMALLSERIAL PRIMARY KEY,
    name            VARCHAR(32)  NOT NULL UNIQUE,
    display_name    VARCHAR(64)  NOT NULL,
    active          BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Sequence-safe idempotent seed. NOTE: `INSERT ... VALUES ... ON
-- CONFLICT DO NOTHING` still evaluates the SMALLSERIAL DEFAULT
-- (nextval) for every candidate row BEFORE detecting the conflict, so
-- re-running it each boot burns id-sequence values even when nothing is
-- inserted — which eventually exhausts SMALLINT (32767). The SELECT ...
-- WHERE NOT EXISTS form only produces rows that are genuinely new, so
-- nextval fires only for real inserts and never on a no-op re-run.
INSERT INTO operators (name, display_name)
SELECT v.name, v.display_name
FROM (VALUES
    ('vodacom', 'Vodacom Tanzania'),
    ('airtel',  'Airtel Tanzania'),
    ('tigo',    'Tigo (Yas) Tanzania'),
    ('halotel', 'Halotel Tanzania')
) AS v(name, display_name)
WHERE NOT EXISTS (SELECT 1 FROM operators o WHERE o.name = v.name);

-- ---------- portal_users + RBAC -------------------------------------
-- Same shape as the jubileeTzUssd dashboard so the auth/CSRF/rate-
-- limit code transplants cleanly into the dashboard service.

CREATE TABLE IF NOT EXISTS roles (
    id      SMALLSERIAL PRIMARY KEY,
    key     VARCHAR(32) NOT NULL UNIQUE,        -- 'super_admin' | 'client'
    label   VARCHAR(80) NOT NULL
);

-- Sequence-safe idempotent seed (see the operators note above).
INSERT INTO roles (key, label)
SELECT v.key, v.label
FROM (VALUES
    ('super_admin', 'Super Admin'),
    ('client',      'Shortcode Owner / Client')
) AS v(key, label)
WHERE NOT EXISTS (SELECT 1 FROM roles r WHERE r.key = v.key);

CREATE TABLE IF NOT EXISTS permissions (
    id      SMALLSERIAL PRIMARY KEY,
    key     VARCHAR(64) NOT NULL UNIQUE,
    label   VARCHAR(120) NOT NULL
);

-- Permission catalogue (extend per dashboard feature):
--   reports.view_own     — see sessions only for shortcodes I own
--   reports.view_all     — see every shortcode's sessions (super admin)
--   shortcodes.manage    — create/edit shortcodes (super admin)
--   portal_users.manage  — create/edit dashboard users (super admin)
-- Sequence-safe idempotent seed (see the operators note above).
INSERT INTO permissions (key, label)
SELECT v.key, v.label
FROM (VALUES
    ('reports.view_own',    'View own shortcodes report'),
    ('reports.view_all',    'View ALL shortcodes report'),
    ('shortcodes.manage',   'Manage shortcodes (CRUD)'),
    ('portal_users.manage', 'Manage dashboard users (CRUD)')
) AS v(key, label)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.key = v.key);

CREATE TABLE IF NOT EXISTS role_permissions (
    role_id        SMALLINT NOT NULL REFERENCES roles(id)       ON DELETE CASCADE,
    permission_id  SMALLINT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_id)
);

-- Seed: super_admin → everything; client → only their own reports.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r CROSS JOIN permissions p
 WHERE r.key = 'super_admin'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r, permissions p
 WHERE r.key = 'client' AND p.key = 'reports.view_own'
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS portal_users (
    id              SERIAL PRIMARY KEY,
    email           VARCHAR(255) NOT NULL UNIQUE,
    name            VARCHAR(150) NOT NULL,
    phone           VARCHAR(32),                       -- for OTP (Phase 3)
    password_hash   VARCHAR(255) NOT NULL,             -- bcrypt
    role_id         SMALLINT NOT NULL REFERENCES roles(id),
    active          BOOLEAN  NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_portal_users_email ON portal_users (email);

-- ---------- shortcodes (routing config) -----------------------------
-- The reseller routing table. Lookup key = (operator_id, code).
-- handler_url is where the gateway POSTs the unified request when
-- this shortcode is dialed. auth_mode controls outbound auth:
--   * 'none'   — open POST (handler trusts VPN / internal network)
--   * 'bearer' — gateway sends Authorization: Bearer <bearer_token>
--
-- bearer_token is nullable (only required when auth_mode='bearer').
-- Stored in plaintext for now; rotate by UPDATE + restart of any
-- handler that verifies the token.

CREATE TABLE IF NOT EXISTS shortcodes (
    id              SERIAL PRIMARY KEY,
    operator_id     SMALLINT     NOT NULL REFERENCES operators(id),
    code            VARCHAR(32)  NOT NULL,             -- e.g. '*123#'
    label           VARCHAR(120),                       -- friendly name
    owner_user_id   INTEGER      NOT NULL REFERENCES portal_users(id),
    handler_url     TEXT         NOT NULL,
    auth_mode       VARCHAR(16)  NOT NULL DEFAULT 'none',
    bearer_token    TEXT,
    timeout_secs    SMALLINT     NOT NULL DEFAULT 5,   -- handler timeout
    active          BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    UNIQUE (operator_id, code),
    CHECK (auth_mode IN ('none', 'bearer'))
);

CREATE INDEX IF NOT EXISTS idx_shortcodes_owner_user ON shortcodes (owner_user_id);

-- Future-use junction (Phase 2+): when a shortcode has both an owner
-- and additional view-only collaborators, the dashboard's per-user
-- reports filter unions over (shortcodes.owner_user_id = me) OR
-- ((shortcode_id, portal_user_id) IN portal_user_shortcodes).
CREATE TABLE IF NOT EXISTS portal_user_shortcodes (
    portal_user_id  INTEGER NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
    shortcode_id    INTEGER NOT NULL REFERENCES shortcodes(id)    ON DELETE CASCADE,
    access_level    VARCHAR(16) NOT NULL DEFAULT 'view',
    granted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (portal_user_id, shortcode_id),
    CHECK (access_level IN ('view', 'edit'))
);

-- ---------- ussd_session_logs (the hot path) ------------------------
-- One row per HTTP leg (every MNO callback during a live USSD
-- interaction = 1 row). `ts` has microsecond precision — the
-- dashboard's Vodacom-20s billable-session computation depends on it
-- (`OVER (PARTITION BY session_id ORDER BY ts)` with a 20s window
-- function).
--
-- raw_payload is JSONB so we can index/query inside it later (GIN
-- index deferred to Phase 4 when log volume justifies it).
--
-- Phase 1 ships this as a regular table; Phase 4 will convert it to
-- a partitioned-by-month table (PARTITION BY RANGE (ts)) for cheap
-- retention drops and faster reports.

CREATE TABLE IF NOT EXISTS ussd_session_logs (
    id                       BIGSERIAL PRIMARY KEY,
    ts                       TIMESTAMPTZ  NOT NULL DEFAULT clock_timestamp(),
    operator_id              SMALLINT     NOT NULL REFERENCES operators(id),
    operator_name            VARCHAR(32)  NOT NULL,             -- denormalised
    shortcode_id             INTEGER      REFERENCES shortcodes(id),
    service_code             VARCHAR(64),                       -- '*123#'
    session_id               VARCHAR(128) NOT NULL,             -- MNO session id
    msisdn                   VARCHAR(20),
    ussd_string              TEXT,                              -- menu trail / user input
    direction                VARCHAR(16)  NOT NULL,             -- 'inbound' | 'response'
    raw_request_payload      JSONB,                              -- what the MNO sent
    raw_response_payload     JSONB,                              -- what we returned to the MNO
    handler_url              TEXT,                              -- forwarded to
    handler_status_code      SMALLINT,                          -- HTTP status from handler
    handler_response_action  VARCHAR(8),                        -- 'CON' | 'END'
    handler_response_text    TEXT,                              -- parsed message body
    handler_elapsed_ms       INTEGER,                           -- handler round-trip
    error_class              VARCHAR(32),                       -- nullable: 'shortcode_not_found' / 'handler_timeout' / etc.
    error_detail             TEXT,
    -- 'inbound'  — what the MNO POSTed at us (sync ack path).
    -- 'response' — what we returned synchronously on the inbound HTTP
    --              (sync MNOs: Vodacom, Airtel, Tigo).
    -- 'async_outbound' — async MNOs (Halotel) emit the menu body on a
    --              separate outbound POST AFTER acking the inbound;
    --              that POST is logged with this direction.
    -- The 'async_outbound' value was added in db/017 — when restoring
    -- from this file alone, you get the wider constraint up front.
    CHECK (direction IN ('inbound', 'response', 'async_outbound'))
);

CREATE INDEX IF NOT EXISTS idx_ussd_logs_ts             ON ussd_session_logs (ts);
CREATE INDEX IF NOT EXISTS idx_ussd_logs_session        ON ussd_session_logs (session_id, ts);
CREATE INDEX IF NOT EXISTS idx_ussd_logs_operator_ts    ON ussd_session_logs (operator_id, ts);
CREATE INDEX IF NOT EXISTS idx_ussd_logs_shortcode_ts   ON ussd_session_logs (shortcode_id, ts);
CREATE INDEX IF NOT EXISTS idx_ussd_logs_msisdn_ts      ON ussd_session_logs (msisdn, ts);

-- ---------- portal_audit_log (Phase 3 dashboard auth) ----------------
-- Mirror of the jubileeTzUssd dashboard's append-only audit trail
-- so the auth/RBAC code transplants without changes.

CREATE TABLE IF NOT EXISTS portal_audit_log (
    id          SERIAL PRIMARY KEY,
    ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
    actor       VARCHAR(255),
    actor_kind  VARCHAR(20),                  -- 'portal' | 'unknown'
    action      VARCHAR(80) NOT NULL,
    target      VARCHAR(255),
    outcome     VARCHAR(16) NOT NULL,         -- 'success' | 'failure' | 'denied'
    ip          VARCHAR(64),
    user_agent  TEXT,
    detail      JSONB
);

CREATE INDEX IF NOT EXISTS idx_portal_audit_ts      ON portal_audit_log (ts);
CREATE INDEX IF NOT EXISTS idx_portal_audit_actor   ON portal_audit_log (actor);
CREATE INDEX IF NOT EXISTS idx_portal_audit_action  ON portal_audit_log (action);
CREATE INDEX IF NOT EXISTS idx_portal_audit_outcome ON portal_audit_log (outcome);
