/**
 * Portal users admin DB queries.
 *
 * No-lockout invariants (the gateway portal must never be left
 * un-administrable):
 *   1. You cannot deactivate yourself.
 *   2. You cannot deactivate / demote the LAST active super_admin.
 *   3. You cannot delete a portal_user that owns active shortcodes
 *      (reassign first). Soft-deactivation is allowed though it
 *      leaves their owned shortcodes ownerless-as-far-as-RBAC
 *      goes — owners must be reassigned BEFORE deactivation in
 *      production. Current implementation: WARN at delete time,
 *      block deactivation when the user is the sole super_admin.
 *
 * Mirrors the jubileeTzUssd dashboard's "no-lockout invariants"
 * portion of the RBAC overhaul.
 */
import bcrypt from "bcryptjs";
import type { PoolClient } from "pg";
import { query, withTx } from "./db";

export interface UserRow {
  id: number;
  email: string;
  name: string;
  phone: string | null;
  role_id: number;
  role_key: string;
  role_label: string;
  active: boolean;
  created_at: string;
  last_login: string | null;
  owned_shortcode_count: number;
}

export interface RoleOption {
  id: number;
  key: string;
  label: string;
}

export async function listUsers(): Promise<UserRow[]> {
  const r = await query<UserRow>(
    `SELECT u.id, u.email, u.name, u.phone,
            u.role_id, r.key AS role_key, r.label AS role_label,
            u.active,
            u.created_at::text, u.last_login::text,
            COALESCE(c.cnt, 0)::int AS owned_shortcode_count
       FROM portal_users u
       JOIN roles r ON r.id = u.role_id
  LEFT JOIN (
        SELECT owner_user_id, COUNT(*) AS cnt
          FROM shortcodes WHERE active = TRUE
         GROUP BY owner_user_id
      ) c ON c.owner_user_id = u.id
      ORDER BY u.email`,
  );
  return r.rows;
}

export async function getUser(id: number): Promise<UserRow | null> {
  const r = await query<UserRow>(
    `SELECT u.id, u.email, u.name, u.phone,
            u.role_id, r.key AS role_key, r.label AS role_label,
            u.active,
            u.created_at::text, u.last_login::text,
            COALESCE(c.cnt, 0)::int AS owned_shortcode_count
       FROM portal_users u
       JOIN roles r ON r.id = u.role_id
  LEFT JOIN (
        SELECT owner_user_id, COUNT(*) AS cnt
          FROM shortcodes WHERE active = TRUE
         GROUP BY owner_user_id
      ) c ON c.owner_user_id = u.id
      WHERE u.id = $1`,
    [id],
  );
  return r.rows[0] ?? null;
}

export async function listRoles(): Promise<RoleOption[]> {
  const r = await query<RoleOption>(
    `SELECT id, key, label FROM roles ORDER BY id`,
  );
  return r.rows;
}

export interface UserCreate {
  email: string;
  name: string;
  phone: string | null;
  role_id: number;
  password: string;       // plaintext; we hash here
}

export interface UserUpdate {
  email: string;
  name: string;
  phone: string | null;
  role_id: number;
  active: boolean;
}

const BCRYPT_ROUNDS = 12;

export async function createUser(c: UserCreate): Promise<number> {
  const hash = await bcrypt.hash(c.password, BCRYPT_ROUNDS);
  const r = await query<{ id: number }>(
    `INSERT INTO portal_users (email, name, phone, role_id, password_hash)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [c.email, c.name, c.phone, c.role_id, hash],
  );
  return r.rows[0]!.id;
}

/**
 * Update profile fields. If the update would deactivate the user
 * OR demote them from super_admin, runs the no-lockout invariant
 * check inside the same transaction so a concurrent demote can't
 * race past it.
 */
export class NoLockoutError extends Error {
  constructor(public reason: string) { super(reason); this.name = "NoLockoutError"; }
}

export async function updateUser(
  id: number, u: UserUpdate, actingUserId: number,
): Promise<void> {
  await withTx(async (c) => {
    // Snapshot the current row + super_admin role id for the
    // invariant check.
    const curR = await c.query<{ role_id: number; active: boolean; role_key: string }>(
      `SELECT u.role_id, u.active, r.key AS role_key
         FROM portal_users u JOIN roles r ON r.id = u.role_id
        WHERE u.id = $1 FOR UPDATE`,
      [id],
    );
    const cur = curR.rows[0];
    if (!cur) throw new NoLockoutError("user not found");

    const wasSuper    = cur.role_key === "super_admin";
    const wasActive   = cur.active;
    const willBeSuper = await isSuperAdminRole(c, u.role_id);

    // (1) Can't deactivate or demote yourself.
    if (id === actingUserId) {
      if (!u.active) throw new NoLockoutError("cannot deactivate yourself");
      if (wasSuper && !willBeSuper) {
        throw new NoLockoutError("cannot demote yourself from super_admin");
      }
    }

    // (2) Can't deactivate / demote the LAST active super_admin.
    if (wasSuper && wasActive && (!u.active || !willBeSuper)) {
      const otherR = await c.query<{ c: string }>(
        `SELECT COUNT(*) AS c
           FROM portal_users u JOIN roles r ON r.id = u.role_id
          WHERE r.key = 'super_admin' AND u.active = TRUE AND u.id <> $1`,
        [id],
      );
      const otherSupers = Number(otherR.rows[0]?.c ?? 0);
      if (otherSupers === 0) {
        throw new NoLockoutError(
          "this is the last active super_admin — promote another user first",
        );
      }
    }

    await c.query(
      `UPDATE portal_users
          SET email = $2, name = $3, phone = $4,
              role_id = $5, active = $6, updated_at = now()
        WHERE id = $1`,
      [id, u.email, u.name, u.phone, u.role_id, u.active],
    );
  });
}

async function isSuperAdminRole(c: PoolClient, roleId: number): Promise<boolean> {
  const r = await c.query<{ key: string }>(
    `SELECT key FROM roles WHERE id = $1`, [roleId],
  );
  return r.rows[0]?.key === "super_admin";
}

export async function resetPassword(id: number, newPassword: string): Promise<void> {
  const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  await query(
    `UPDATE portal_users SET password_hash = $2, updated_at = now() WHERE id = $1`,
    [id, hash],
  );
}

export async function emailExists(email: string, excludeId?: number): Promise<boolean> {
  const r = await query<{ id: number }>(
    excludeId
      ? `SELECT id FROM portal_users WHERE LOWER(email) = LOWER($1) AND id <> $2 LIMIT 1`
      : `SELECT id FROM portal_users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
    excludeId ? [email, excludeId] : [email],
  );
  return r.rows.length > 0;
}

// =====================================================================
// Admin-scoped helpers (db/010 client_viewer + viewers.manage_own)
// =====================================================================
//
// A `client` (Admin = shortcode owner) can create read-only viewers
// for their OWN shortcodes only. The helpers below enforce that
// constraint at the data layer — every write is scoped to a
// shortcode the acting Admin owns, every list query restricts to
// viewers granted on those same shortcodes. The same functions are
// safe to call as super_admin (treat-as-Admin path), in which case
// the scope is "all shortcodes the target user already has".

/**
 * Viewers the Admin can see: any `client_viewer` whose junction row
 * touches a shortcode that the acting Admin owns. Includes the set
 * of granted shortcode ids per row so the UI can render the access
 * matrix without a follow-up query.
 */
export interface AdminViewerRow {
  id: number;
  email: string;
  name: string;
  phone: string | null;
  active: boolean;
  created_at: string;
  last_login: string | null;
  /** Shortcode ids the Admin has granted to this viewer (a subset of
   *  the viewer's full grants — limited to the Admin's own shortcodes). */
  granted_shortcode_ids: number[];
}

export async function listViewersForAdmin(
  adminUserId: number,
): Promise<AdminViewerRow[]> {
  const r = await query<AdminViewerRow>(
    `WITH admin_shortcodes AS (
        SELECT id FROM shortcodes WHERE owner_user_id = $1
     ),
     viewer_grants AS (
        SELECT pus.portal_user_id, pus.shortcode_id
          FROM portal_user_shortcodes pus
          JOIN admin_shortcodes a ON a.id = pus.shortcode_id
     )
     SELECT u.id, u.email, u.name, u.phone, u.active,
            u.created_at::text, u.last_login::text,
            COALESCE(
              ARRAY_AGG(vg.shortcode_id ORDER BY vg.shortcode_id)
                FILTER (WHERE vg.shortcode_id IS NOT NULL),
              ARRAY[]::int[]
            ) AS granted_shortcode_ids
       FROM portal_users u
       JOIN roles r ON r.id = u.role_id
       JOIN viewer_grants vg ON vg.portal_user_id = u.id
      WHERE r.key = 'client_viewer'
   GROUP BY u.id
   ORDER BY u.email`,
    [adminUserId],
  );
  return r.rows;
}

/** Admin's view of a single viewer — null if the viewer has no grant
 *  on any of the Admin's shortcodes (so the Admin can't see/edit it). */
export async function getViewerForAdmin(
  viewerId: number, adminUserId: number,
): Promise<AdminViewerRow | null> {
  const r = await query<AdminViewerRow>(
    `WITH admin_shortcodes AS (
        SELECT id FROM shortcodes WHERE owner_user_id = $1
     ),
     viewer_grants AS (
        SELECT pus.shortcode_id
          FROM portal_user_shortcodes pus
          JOIN admin_shortcodes a ON a.id = pus.shortcode_id
         WHERE pus.portal_user_id = $2
     )
     SELECT u.id, u.email, u.name, u.phone, u.active,
            u.created_at::text, u.last_login::text,
            COALESCE(ARRAY_AGG(vg.shortcode_id) FILTER (WHERE vg.shortcode_id IS NOT NULL),
                     ARRAY[]::int[]) AS granted_shortcode_ids
       FROM portal_users u
       JOIN roles r ON r.id = u.role_id
  LEFT JOIN viewer_grants vg ON TRUE
      WHERE u.id = $2 AND r.key = 'client_viewer'
        AND EXISTS (SELECT 1 FROM viewer_grants)
   GROUP BY u.id`,
    [adminUserId, viewerId],
  );
  return r.rows[0] ?? null;
}

export class ScopeError extends Error {
  constructor(public reason: string) { super(reason); this.name = "ScopeError"; }
}

/**
 * Create a new client_viewer scoped to a set of the Admin's
 * shortcodes. All shortcode ids MUST belong to the acting Admin
 * (validated inside the same transaction so a concurrent shortcode
 * transfer can't race). Returns the new portal_user id.
 */
export interface AdminViewerCreate {
  email: string;
  name: string;
  phone: string | null;
  password: string;
  shortcode_ids: number[];   // grants — must be non-empty + all owned by adminUserId
}

/**
 * Maximum client_viewer users an Admin can have in their lane. Soft
 * cap — super_admin's CRUD flow (createUser) is unaffected; only the
 * Admin's "+ Add a viewer" path is bounded.
 *
 * Per-Admin cap, not per-shortcode: a single viewer can be granted
 * access to MULTIPLE of the Admin's shortcodes via the grants matrix.
 * If the Admin needs broader access, they edit the existing viewer's
 * grants — not create a second one.
 */
export const ADMIN_MAX_VIEWERS = 1;

export async function createViewerAsAdmin(
  c: AdminViewerCreate, adminUserId: number,
): Promise<number> {
  if (c.shortcode_ids.length === 0) {
    throw new ScopeError("at least one shortcode grant is required");
  }
  const hash = await bcrypt.hash(c.password, BCRYPT_ROUNDS);
  return await withTx(async (tx) => {
    await assertShortcodesOwnedBy(tx, c.shortcode_ids, adminUserId);

    // Enforce the per-Admin viewer cap inside the same transaction —
    // a concurrent create on a parallel HTTP request can't race past
    // a serializable count check. The query mirrors listViewersForAdmin
    // (distinct viewer users with a grant on any of this Admin's
    // shortcodes).
    const countR = await tx.query<{ c: string }>(
      `SELECT COUNT(DISTINCT pus.portal_user_id) AS c
         FROM portal_user_shortcodes pus
         JOIN portal_users vu ON vu.id = pus.portal_user_id
         JOIN roles r       ON r.id = vu.role_id
        WHERE r.key = 'client_viewer'
          AND pus.shortcode_id IN (
            SELECT id FROM shortcodes WHERE owner_user_id = $1
          )`,
      [adminUserId],
    );
    const existing = Number(countR.rows[0]?.c ?? 0);
    if (existing >= ADMIN_MAX_VIEWERS) {
      throw new ScopeError(
        `you already have ${existing} viewer(s); the limit is ` +
        `${ADMIN_MAX_VIEWERS}. Edit the existing viewer's grants ` +
        `instead of creating a new one.`,
      );
    }

    const roleR = await tx.query<{ id: number }>(
      `SELECT id FROM roles WHERE key = 'client_viewer'`,
    );
    const roleId = roleR.rows[0]?.id;
    if (!roleId) throw new ScopeError("client_viewer role missing — run db/010 migration");
    const insR = await tx.query<{ id: number }>(
      `INSERT INTO portal_users (email, name, phone, role_id, password_hash)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [c.email, c.name, c.phone, roleId, hash],
    );
    const newId = insR.rows[0]!.id;
    for (const scId of c.shortcode_ids) {
      await tx.query(
        `INSERT INTO portal_user_shortcodes (portal_user_id, shortcode_id, access_level)
         VALUES ($1, $2, 'view')
         ON CONFLICT (portal_user_id, shortcode_id) DO NOTHING`,
        [newId, scId],
      );
    }
    return newId;
  });
}

/**
 * Replace the Admin's grants for a viewer in one shot — adds missing
 * rows, removes ones the Admin previously granted but no longer
 * wants. Grants the Admin doesn't own (e.g. set by a different
 * Admin) are untouched.
 *
 * Passing an empty `shortcode_ids` revokes ALL of the Admin's grants
 * for this viewer; the viewer's grants from OTHER Admins remain.
 */
export async function setViewerGrantsAsAdmin(
  viewerId: number, shortcodeIds: number[], adminUserId: number,
): Promise<void> {
  await withTx(async (tx) => {
    // Target user must be a client_viewer (block accidental writes
    // against a super_admin / client / auditor).
    const roleR = await tx.query<{ role_key: string }>(
      `SELECT r.key AS role_key
         FROM portal_users u JOIN roles r ON r.id = u.role_id
        WHERE u.id = $1 FOR UPDATE`,
      [viewerId],
    );
    if (!roleR.rows[0]) throw new ScopeError("viewer not found");
    if (roleR.rows[0].role_key !== "client_viewer") {
      throw new ScopeError("target user is not a client_viewer");
    }
    await assertShortcodesOwnedBy(tx, shortcodeIds, adminUserId);

    // Delete only the Admin's previous grants for this viewer.
    await tx.query(
      `DELETE FROM portal_user_shortcodes
        WHERE portal_user_id = $1
          AND shortcode_id IN (SELECT id FROM shortcodes WHERE owner_user_id = $2)`,
      [viewerId, adminUserId],
    );
    for (const scId of shortcodeIds) {
      await tx.query(
        `INSERT INTO portal_user_shortcodes (portal_user_id, shortcode_id, access_level)
         VALUES ($1, $2, 'view')
         ON CONFLICT (portal_user_id, shortcode_id) DO NOTHING`,
        [viewerId, scId],
      );
    }
  });
}

/** Admin update of a viewer's profile fields (email/name/phone/
 *  active). Role is fixed to client_viewer — Admin cannot promote a
 *  user out of their lane. */
export async function updateViewerAsAdmin(
  viewerId: number,
  u: { email: string; name: string; phone: string | null; active: boolean },
  adminUserId: number,
): Promise<void> {
  await withTx(async (tx) => {
    const r = await tx.query<{ role_key: string; has_grant: boolean }>(
      `SELECT r.key AS role_key,
              EXISTS (
                SELECT 1 FROM portal_user_shortcodes pus
                  JOIN shortcodes s ON s.id = pus.shortcode_id
                 WHERE pus.portal_user_id = u.id AND s.owner_user_id = $2
              ) AS has_grant
         FROM portal_users u JOIN roles r ON r.id = u.role_id
        WHERE u.id = $1 FOR UPDATE`,
      [viewerId, adminUserId],
    );
    if (!r.rows[0]) throw new ScopeError("viewer not found");
    if (r.rows[0].role_key !== "client_viewer") {
      throw new ScopeError("target user is not a client_viewer");
    }
    if (!r.rows[0].has_grant) {
      // The viewer exists but has no grants from this Admin — not in
      // their lane. Pretend it doesn't exist (no information leak).
      throw new ScopeError("viewer not found");
    }
    await tx.query(
      `UPDATE portal_users
          SET email = $2, name = $3, phone = $4, active = $5, updated_at = now()
        WHERE id = $1`,
      [viewerId, u.email, u.name, u.phone, u.active],
    );
  });
}

/** Verify every shortcode id in `ids` is owned by `userId`. Throws
 *  ScopeError on the first violation (FOR SHARE locks the rows for
 *  the duration of the surrounding transaction). */
async function assertShortcodesOwnedBy(
  tx: PoolClient, ids: number[], userId: number,
): Promise<void> {
  if (ids.length === 0) return;
  const r = await tx.query<{ id: number; owner_user_id: number }>(
    `SELECT id, owner_user_id
       FROM shortcodes
      WHERE id = ANY($1::int[])
      FOR SHARE`,
    [ids],
  );
  const found = new Set(r.rows.map((x) => x.id));
  for (const id of ids) {
    if (!found.has(id)) throw new ScopeError(`shortcode ${id} not found`);
  }
  for (const row of r.rows) {
    if (row.owner_user_id !== userId) {
      throw new ScopeError(`shortcode ${row.id} not owned by acting admin`);
    }
  }
}
