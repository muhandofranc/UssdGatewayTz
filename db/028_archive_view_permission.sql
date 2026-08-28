-- 028_archive_view_permission.sql
--
-- `archive.view` — read access to ussd_session_logs_archive (db/026).
--
-- Why a NEW permission rather than reusing `reports.view_all`:
--   reports.view_all is held by super_admin AND auditor (db/010). The
--   archive is cold forensic data — every MSISDN, dialed string and
--   handler response the platform has ever seen, for clients who may no
--   longer exist — so widening the audience by accident is not a thing
--   to leave to a shared permission. Granted to super_admin only; add
--   another role deliberately if that turns out to be too tight.
--
-- Seeded with INSERT … WHERE NOT EXISTS rather than ON CONFLICT DO
-- NOTHING: the SMALLSERIAL sequence advances on every conflicting
-- attempt, and db_init re-applies migrations on every boot, which is
-- exactly how permissions_id_seq previously walked to its 32767 ceiling
-- and crash-looped the gateway (see db/021 and the caveat in its
-- header). Same idiom as db/001's rewritten seeds.
--
-- Idempotent. Safe to re-run.

INSERT INTO permissions (key, label)
SELECT 'archive.view', 'Read archived USSD session logs (cold storage)'
 WHERE NOT EXISTS (SELECT 1 FROM permissions WHERE key = 'archive.view');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  CROSS JOIN permissions p
 WHERE r.key = 'super_admin'
   AND p.key = 'archive.view'
   AND NOT EXISTS (
     SELECT 1 FROM role_permissions rp
      WHERE rp.role_id = r.id AND rp.permission_id = p.id
   );
