/**
 * JWT-cookie session — stateless, HS256, jose-signed. The cookie
 * carries:
 *   { sub: portal_user_id, email, name, role, perms[], shortcodeIds[], iat, exp }
 *
 * `shortcodeIds` is the per-user shortcode allowlist materialised at
 * login (owner_user_id = userId UNION the portal_user_shortcodes
 * junction), and `shortcodeFrom` is the instant each of those grants
 * began — so a shortcode re-allocated from one client to another shows
 * its new owner only the traffic from the hand-over onwards. For
 * super_admin we set `shortcodeIds = null` to signal "all" — every
 * query helper that filters by this list treats null as the all-pass
 * case. Use `sessionAcl()` to get the pair in the shape lib/acl.ts
 * consumes; that module is the only place that turns it into SQL.
 *
 * Rotation: bumping SESSION_SECRET invalidates every live session
 * (jose will reject the HMAC). This is the only revocation primitive;
 * intentional, mirrors jubileeTzUssd.
 */
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { cookies } from "next/headers";
import { query } from "./db";
import type { ShortcodeAcl } from "./acl";

const ALG = "HS256";

const COOKIE_NAME =
  process.env.SESSION_COOKIE_NAME || "ussd_gw_dashboard_session";
const TTL_SECONDS = Number(process.env.SESSION_TTL_SECONDS || 28_800); // 8h
export const IMPERSONATION_TTL_SECONDS = Number(
  process.env.SESSION_IMPERSONATION_TTL_SECONDS || 1_800,                // 30m
);
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

/**
 * The claim set we mint, before jose adds `iat`/`exp`.
 *
 * Kept separate from SessionClaims because that one extends jose's
 * JWTPayload, whose `[k: string]: unknown` index signature makes
 * `NewSessionClaims` widen every named property to
 * `unknown` — silently turning `perms: string[]` into something you
 * cannot call .filter() on.
 */
export interface NewSessionClaims {
  sub: string;             // portal_users.id as string
  email: string;
  name: string;
  role: string;            // roles.key
  perms: string[];         // permissions.key list
  shortcodeIds: number[] | null; // null = unrestricted (super_admin)
  /**
   * Unix seconds from which a shortcode is readable, keyed by shortcode
   * id — the instant it was allocated to this user. Only shortcodes
   * that have actually changed hands appear here; anything absent has
   * no floor. Sparse rather than index-aligned on purpose: a floor per
   * shortcode would add ~15 bytes each and push a JWT for a client with
   * ~200 shortcodes past the 4 KB cookie limit, while re-allocations
   * are rare.
   *
   * Optional: sessions minted before this field existed have no floors,
   * which is the pre-scoping behaviour — they pick it up at their next
   * login rather than being logged out.
   */
  shortcodeFrom?: Record<string, number>;
  /**
   * Present only while impersonating: WHO IS REALLY DRIVING. Every
   * other claim above describes the impersonated user, so this is the
   * identity that matters for accountability — the banner names it and
   * the audit trail records it.
   *
   * Its presence is also the read-only signal: middleware refuses every
   * non-GET request when this is set, so a write can never be
   * attributed to someone who did not make it.
   */
  imp?: ImpersonationOrigin;
}

/**
 * A verified session: the minted claims plus jose's registered ones.
 * An intersection rather than `extends` because JWTPayload declares
 * `sub?: string` while ours is always present — an interface may not
 * extend two types that disagree on a property, but the intersection
 * resolves it to the narrower `string`.
 */
export type SessionClaims = NewSessionClaims & JWTPayload;

/** The real actor behind an impersonated session. */
export interface ImpersonationOrigin {
  sub: string;
  email: string;
  name: string;
  role: string;
}

/**
 * Claims for "actor views the dashboard as target".
 *
 * The rule that makes this safe: effective perms are the INTERSECTION
 * of the actor's own perms and the target's, never the target's alone.
 * Impersonating can only narrow what you may do. Without it an auditor
 * — read-only by design — could impersonate a super_admin and acquire
 * shortcodes.manage and archive.view, turning a support tool into a
 * privilege-escalation path.
 *
 * The DATA scope, by contrast, is wholly the target's: their shortcode
 * allowlist and its time floors. That is the entire point — to see what
 * they see. It is never widening either, because only super_admin and
 * auditor may impersonate and both are already unrestricted.
 */
/**
 * Permissions that subsume others, for the intersection below only.
 *
 * A plain set-intersection is too blunt: an auditor holds
 * `reports.view_all` and a client holds `reports.view_own`, which share
 * no key, so intersecting them yields NOTHING and the auditor lands in
 * an impersonated session that cannot render a single page. But someone
 * cleared to read EVERY client's reports is plainly cleared to read one
 * client's, so the broader perm is expanded to cover the narrower one
 * before intersecting.
 *
 * Only ever widens the ACTOR's side, and only toward perms they already
 * dominate — so the no-escalation property still holds.
 */
const IMPLIES: Record<string, string[]> = {
  "reports.view_all":    ["reports.view_own"],
  "shortcodes.manage":   ["shortcodes.view", "shortcodes.manage_sandbox"],
  "portal_users.manage": ["portal_users.view"],
};

function expandPerms(perms: string[]): Set<string> {
  const out = new Set(perms);
  for (const p of perms) for (const implied of IMPLIES[p] ?? []) out.add(implied);
  return out;
}

export function impersonatedClaims(
  actor: SessionClaims,
  target: NewSessionClaims,
): NewSessionClaims {
  const actorPerms = expandPerms(actor.perms);
  return {
    ...target,
    perms: target.perms.filter((p) => actorPerms.has(p)),
    imp: {
      sub: actor.sub, email: actor.email,
      name: actor.name, role: actor.role,
    },
  };
}

/** True when this session is someone viewing as someone else. */
export function isImpersonating(session: SessionClaims | null): boolean {
  return !!session?.imp;
}

/** The session's allowlist in the shape lib/acl.ts consumes. */
export function sessionAcl(session: SessionClaims | null): ShortcodeAcl {
  if (!session) return [];
  if (session.shortcodeIds === null) return null;
  const from = session.shortcodeFrom ?? {};
  return session.shortcodeIds.map((id) => ({ id, from: from[String(id)] ?? 0 }));
}

export async function signSession(claims: NewSessionClaims): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  // An impersonated session is a support detour, not a working day: it
  // expires in 30 minutes and drops the admin back to their own login
  // rather than lingering for the full 8 hours.
  const ttl = claims.imp ? IMPERSONATION_TTL_SECONDS : TTL_SECONDS;
  return await new SignJWT({ ...claims })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt(now)
    .setExpirationTime(now + ttl)
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

export async function setSessionCookie(
  jwt: string, ttlSeconds?: number,
): Promise<void> {
  (await cookies()).set({
    name: COOKIE_NAME,
    value: jwt,
    httpOnly: true,
    secure: !COOKIE_INSECURE,
    sameSite: "strict",
    path: "/",
    maxAge: ttlSeconds ?? TTL_SECONDS,
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
): Promise<NewSessionClaims | null> {
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

  // Unrestricted shortcode access for anyone whose perms include
  // `reports.view_all` — super_admin (granted via the CROSS JOIN in
  // db/001) AND auditor (granted explicitly in db/010). Lifting the
  // check off the hard-coded role key makes future "global read-only"
  // roles automatically inherit the right scope.
  let shortcodeIds: number[] | null;
  let shortcodeFrom: Record<string, number> = {};
  if (row.perms.includes("reports.view_all")) {
    shortcodeIds = null;
  } else {
    // Each grant carries the instant it started: owner_since for an
    // owned shortcode, granted_at for a collaborator grant. A user who
    // holds both takes the earlier of the two — their access really did
    // begin then.
    const sc = await query<{ id: number; from_ts: string; reallocated: boolean }>(
      `SELECT id, MIN(from_ts)::bigint AS from_ts, bool_or(floored) AS reallocated
         FROM (
           -- Owned: floored only if the shortcode changed hands after it
           -- was created; otherwise the owner has always had it.
           SELECT id, EXTRACT(EPOCH FROM owner_since) AS from_ts,
                  (owner_since > created_at)          AS floored
             FROM shortcodes
            WHERE owner_user_id = $1
           UNION ALL
           -- Collaborator grants always start when they were granted.
           SELECT shortcode_id AS id, EXTRACT(EPOCH FROM granted_at), TRUE
             FROM portal_user_shortcodes
            WHERE portal_user_id = $1
         ) g(id, from_ts, floored)
        GROUP BY id
        ORDER BY id`,
      [userId],
    );
    shortcodeIds = sc.rows.map((r) => r.id);
    // Only the re-allocated ones — see the field doc. `reallocated` is
    // computed by the DB (owner_since > created_at) so a shortcode that
    // has always had one owner never carries a floor.
    shortcodeFrom = {};
    for (const r of sc.rows) {
      if (r.reallocated) shortcodeFrom[String(r.id)] = Number(r.from_ts) || 0;
    }
  }
  return {
    sub: String(row.id),
    email: row.email,
    name: row.name,
    role: row.role_key,
    perms: row.perms,
    shortcodeIds,
    shortcodeFrom,
  };
}

export function hasPerm(session: SessionClaims | null, key: string): boolean {
  if (!session) return false;
  return session.perms.includes(key);
}
