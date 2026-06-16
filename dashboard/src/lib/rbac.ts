/**
 * Permission catalogue + route→permission map.
 *
 * Permission keys MUST match the seed rows in db/001_init.sql:
 *   reports.view_own       view sessions only for owned shortcodes
 *   reports.view_all       view ALL shortcodes' sessions (super_admin)
 *   shortcodes.manage      create/edit shortcodes
 *   portal_users.manage    create/edit dashboard users
 *
 * The edge middleware uses `requiredPermFor()` to gate every request
 * BEFORE it hits a server component / route handler. Same predicate
 * runs server-side for defence-in-depth.
 */
export const Perms = {
  REPORTS_VIEW_OWN:    "reports.view_own",
  REPORTS_VIEW_ALL:    "reports.view_all",
  SHORTCODES_MANAGE:   "shortcodes.manage",
  PORTAL_USERS_MANAGE: "portal_users.manage",
} as const;

export type PermKey = (typeof Perms)[keyof typeof Perms];

/**
 * Returns the perm key required for a pathname, or null if the route
 * is public (login, static assets, health). Match longest-prefix
 * first.
 *
 * Either of `reports.view_own` / `reports.view_all` clears the
 * reports route — the per-row shortcode allowlist is applied in the
 * data query itself.
 */
export function requiredPermFor(pathname: string): PermKey[] | null {
  // Public endpoints — no auth at all.
  if (pathname === "/login") return null;
  if (pathname === "/api/auth/login") return null;
  if (pathname === "/api/auth/logout") return null; // logout is its own self-check
  if (pathname === "/healthz") return null;
  if (pathname.startsWith("/_next/")) return null;
  if (pathname.startsWith("/favicon")) return null;

  // Reports + sessions summary — either perm satisfies; the per-row
  // filter is what narrows the result set for `client`. /reports is
  // per-leg, /sessions is per-session rollup, same underlying data.
  if (pathname === "/"
      || pathname.startsWith("/reports") || pathname.startsWith("/sessions")
      || pathname.startsWith("/api/reports") || pathname.startsWith("/api/sessions")) {
    return [Perms.REPORTS_VIEW_OWN, Perms.REPORTS_VIEW_ALL];
  }

  if (pathname.startsWith("/shortcodes") || pathname.startsWith("/api/shortcodes")) {
    return [Perms.SHORTCODES_MANAGE];
  }
  // Operators admin shares the shortcodes.manage perm (both are
  // gateway routing config) rather than introducing a new perm key.
  if (pathname.startsWith("/operators") || pathname.startsWith("/api/operators")) {
    return [Perms.SHORTCODES_MANAGE];
  }
  // Exports — anyone with a session can request/download their OWN
  // exports; per-row enforcement is via the shortcode allowlist
  // baked into the filter JSON at enqueue time.
  if (pathname.startsWith("/exports") || pathname.startsWith("/api/exports")) {
    return [Perms.REPORTS_VIEW_OWN, Perms.REPORTS_VIEW_ALL];
  }
  if (pathname.startsWith("/users") || pathname.startsWith("/api/users")) {
    return [Perms.PORTAL_USERS_MANAGE];
  }
  // Anything else under (authed)/ → require at minimum a session
  // (any perm). Returning empty array means "must be logged in but
  // any perm passes". We use REPORTS_VIEW_OWN as the lowest-common
  // requirement.
  return [Perms.REPORTS_VIEW_OWN, Perms.REPORTS_VIEW_ALL];
}
