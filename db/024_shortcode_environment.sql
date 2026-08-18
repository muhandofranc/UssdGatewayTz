-- Shortcode environment: sandbox / production.
--
-- Pre-024: every shortcode was implicitly production — the moment a row
-- existed, `resolve_shortcode` (app/db.py) would route live MNO traffic
-- to it. There was no way for a tester to try a handler without a
-- super_admin provisioning a live, routable shortcode.
--
-- Post-024: shortcodes carry an `environment`:
--   production → routable by the gateway (unchanged behaviour)
--   sandbox    → testable ONLY via the portal simulator; the gateway
--                resolver filters it out, so it can NEVER take live
--                traffic even if it shares an (operator, code) with a
--                production shortcode.
-- The routing uniqueness therefore moves from (operator_id, code) to
-- (operator_id, code, environment) so the same code can exist in both.
--
-- Clients self-serve sandbox shortcodes via a new `shortcodes.manage_sandbox`
-- permission; promotion to production is a super_admin-approved clone.
--
-- Idempotent. Safe to re-run.

-- 1. Column. Default 'production' so EVERY existing row stays live and
--    routing is unchanged immediately after this migration.
ALTER TABLE shortcodes
    ADD COLUMN IF NOT EXISTS environment VARCHAR(16) NOT NULL DEFAULT 'production';

-- CHECK constraint — `ADD CONSTRAINT IF NOT EXISTS` isn't supported, guard it.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'ck_shortcodes_environment'
    ) THEN
        ALTER TABLE shortcodes
        ADD CONSTRAINT ck_shortcodes_environment
        CHECK (environment IN ('sandbox', 'production'));
    END IF;
END$$;

-- 2. Swap the routing uniqueness key: drop the old 2-column UNIQUE
--    (operator_id, code) — robustly, by inspecting pg_constraint rather
--    than trusting the auto-generated name — then add the 3-column one.
DO $$
DECLARE
    r record;
    twocols int2[];
BEGIN
    SELECT array_agg(attnum) INTO twocols
      FROM pg_attribute
     WHERE attrelid = 'shortcodes'::regclass
       AND attname IN ('operator_id', 'code');

    FOR r IN
        SELECT conname
          FROM pg_constraint
         WHERE conrelid = 'shortcodes'::regclass
           AND contype  = 'u'
           AND array_length(conkey, 1) = 2
           AND conkey @> twocols AND conkey <@ twocols   -- exactly {operator_id, code}
    LOOP
        EXECUTE format('ALTER TABLE shortcodes DROP CONSTRAINT %I', r.conname);
    END LOOP;
END$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'uq_shortcodes_op_code_env'
    ) THEN
        ALTER TABLE shortcodes
        ADD CONSTRAINT uq_shortcodes_op_code_env
        UNIQUE (operator_id, code, environment);
    END IF;
END$$;

-- 3. Permission + grants. (001's CROSS JOIN only ran at initial seed, so a
--    perm added now must be granted to super_admin explicitly too.)
INSERT INTO permissions (key, label)
SELECT v.key, v.label
FROM (VALUES
    ('shortcodes.manage_sandbox', 'Manage OWN sandbox shortcodes')
) AS v(key, label)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.key = v.key);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r, permissions p
 WHERE r.key IN ('super_admin', 'client')
   AND p.key = 'shortcodes.manage_sandbox'
ON CONFLICT DO NOTHING;
