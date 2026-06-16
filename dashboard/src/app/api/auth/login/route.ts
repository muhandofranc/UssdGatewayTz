/**
 * POST /api/auth/login
 * Body: { email: string, password: string, next?: string }
 *
 * Success → 200 { ok: true, next } + Set-Cookie session JWT.
 * Failure → 401 { error: "invalid credentials" }  (same shape for
 *           every failure mode — no account enumeration).
 *
 * Timing: failures pad to a constant duration (~250ms) to keep the
 * username-exists oracle silent.
 */
import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { query } from "@/lib/db";
import { loadUserClaims, signSession, setSessionCookie } from "@/lib/auth";
import { audit, clientIp } from "@/lib/audit";
import { validateSameOrigin } from "@/lib/csrf";

const GENERIC_ERROR = { error: "invalid credentials" };

// Sanitise the `next` redirect — only allow a same-site path, never
// an absolute URL (which could redirect off-domain after login).
function safeNext(raw: unknown): string {
  if (typeof raw !== "string") return "/";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  if (raw.startsWith("/login")) return "/";
  return raw;
}

async function padTiming(start: number, targetMs = 250): Promise<void> {
  const left = targetMs - (Date.now() - start);
  if (left > 0) await new Promise((r) => setTimeout(r, left));
}

export async function POST(req: Request) {
  const started = Date.now();
  const ip = clientIp(req);
  const ua = req.headers.get("user-agent");

  if (!validateSameOrigin(req)) {
    await audit({
      actor: null, action: "auth.login", outcome: "denied",
      ip, userAgent: ua, detail: { reason: "csrf" },
    });
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: any;
  try { body = await req.json(); } catch { body = null; }
  const email = (body?.email ?? "").toString().trim().toLowerCase();
  const password = (body?.password ?? "").toString();
  const next = safeNext(body?.next);

  if (!email || !password) {
    await padTiming(started);
    await audit({
      actor: email || null, action: "auth.login", outcome: "failure",
      ip, userAgent: ua, detail: { reason: "missing_fields" },
    });
    return NextResponse.json(GENERIC_ERROR, { status: 401 });
  }

  // Single query: pull active user + hash. Returns 0 rows on missing
  // or inactive user; we still run a bcrypt.compare against a dummy
  // hash to neutralise timing.
  const r = await query<{ id: number; password_hash: string }>(
    `SELECT id, password_hash
       FROM portal_users
      WHERE LOWER(email) = $1 AND active = TRUE
      LIMIT 1`,
    [email],
  );
  const row = r.rows[0];
  const hashToCheck =
    row?.password_hash ??
    // bcrypt-shaped dummy so the compare runs in constant-ish time.
    "$2b$12$0000000000000000000000000000000000000000000000000000";
  const ok = await bcrypt.compare(password, hashToCheck);

  if (!ok || !row) {
    await padTiming(started);
    await audit({
      actor: email, action: "auth.login", outcome: "failure",
      ip, userAgent: ua, detail: { reason: row ? "bad_password" : "no_user" },
    });
    return NextResponse.json(GENERIC_ERROR, { status: 401 });
  }

  const claims = await loadUserClaims(row.id);
  if (!claims) {
    // Race: user was deleted/deactivated between the lookup and now.
    await padTiming(started);
    await audit({
      actor: email, action: "auth.login", outcome: "failure",
      ip, userAgent: ua, detail: { reason: "claims_load_race" },
    });
    return NextResponse.json(GENERIC_ERROR, { status: 401 });
  }

  const jwt = await signSession(claims);
  await setSessionCookie(jwt);

  // Best-effort last_login bump.
  await query(
    `UPDATE portal_users SET last_login = now() WHERE id = $1`,
    [row.id],
  );

  await audit({
    actor: email, action: "auth.login", outcome: "success",
    ip, userAgent: ua, detail: { role: claims.role },
  });

  return NextResponse.json({ ok: true, next });
}
