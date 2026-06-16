/**
 * JWT-cookie session — stateless, HS256, jose-signed. The cookie
 * carries:
 *   { sub: portal_user_id, email, name, role, perms[], shortcodeIds[], iat, exp }
 *
 * `shortcodeIds` is the per-user shortcode allowlist materialised at
 * login (owner_user_id = userId UNION the portal_user_shortcodes
 * junction). For super_admin we set `shortcodeIds = null` to signal
 * "all" — every query helper that filters by this list treats null
 * as the all-pass case.
 *
 * Rotation: bumping SESSION_SECRET invalidates every live session
 * (jose will reject the HMAC). This is the only revocation primitive;
 * intentional, mirrors jubileeTzUssd.
 */
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { cookies } from "next/headers";
import { query } from "./db";

const ALG = "HS256";

const COOKIE_NAME =
  process.env.SESSION_COOKIE_NAME || "ussd_gw_dashboard_session";
const TTL_SECONDS = Number(process.env.SESSION_TTL_SECONDS || 28_800); // 8h
const COOKIE_INSECURE =
  process.env.SESSION_COOKIE_INSECURE === "1" &&
  process.env.NODE_ENV !== "production";

function secretBytes(): Uint8Array {
  const raw = process.env.SESSION_SECRET || "";
  if (raw.length < 48) {
    // Fail loudly — a too-short secret silently weakens auth. Throwing
    // at first use crashes the route, surfacing the misconfig before
    // a single session is minted.
    throw new Error(
      "SESSION_SECRET unset or shorter than 48 chars — refuse to mint sessions",
    );
  }
  const distinct = new Set(raw).size;
  if (distinct < 16) {
    throw new Error(
      "SESSION_SECRET has <16 distinct chars — likely placeholder; refuse",
    );
  }
  return new TextEncoder().encode(raw);
}

export interface SessionClaims extends JWTPayload {
  sub: string;             // portal_users.id as string
  email: string;
  name: string;
  role: string;            // roles.key
  perms: string[];         // permissions.key list
  shortcodeIds: number[] | null; // null = unrestricted (super_admin)
}

export async function signSession(claims: Omit<SessionClaims, "iat" | "exp">): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({ ...claims })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt(now)
    .setExpirationTime(now + TTL_SECONDS)
    .sign(secretBytes());
}

export async function verifySession(jwt: string): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(jwt, secretBytes(), { algorithms: [ALG] });
    return payload as SessionClaims;
  } catch {
    return null;
  }
}

/**
 * Read the cookie from the active request's headers and verify it.
 * Returns null when no cookie, expired, or signature mismatch.
 *
 * Server components, server actions, and route handlers all share
 * the same cookies() store in Next 15.
 */
export async function getSession(): Promise<SessionClaims | null> {
  const jwt = (await cookies()).get(COOKIE_NAME)?.value;
  if (!jwt) return null;
  return await verifySession(jwt);
}

export async function setSessionCookie(jwt: string): Promise<void> {
  (await cookies()).set({
    name: COOKIE_NAME,
    value: jwt,
    httpOnly: true,
    secure: !COOKIE_INSECURE,
    sameSite: "strict",
    path: "/",
    maxAge: TTL_SECONDS,
  });
}

export async function clearSessionCookie(): Promise<void> {
  (await cookies()).set({
    name: COOKIE_NAME,
    value: "",
    httpOnly: true,
    secure: !COOKIE_INSECURE,
    sameSite: "strict",
    path: "/",
    maxAge: 0,
  });
}

/**
 * Materialise role permissions + shortcode allowlist for a user at
 * login time. Bundled into the JWT so request-time checks never
 * touch the DB.
 *
 * `shortcodeIds` semantics:
 *   - super_admin role → null (sees all)
 *   - everyone else    → array (possibly empty) of owned shortcode ids
 *     UNION the portal_user_shortcodes junction (future-use).
 */
export async function loadUserClaims(
  userId: number,
): Promise<Omit<SessionClaims, "iat" | "exp"> | null> {
  const r = await query<{
    id: number; email: string; name: string;
    role_key: string; perms: string[];
  }>(
    `SELECT u.id, u.email, u.name, r.key AS role_key,
            COALESCE(ARRAY_AGG(p.key) FILTER (WHERE p.key IS NOT NULL), '{}') AS perms
       FROM portal_users u
       JOIN roles r ON r.id = u.role_id
  LEFT JOIN role_permissions rp ON rp.role_id = r.id
  LEFT JOIN permissions p ON p.id = rp.permission_id
      WHERE u.id = $1 AND u.active = TRUE
      GROUP BY u.id, u.email, u.name, r.key`,
    [userId],
  );
  const row = r.rows[0];
  if (!row) return null;

  let shortcodeIds: number[] | null;
  if (row.role_key === "super_admin") {
    shortcodeIds = null;
  } else {
    const sc = await query<{ id: number }>(
      `SELECT id FROM shortcodes
        WHERE owner_user_id = $1
       UNION
       SELECT shortcode_id AS id FROM portal_user_shortcodes
        WHERE portal_user_id = $1`,
      [userId],
    );
    shortcodeIds = sc.rows.map((r) => r.id);
  }
  return {
    sub: String(row.id),
    email: row.email,
    name: row.name,
    role: row.role_key,
    perms: row.perms,
    shortcodeIds,
  };
}

export function hasPerm(session: SessionClaims | null, key: string): boolean {
  if (!session) return false;
  return session.perms.includes(key);
}
