-- Shortcode lifecycle status: active / maintenance / deactivated.
--
-- Pre-007: a single `shortcodes.active BOOLEAN` flag. When false, the
-- gateway resolver returned NULL → MNO got generic "Service not
-- configured". That doesn't carry an owner-authored message, and it
-- conflates "really off" with "temporarily under maintenance".
--
-- Post-007: a `status` enum with a companion `status_message` so:
--   active        → forward to handler_url (normal)
--   maintenance   → short-circuit with custom message (owner-set)
--   deactivated   → short-circuit with custom message (super-admin only)
-- Both non-active states keep the row visible to the resolver so the
-- gateway can SEE the shortcode and render the message; the
-- `WHERE active = TRUE` filter is removed in app/db.py.
--
-- Idempotent. Safe to re-run.

ALTER TABLE shortcodes
    ADD COLUMN IF NOT EXISTS status               VARCHAR(16) NOT NULL DEFAULT 'active',
    ADD COLUMN IF NOT EXISTS status_message       TEXT,
    ADD COLUMN IF NOT EXISTS status_set_by_id     INTEGER REFERENCES portal_users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS status_set_at        TIMESTAMPTZ;

-- CHECK constraint — `ADD CONSTRAINT IF NOT EXISTS` isn't supported in
-- vanilla Postgres, so guard manually.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'ck_shortcodes_status'
    ) THEN
        ALTER TABLE shortcodes
        ADD CONSTRAINT ck_shortcodes_status
        CHECK (status IN ('active', 'maintenance', 'deactivated'));
    END IF;
END$$;

-- Backfill: anything previously toggled off via `active=false` becomes
-- `deactivated`. Anything `active=true` stays `active`. We KEEP the
-- `active` column for now to avoid breaking partial deployments — a
-- follow-up migration can drop it once the dashboard is fully on `status`.
UPDATE shortcodes
   SET status = CASE WHEN active THEN 'active' ELSE 'deactivated' END,
       status_set_at = COALESCE(status_set_at, updated_at, now())
 WHERE status = 'active' AND active = FALSE
    OR status_set_at IS NULL;

-- Speeds up "show non-active shortcodes" dashboards.
CREATE INDEX IF NOT EXISTS idx_shortcodes_status_active
  ON shortcodes (status) WHERE status <> 'active';
