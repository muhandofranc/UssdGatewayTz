/**
 * POST /api/auth/impersonate/stop — return to your own session.
 *
 * Re-mints the session from the ORIGIN identity carried in `imp`,
 * re-reading that user's claims from the database rather than trusting
 * whatever was in the cookie: if the admin's own role or permissions
 * changed while they were viewing as someone else, they come back with
 * what they are entitled to now.
 *
 * Middleware exempts this exact path from the read-only block — it is
 * the way out, so it cannot be blocked by the state it exits.
 */
import { NextResponse } from "next/server";
import {
  getSession, loadUserClaims, signSession, setSessionCookie,
} from "@/lib/auth";
import { audit, clientIp } from "@/lib/audit";
import { validateSameOrigin } from "@/lib/csrf";

export async function POST(req: Request) {
  const ip = clientIp(req);
  const ua = req.headers.get("user-agent");

  if (!validateSameOrigin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!session.imp) {
    return NextResponse.json({ error: "not impersonating" }, { status: 400 });
  }

  const origin = session.imp;
  const own = await loadUserClaims(Number(origin.sub));
  if (!own) {
    // The admin's own account was deactivated mid-session. There is no
    // safe session to return to, so end it entirely rather than leave
    // them impersonating with no way back.
    await audit({
      actor: origin.email, action: "impersonation.stop", outcome: "failure",
      target: session.email, ip, userAgent: ua,
      detail: { reason: "origin_account_inactive" },
    });
    return NextResponse.json(
      { error: "your account is no longer active", signOut: true }, { status: 401 },
    );
  }

  await setSessionCookie(await signSession(own));

  await audit({
    actor: origin.email, action: "impersonation.stop", outcome: "success",
    target: session.email, ip, userAgent: ua,
    detail: { target_user_id: Number(session.sub) },
  });

  return NextResponse.json({ ok: true });
}
