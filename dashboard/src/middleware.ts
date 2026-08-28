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
 *   4. If the session is IMPERSONATING, refuse anything that is not a
 *      GET. This is the whole of what makes impersonation read-only,
 *      and it is deliberately one choke point rather than a check
 *      scattered across every server action: server actions, API
 *      routes and form posts all arrive here first, so there is no
 *      write path that can be forgotten.
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

/** Methods that cannot change state, so are safe while impersonating. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function impersonationReadOnly(req: NextRequest): NextResponse {
  const isApi = req.nextUrl.pathname.startsWith("/api/");
  const body = {
    error: "read-only while impersonating",
    detail: "Stop impersonating to make changes as yourself.",
  };
  if (isApi) return NextResponse.json(body, { status: 403 });
  // A page form post: bounce back with a message the banner surfaces,
  // rather than a bare 403 the user cannot interpret.
  const url = new URL(req.nextUrl.pathname, req.nextUrl);
  url.searchParams.set("error", "Read-only while impersonating — stop first to make changes.");
  return NextResponse.redirect(url, { status: 303 });
}

export async function middleware(req: NextRequest) {
  const required = requiredPermFor(req.nextUrl.pathname);
  if (required === null) return NextResponse.next();   // public

  const jwt = req.cookies.get(COOKIE_NAME)?.value;
  if (!jwt) return unauthorized(req);

  try {
    const { payload } = await jwtVerify(jwt, secretBytes(), { algorithms: ["HS256"] });
    const perms = (payload.perms as string[]) || [];
    if (!required.some((p) => perms.includes(p))) return forbidden(req);

    // Read-only impersonation. `imp` is set only on an impersonated
    // session (lib/auth.ts), and every mutation in this app — server
    // action, API route, form post — is a non-GET, so refusing those
    // is sufficient and cannot be bypassed by adding a new action.
    if (payload.imp && !SAFE_METHODS.has(req.method)) {
      // ...except the way out, and the way to sign off entirely.
      // Blocking those would strand the admin in the impersonated
      // session until it expired.
      const path = req.nextUrl.pathname;
      if (path !== "/api/auth/impersonate/stop" && path !== "/api/auth/logout") {
        return impersonationReadOnly(req);
      }
    }
    return NextResponse.next();
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
