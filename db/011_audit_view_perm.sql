-- 011_audit_view_perm.sql
--
-- Adds a `audit.view` permission and grants it to super_admin only.
-- Backs the new /audit page on the dashboard, which exposes the
-- portal_audit_log table (logins, password resets, shortcode + user
-- + viewer + operator + export CRUD) for review.
--
-- Idempotent.

INSERT INTO permissions (key, label) VALUES
    ('audit.view', 'View the portal audit log (read-only)')
ON CONFLICT (key) DO NOTHING;

-- super_admin gets it via the same CROSS JOIN pattern 001 + 010 used.
-- (auditor is INTENTIONALLY not granted audit.view by default — being
-- able to read every login + every action of every user is a much
-- stronger lens than "read-only on business data". If you want an
-- auditor to see it later, add a one-line INSERT here.)
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r CROSS JOIN permissions p
 WHERE r.key = 'super_admin'
ON CONFLICT DO NOTHING;
