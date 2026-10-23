/**
 * POST /api/auth/forgot-password
 * Body: { email: string }
 *
 * Emails a single-use reset link (lib/passwordReset.ts) to an active
 * user with that address. Public: the caller is signed out.
 *
 * Account enumeration: the reply is the same { ok: true } whether or not
 * the email belongs to anyone, and every path pads to the same duration.
 * The email itself is sent in the background so SMTP latency can't
 * reveal that a real account was found.
 *
 * Abuse limits, counted from the audit log (no counter table):
 *   - 10 requests per IP per hour → 429 (says nothing about accounts)
 *   - 3 links per email per hour  → silently not sent (still { ok: true }),
 *     so nobody can flood a user's inbox
 *
 * An API route like /api/auth/login rather than a server action, so the
 * only unauthenticated write surface stays a pair of plain JSON routes.
 */
import { NextResponse } from "next/server";
import { audit, clientIp, recentAuditCount, recentAuditCountByIp } from "@/lib/audit";
import { validateSameOrigin } from "@/lib/csrf";
import { mailEnabled, publicBaseUrl, sendMail } from "@/lib/mailer";
import { findActiveUserByEmail, issueResetToken, RESET_TTL_MINUTES } from "@/lib/passwordReset";

const ACTION = "auth.reset_request";
const PER_IP_PER_HOUR = 10;
const PER_EMAIL_PER_HOUR = 3;
const GENERIC = { ok: true };

async function padTiming(start: number, targetMs = 600): Promise<void> {
  const left = targetMs - (Date.now() - start);
  if (left > 0) await new Promise((r) => setTimeout(r, left));
}

function resetEmail(name: string, email: string, link: string, ip: string | null): string {
  return [
    `Hello ${name},`,
    "",
    `Someone asked to reset the password for ${email} on the UssdGatewayTz portal.`,
    "",
    `To choose a new password, open this link within ${RESET_TTL_MINUTES} minutes:`,
    "",
    link,
    "",
    "The link works once. Resetting signs you out on every device.",
    "",
    "If you didn't ask for this, ignore this email: your password stays as it is.",
    ip ? `The request came from IP address ${ip}.` : "",
  ].join("\n");
}

export async function POST(req: Request) {
  const started = Date.now();
  const ip = clientIp(req);
  const ua = req.headers.get("user-agent");

  if (!validateSameOrigin(req)) {
    await audit({
      actor: null, action: ACTION, outcome: "denied",
      ip, userAgent: ua, detail: { reason: "csrf" },
    });
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  if (!mailEnabled()) {
    return NextResponse.json(
      { error: "Password reset by email isn't set up. Ask an administrator to reset your password." },
      { status: 503 },
    );
  }

  if (await recentAuditCountByIp(ip, ACTION, 60) >= PER_IP_PER_HOUR) {
    await audit({
      actor: null, action: ACTION, outcome: "denied",
      ip, userAgent: ua, detail: { reason: "ip_rate_limit" },
    });
    await padTiming(started);
    return NextResponse.json({ error: "Too many requests. Try again later." }, { status: 429 });
  }

  let body: any;
  try { body = await req.json(); } catch { body = null; }
  const email = (body?.email ?? "").toString().trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 255) {
    await padTiming(started);
    return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  }

  if (await recentAuditCount(email, ACTION, "success", 60) >= PER_EMAIL_PER_HOUR) {
    await audit({
      actor: email, action: ACTION, outcome: "denied",
      ip, userAgent: ua, detail: { reason: "email_rate_limit" },
    });
    await padTiming(started);
    return NextResponse.json(GENERIC);
  }

  const user = await findActiveUserByEmail(email);
  if (!user) {
    await audit({
      actor: email, action: ACTION, outcome: "failure",
      ip, userAgent: ua, detail: { reason: "no_user" },
    });
    await padTiming(started);
    return NextResponse.json(GENERIC);
  }

  const token = await issueResetToken(user.id, ip);
  // Fragment, not query string: browsers never send it to the server,
  // so the token stays out of proxy access logs and Referer headers.
  const link = `${publicBaseUrl()}/reset-password#token=${token}`;
  await audit({
    actor: user.email, action: ACTION, target: String(user.id), outcome: "success",
    ip, userAgent: ua,
  });
  // Not awaited — see the header. Failures still land in the audit log.
  void sendMail(user.email, "Reset your UssdGatewayTz portal password",
                resetEmail(user.name, user.email, link, ip))
    .catch(async (e) => {
      console.error("reset email send failed:", e);
      await audit({
        actor: user.email, action: "auth.reset_email", target: String(user.id),
        outcome: "failure", ip, userAgent: ua,
        detail: { reason: "send_failed", error: String(e?.message ?? e).slice(0, 300) },
      });
    });

  await padTiming(started);
  return NextResponse.json(GENERIC);
}
