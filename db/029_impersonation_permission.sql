-- 029_impersonation_permission.sql
--
-- `portal_users.impersonate` — view the dashboard as another portal
-- user, read-only. Granted to super_admin and auditor.
--
-- What it is for: the support question "this client says they can't see
-- their sessions" is answered in seconds by looking through their eyes,
-- and not at all by reading their row in portal_users. The alternative
-- people reach for otherwise — asking for the client's password, or
-- resetting it — is far worse than a first-class, audited feature.
--
-- Two properties the implementation guarantees (dashboard/src/lib/auth.ts
-- impersonatedClaims + middleware.ts):
--
--   1. IMPERSONATION CANNOT ESCALATE. The effective permission set is
--      the INTERSECTION of the impersonator's own perms and the
--      target's — never the target's alone. Without that, an auditor
--      (read-only by design) could impersonate a super_admin and pick
--      up shortcodes.manage, portal_users.manage and archive.view;
--      the intersection makes impersonating strictly narrowing.
--
--   2. IMPERSONATION IS READ-ONLY. Every non-GET request is refused
--      while impersonating, at the middleware, so no write can ever be
--      attributed to a user who did not make it. The audit trail keeps
--      meaning what it says.
--
-- Both start and stop are audited with BOTH identities.
--
-- Seeded with INSERT … WHERE NOT EXISTS, not ON CONFLICT DO NOTHING:
-- the latter advances permissions_id_seq on every boot, which is how
-- that SMALLSERIAL previously hit its 32767 ceiling and crash-looped
-- db_init (see db/021's header). Same idiom as db/001 and db/028.
--
-- Idempotent. Safe to re-run.

INSERT INTO permissions (key, label)
SELECT 'portal_users.impersonate', 'View the dashboard as another user (read-only)'
 WHERE NOT EXISTS (SELECT 1 FROM permissions WHERE key = 'portal_users.impersonate');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  CROSS JOIN permissions p
 WHERE r.key IN ('super_admin', 'auditor')
   AND p.key = 'portal_users.impersonate'
   AND NOT EXISTS (
     SELECT 1 FROM role_permissions rp
      WHERE rp.role_id = r.id AND rp.permission_id = p.id
   );
