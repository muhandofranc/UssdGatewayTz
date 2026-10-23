/**
 * Password-reset tokens (db/034 password_reset_tokens). Server-only.
 *
 * A token is 32 random bytes, base64url: it exists only in the email.
 * The table stores its SHA-256, so lookups hash the presented token and
 * compare hashes. Unguessable at 256 bits, so no attempt counter is
 * needed on the token itself.
 *
 * Lifecycle:
 *   issue    → retires the user's other unused tokens (only the newest
 *              link works) and purges rows a day past expiry
 *   peek     → read-only validity check for the reset page
 *   consume  → in one transaction: verify unused + unexpired + user
 *              active, set the password, bump password_version (signs
 *              out every session, db/034), retire all the user's tokens
 */
import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { query, withTx } from "./db";

export const RESET_TTL_MINUTES = 30;
const BCRYPT_ROUNDS = 12;
// 32 bytes → 43 base64url chars. Anything else is rejected before
// touching the DB.
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface ResetTarget {
  id: number;
  email: string;
  name: string;
}

/** The active user with this email (case-insensitive), or null. */
export async function findActiveUserByEmail(email: string): Promise<ResetTarget | null> {
  const r = await query<ResetTarget>(
    `SELECT id, email, name FROM portal_users
      WHERE LOWER(email) = $1 AND active = TRUE
      LIMIT 1`,
    [email.toLowerCase()],
  );
  return r.rows[0] ?? null;
}

/** Create a reset token for the user and return it (the only copy). */
export async function issueResetToken(userId: number, ip: string | null): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await withTx(async (c) => {
    await c.query(
      `DELETE FROM password_reset_tokens WHERE expires_at < now() - interval '1 day'`,
    );
    await c.query(
      `UPDATE password_reset_tokens SET used_at = now()
        WHERE portal_user_id = $1 AND used_at IS NULL`,
      [userId],
    );
    await c.query(
      `INSERT INTO password_reset_tokens (portal_user_id, token_hash, expires_at, requested_ip)
       VALUES ($1, $2, now() + make_interval(mins => $3), $4)`,
      [userId, hashToken(token), RESET_TTL_MINUTES, ip],
    );
  });
  return token;
}

/** Is this token currently usable? Read-only. */
export async function peekResetToken(token: string): Promise<boolean> {
  if (!TOKEN_RE.test(token)) return false;
  const r = await query<{ id: number }>(
    `SELECT t.id FROM password_reset_tokens t
       JOIN portal_users u ON u.id = t.portal_user_id
      WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > now()
        AND u.active = TRUE`,
    [hashToken(token)],
  );
  return r.rows.length > 0;
}

/**
 * Set a new password with a reset token. Returns the user's email on
 * success, null if the token is malformed, unknown, used, expired, or
 * the user is no longer active.
 */
export async function consumeResetToken(
  token: string, newPassword: string,
): Promise<string | null> {
  if (!TOKEN_RE.test(token)) return null;
  // Hash outside the transaction: ~250ms shouldn't hold the row lock.
  const pwHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  return withTx(async (c) => {
    // FOR UPDATE: two submits of the same link can't both succeed.
    const r = await c.query<{ portal_user_id: number; email: string }>(
      `SELECT t.portal_user_id, u.email
         FROM password_reset_tokens t
         JOIN portal_users u ON u.id = t.portal_user_id
        WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > now()
          AND u.active = TRUE
        FOR UPDATE OF t`,
      [hashToken(token)],
    );
    const row = r.rows[0];
    if (!row) return null;
    await c.query(
      `UPDATE portal_users
          SET password_hash = $2, password_version = password_version + 1, updated_at = now()
        WHERE id = $1`,
      [row.portal_user_id, pwHash],
    );
    await c.query(
      `UPDATE password_reset_tokens SET used_at = now()
        WHERE portal_user_id = $1 AND used_at IS NULL`,
      [row.portal_user_id],
    );
    return row.email;
  });
}
