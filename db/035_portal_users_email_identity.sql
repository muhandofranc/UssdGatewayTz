-- 035_portal_users_email_identity.sql
--
-- A portal user's email is their identity: unique ignoring case, and
-- changeable only by a super admin or by the user who created the
-- account (dashboard/src/lib/users.ts enforces who; this file gives it
-- the data and the constraint).
--
-- 1. created_by_user_id — who created the account. Set by the
--    dashboard on every create from now on. Existing accounts are
--    backfilled from the audit log: each `user.create` / `viewer.create`
--    row records the creator (actor email) and the new user's id
--    (detail.id). Accounts with no such row (bootstrap admin, rows
--    inserted by SQL) stay NULL: only a super admin can change their
--    email. ON DELETE SET NULL so deleting a creator never blocks or
--    cascades.
--
-- 2. Case-insensitive uniqueness. 001's UNIQUE (email) is
--    case-sensitive, so 'A@x.com' and 'a@x.com' could both exist; the
--    dashboard's emailExists() pre-check is case-insensitive but
--    check-then-insert, so two concurrent creates could still race past
--    it. A unique index on LOWER(email) closes both.
--
--    If case-variant duplicates already exist, building the index fails;
--    rather than abort the migration (and with it the container start),
--    it is skipped with a WARNING naming them. Fix the duplicates, then
--    run the CREATE UNIQUE INDEX below by hand. Check with:
--      SELECT LOWER(email), array_agg(id) FROM portal_users
--       GROUP BY 1 HAVING COUNT(*) > 1;
--
-- Idempotent: safe to re-run.

ALTER TABLE portal_users
    ADD COLUMN IF NOT EXISTS created_by_user_id INTEGER
        REFERENCES portal_users(id) ON DELETE SET NULL;

UPDATE portal_users u
   SET created_by_user_id = c.id
  FROM portal_audit_log a
  JOIN portal_users c ON LOWER(c.email) = LOWER(a.actor)
 WHERE a.action IN ('user.create', 'viewer.create')
   AND a.outcome = 'success'
   AND a.detail ? 'id'
   AND (a.detail->>'id') ~ '^[0-9]+$'
   AND (a.detail->>'id')::int = u.id
   AND c.id <> u.id
   AND u.created_by_user_id IS NULL;

DO $$
DECLARE
    dups TEXT;
BEGIN
    CREATE UNIQUE INDEX IF NOT EXISTS uq_portal_users_email_lower
        ON portal_users (LOWER(email));
EXCEPTION WHEN unique_violation THEN
    SELECT string_agg(e || ' (ids ' || ids || ')', '; ')
      INTO dups
      FROM (SELECT LOWER(email) AS e, string_agg(id::text, ',') AS ids
              FROM portal_users GROUP BY 1 HAVING COUNT(*) > 1) d;
    RAISE WARNING 'uq_portal_users_email_lower NOT created: case-variant duplicate emails exist: %', dups;
END
$$;
