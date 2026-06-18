-- 012_audit_perf_and_auditor_grant.sql
--
-- Two follow-ups for the /audit page from db/011:
--
-- (1) Performance — the /audit filter dropdown groups actions by
--     prefix (e.g. "shortcode.*", "user.*", "auth.*"). With the
--     default B-tree index built for equality, a `LIKE 'shortcode.%'`
--     scan still uses sequential search. Adding a text_pattern_ops
--     index lets the planner do an index range scan for prefix LIKE.
--     Will matter once the table grows past ~50k rows.
--
-- (2) Auditor read access — extend `audit.view` from super_admin only
--     to also include the `auditor` role. Matches the user's broader
--     intent ("auditor sees all shortcodes details, users, operator
--     details, sessions, legs, overview") — the audit log fits the
--     same lens.
--
-- Idempotent — re-run safe.

-- ---------- index for LIKE 'prefix.%' filter ------------------------

CREATE INDEX IF NOT EXISTS idx_portal_audit_action_prefix
    ON portal_audit_log (action text_pattern_ops);

-- ---------- auditor grant -------------------------------------------

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r, permissions p
 WHERE r.key = 'auditor' AND p.key = 'audit.view'
ON CONFLICT DO NOTHING;
