/**
 * POST /api/auth/reset-password
 * Body: { token, check: true }                     → { valid: boolean }
 *       { token, password, password_confirm }      → { ok: true } | 400 { error }
 *
 * Completes a reset from an emailed link (lib/passwordReset.ts). Public.
 * The token travels in the body, never the URL: the page reads it from
 * the link's #fragment.
 *
 * The `check` form lets the page say "this link has expired" before the
 * user types a new password; it changes nothing and isn't audited.
 *
 * Success sets the password, signs the user out everywhere (db/034
 * password_version) and does NOT sign them in: they log in with the new
 * password, which proves the reset took.
 */
import { NextResponse } from "next/server";
import { audit, clientIp, recentAuditCountByIp } from "@/lib/audit";
import { validateSameOrigin } from "@/lib/csrf";
import { consumeResetToken, peekResetToken } from "@/lib/passwordReset";
import { newPasswordError } from "@/lib/users";

const ACTION = "auth.reset_complete";
// Tokens are 256-bit, so this isn't guarding the token; it caps how
// much bcrypt work one IP can make the server do.
const PER_IP_PER_HOUR = 20;
const INVALID = "This reset link is invalid or has expired. Request a new one.";

export async function POST(req: Request) {
  const ip = clientIp(req);
  const ua = req.headers.get("user-agent");

  if (!validateSameOrigin(req)) {
    await audit({
      actor: null, action: ACTION, outcome: "denied",
      ip, userAgent: ua, detail: { reason: "csrf" },
    });
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: any;
  try { body = await req.json(); } catch { body = null; }
  const token = (body?.token ?? "").toString();

  if (body?.check === true) {
    return NextResponse.json({ valid: await peekResetToken(token) });
  }

  if (await recentAuditCountByIp(ip, ACTION, 60) >= PER_IP_PER_HOUR) {
    return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 });
  }

  // Not trimmed — see newPasswordError.
  const pw      = (body?.password ?? "").toString();
  const confirm = (body?.password_confirm ?? "").toString();
  const invalid = newPasswordError(pw, confirm);
  if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });

  const email = await consumeResetToken(token, pw);
  if (!email) {
    await audit({
      actor: null, action: ACTION, outcome: "failure",
      ip, userAgent: ua, detail: { reason: "invalid_or_expired_token" },
    });
    return NextResponse.json({ error: INVALID }, { status: 400 });
  }

  await audit({ actor: email, action: ACTION, outcome: "success", ip, userAgent: ua });
  return NextResponse.json({ ok: true });
}
