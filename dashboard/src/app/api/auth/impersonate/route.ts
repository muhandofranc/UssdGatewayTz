/**
 * POST /api/auth/impersonate       { userId }  → start viewing as that user
 * POST /api/auth/impersonate/stop              → return to your own session
 *
 * Read-only impersonation for support: see exactly what a user sees,
 * without asking them for a password or resetting it.
 *
 * Why these live as API routes rather than server actions: middleware
 * refuses every non-GET request while impersonating (that is what makes
 * it read-only), and a server action POSTs to the page's own URL — so
 * exempting the stop action would mean exempting every POST to that
 * page. A dedicated path is the only thing narrow enough to exempt.
 *
 * Guards, in order:
 *   - same-origin (CSRF), as with login
 *   - the caller holds portal_users.impersonate
 *   - not already impersonating (no chains — stop first, so the audit
 *     trail is always a flat actor→target pair)
 *   - target exists, is active, and is not yourself
 * and the claims themselves intersect perms with the caller's, so this
 * can only ever narrow what the session may do (see lib/auth.ts).
 */
import { NextResponse } from "next/server";
import {
  getSession, loadUserClaims, signSession, setSessionCookie,
  impersonatedClaims, hasPerm, IMPERSONATION_TTL_SECONDS,
} from "@/lib/auth";
import { Perms } from "@/lib/rbac";
import { audit, clientIp } from "@/lib/audit";
import { validateSameOrigin } from "@/lib/csrf";
import { query } from "@/lib/db";

export async function POST(req: Request) {
  const ip = clientIp(req);
  const ua = req.headers.get("user-agent");

  if (!validateSameOrigin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  if (!hasPerm(session, Perms.PORTAL_USERS_IMPERSONATE)) {
    await audit({
      actor: session.email, action: "impersonation.start", outcome: "denied",
      ip, userAgent: ua, detail: { reason: "missing_perm" },
    });
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // No chains. An impersonated session must stop before starting
  // another, so every audit pair is a flat actor→target and the banner
  // never has to explain a stack.
  if (session.imp) {
    return NextResponse.json(
      { error: "already impersonating — stop first" }, { status: 409 },
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any;
  try { body = await req.json(); } catch { body = null; }
  const userId = parseInt(String(body?.userId ?? ""), 10);
  if (!Number.isFinite(userId) || userId <= 0) {
    return NextResponse.json({ error: "userId required" }, { status: 400 });
  }
  if (String(userId) === session.sub) {
    return NextResponse.json({ error: "cannot impersonate yourself" }, { status: 400 });
  }

  // loadUserClaims returns null for a missing OR inactive user, which
  // is the check we want: a deactivated account should not be reachable
  // by the side door either.
  const target = await loadUserClaims(userId);
  if (!target) {
    await audit({
      actor: session.email, action: "impersonation.start", outcome: "failure",
      target: String(userId), ip, userAgent: ua,
      detail: { reason: "target_not_found_or_inactive" },
    });
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }

  const claims = impersonatedClaims(session, target);

  // If the intersection leaves nothing, the impersonated session could
  // not render a page — and since the "forbidden" fallback redirects to
  // "/", which itself requires a perm, it would loop. Refuse up front
  // with something an operator can act on instead.
  if (claims.perms.length === 0) {
    await audit({
      actor: session.email, action: "impersonation.start", outcome: "denied",
      target: target.email, ip, userAgent: ua,
      detail: { reason: "no_overlapping_permissions", target_role: target.role },
    });
    return NextResponse.json({
      error: `you hold no permission in common with ${target.role} — nothing would be visible`,
    }, { status: 409 });
  }

  await setSessionCookie(await signSession(claims), IMPERSONATION_TTL_SECONDS);

  await audit({
    actor: session.email, action: "impersonation.start", outcome: "success",
    target: target.email, ip, userAgent: ua,
    detail: {
      target_user_id: userId, target_role: target.role,
      // What the impersonator can actually do, after the intersection —
      // the interesting fact if this trail is ever reviewed.
      effective_perms: claims.perms.length,
      read_only: true,
    },
  });

  return NextResponse.json({ ok: true, viewingAs: target.email });
}
