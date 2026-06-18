-- 010_roles_auditor_viewer.sql
--
-- Adds two new roles + four new permissions to support the
-- portal RBAC hierarchy the dashboard now exposes:
--
--   super_admin    (existing)  sees and manages everything
--   auditor        (NEW)       read-only across the WHOLE platform —
--                              every shortcode, every operator, every
--                              portal user, every session/leg/export
--   client         (existing)  shortcode owner ("Admin") — sees own
--                              shortcodes' sessions; can now also
--                              create read-only viewers for their own
--                              shortcodes (viewers.manage_own)
--   client_viewer  (NEW)       read-only on a curated subset of
--                              shortcodes; scope is junction-driven
--                              (portal_user_shortcodes), granted by a
--                              client/Admin
--
-- Idempotent — re-run safe (every INSERT uses ON CONFLICT DO NOTHING).

-- ---------- new permissions ----------------------------------------
-- Splitting the existing single-perm-per-page model into
-- view / manage so an auditor can reach a listing page WITHOUT
-- inheriting the write surface that 'shortcodes.manage' implies.
-- Existing perms (reports.view_*, *.manage) are unchanged; the new
-- *.view perms layer on top and are accepted by the same routes via
-- the OR-of-perms predicate in rbac.ts.

INSERT INTO permissions (key, label) VALUES
    ('shortcodes.view',    'View shortcodes (read-only)'),
    ('operators.view',     'View operators (read-only)'),
    ('portal_users.view',  'View portal users (read-only)'),
    ('viewers.manage_own', 'Create/manage read-only viewers for own shortcodes')
ON CONFLICT (key) DO NOTHING;

-- ---------- new roles ----------------------------------------------

INSERT INTO roles (key, label) VALUES
    ('auditor',       'Auditor (read-only, all shortcodes)'),
    ('client_viewer', 'Viewer (read-only, granted shortcodes only)')
ON CONFLICT (key) DO NOTHING;

-- ---------- role → permission grants -------------------------------

-- super_admin inherits the new perms via the same CROSS JOIN that
-- granted it everything in 001_init.sql. Re-running is harmless.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r CROSS JOIN permissions p
 WHERE r.key = 'super_admin'
ON CONFLICT DO NOTHING;

-- auditor: read-only on every admin surface + global reports.
-- NOTE: no write perms; the dashboard's POST/PATCH/DELETE handlers
-- enforce that separately so the UI can render the same listing
-- pages without enabling mutations.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r, permissions p
 WHERE r.key = 'auditor'
   AND p.key IN (
        'reports.view_all',
        'shortcodes.view',
        'operators.view',
        'portal_users.view'
   )
ON CONFLICT DO NOTHING;

-- client_viewer: only reports.view_own. The shortcode allowlist is
-- materialised at login from portal_user_shortcodes (already UNIONed
-- in dashboard/src/lib/auth.ts), so granting access is purely a
-- junction-row insert by the owning Admin — no extra perms needed.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r, permissions p
 WHERE r.key = 'client_viewer' AND p.key = 'reports.view_own'
ON CONFLICT DO NOTHING;

-- client (Admin): gains viewers.manage_own. Keeps their existing
-- reports.view_own grant from 001_init.sql.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r, permissions p
 WHERE r.key = 'client' AND p.key = 'viewers.manage_own'
ON CONFLICT DO NOTHING;
