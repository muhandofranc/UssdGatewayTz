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
