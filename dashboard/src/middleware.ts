/**
 * Edge middleware — request-time route guard. Runs BEFORE any server
 * component / route handler is invoked. The check is purely against
 * the JWT cookie (no DB) so it's cheap enough for every request.
 *
 * Order:
 *   1. If the route is public, pass through.
 *   2. Verify the JWT cookie. Missing/expired → 401 (API) or
 *      redirect to /login (page).
 *   3. Look up required perms for this path. If any are satisfied
 *      by session.perms, pass through. Else 403 / redirect.
 *
 * Defence-in-depth: server layouts ALSO call getSession() and the
 * data layer scopes by `shortcodeIds`. The middleware is the first
 * gate, not the only one.
 */
import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";
import { requiredPermFor } from "@/lib/rbac";

const COOKIE_NAME =
  process.env.SESSION_COOKIE_NAME || "ussd_gw_dashboard_session";

function secretBytes(): Uint8Array {
  const raw = process.env.SESSION_SECRET || "";
  return new TextEncoder().encode(raw);
}

function unauthorized(req: NextRequest): NextResponse {
  const isApi = req.nextUrl.pathname.startsWith("/api/");
  if (isApi) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = new URL("/login", req.nextUrl);
  url.searchParams.set("next", req.nextUrl.pathname + req.nextUrl.search);
  return NextResponse.redirect(url);
}

function forbidden(req: NextRequest): NextResponse {
  const isApi = req.nextUrl.pathname.startsWith("/api/");
  if (isApi) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  // For page routes, send to landing — landing layout will surface a
  // "you don't have access" notice without a redirect loop.
  return NextResponse.redirect(new URL("/", req.nextUrl));
}

export async function middleware(req: NextRequest) {
  const required = requiredPermFor(req.nextUrl.pathname);
  if (required === null) return NextResponse.next();   // public

  const jwt = req.cookies.get(COOKIE_NAME)?.value;
  if (!jwt) return unauthorized(req);

  try {
    const { payload } = await jwtVerify(jwt, secretBytes(), { algorithms: ["HS256"] });
    const perms = (payload.perms as string[]) || [];
    if (required.some((p) => perms.includes(p))) return NextResponse.next();
    return forbidden(req);
  } catch {
    return unauthorized(req);
  }
}

// Apply to everything except Next internals + static. The matcher
// avoids invoking middleware on _next/static / image optimization
// requests for cost reasons.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon).*)"],
};
