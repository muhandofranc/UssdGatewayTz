/**
 * POST /api/auth/logout
 *   Clears the session cookie + audits + redirects to /login.
 *
 * Same-origin guard applies. Logout is idempotent — no session is
 * still a 200 (we just clear nothing).
 */
import { NextResponse } from "next/server";
import { getSession, clearSessionCookie } from "@/lib/auth";
import { audit, clientIp } from "@/lib/audit";
import { validateSameOrigin } from "@/lib/csrf";

/**
 * Build the absolute /login URL using the CLIENT-visible host
 * (`x-forwarded-host` if behind a proxy, else `host`). Falling back
 * to `req.url` would produce `http://0.0.0.0:3000/login` because
 * Next 15 synthesises req.url from the server's bind address — a
 * browser following that would land on an unroutable host.
 */
function loginRedirectUrl(req: Request): string {
  const host =
    req.headers.get("x-forwarded-host") ??
    req.headers.get("host") ??
    new URL(req.url).host;
  const proto = req.headers.get("x-forwarded-proto") ?? "http";
  return `${proto}://${host}/login`;
}

export async function POST(req: Request) {
  if (!validateSameOrigin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const session = await getSession();
  await clearSessionCookie();
  await audit({
    actor: session?.email ?? null,
    action: "auth.logout",
    outcome: "success",
    ip: clientIp(req),
    userAgent: req.headers.get("user-agent"),
  });
  // 303 makes the browser switch to GET on the redirect target.
  return NextResponse.redirect(loginRedirectUrl(req), { status: 303 });
}
