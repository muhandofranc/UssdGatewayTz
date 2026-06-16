-- 005 — async export queue.
--
-- Each row is one CSV export the user kicked off from /sessions or
-- /reports. The dashboard inserts with status='queued'; a dedicated
-- worker container (ussd-exports-worker) polls the queue, streams
-- the result set to a CSV in the shared /exports docker volume,
-- and flips status to 'ready' (or 'failed' with error_message).
--
-- Per-row access control is preserved across the async boundary
-- because the filter JSON includes the user's shortcode allowlist
-- at enqueue time — the worker applies it verbatim.

CREATE TABLE IF NOT EXISTS portal_exports (
    id                  BIGSERIAL PRIMARY KEY,
    user_id             INTEGER      NOT NULL REFERENCES portal_users(id),
    granularity         TEXT         NOT NULL CHECK (granularity IN ('legs', 'sessions')),
    filters             JSONB        NOT NULL,    -- url params + shortcode allowlist
    status              TEXT         NOT NULL DEFAULT 'queued'
                                     CHECK (status IN ('queued', 'running', 'ready', 'failed')),
    requested_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    started_at          TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ,
    file_path           TEXT,                       -- container-internal path
    row_count           BIGINT,
    file_size_bytes     BIGINT,
    error_message       TEXT
);

CREATE INDEX IF NOT EXISTS idx_portal_exports_user
    ON portal_exports (user_id, requested_at DESC);

-- Worker hot-path: SELECT ... WHERE status='queued' ORDER BY id
-- LIMIT 1 FOR UPDATE SKIP LOCKED — backed by this partial index.
CREATE INDEX IF NOT EXISTS idx_portal_exports_queued
    ON portal_exports (id) WHERE status = 'queued';
