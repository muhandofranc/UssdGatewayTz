/**
 * Permission catalogue + route→permission map.
 *
 * Permission keys MUST match the seed rows in db/001_init.sql +
 * db/010_roles_auditor_viewer.sql:
 *   reports.view_own       view sessions only for owned shortcodes
 *   reports.view_all       view ALL shortcodes' sessions
 *   shortcodes.view        list/detail shortcodes (read-only)        [010]
 *   shortcodes.manage      create/edit shortcodes
 *   operators.view         list/detail operators (read-only)         [010]
 *   portal_users.view      list/detail portal users (read-only)      [010]
 *   portal_users.manage    create/edit dashboard users
 *   viewers.manage_own     Admin grants read-only viewers on OWN     [010]
 *                          shortcodes; data-level scope check in
 *                          users.ts enforces "own shortcodes only"
 *
 * The edge middleware uses `requiredPermFor()` to gate every request
 * BEFORE it hits a server component / route handler. Same predicate
 * runs server-side for defence-in-depth.
 *
 * Read-vs-write enforcement: requiredPermFor() is route-level (not
 * method-aware). A listing route accepts EITHER the .view OR the
 * .manage perm so an auditor can reach the page; the POST/PATCH/
 * DELETE handlers do their own .manage check on top so write actions
 * still bounce off an auditor / client_viewer.
 */
export const Perms = {
  REPORTS_VIEW_OWN:    "reports.view_own",
  REPORTS_VIEW_ALL:    "reports.view_all",
  SHORTCODES_VIEW:     "shortcodes.view",
  SHORTCODES_MANAGE:   "shortcodes.manage",
  OPERATORS_VIEW:      "operators.view",
  PORTAL_USERS_VIEW:   "portal_users.view",
  PORTAL_USERS_MANAGE: "portal_users.manage",
  VIEWERS_MANAGE_OWN:  "viewers.manage_own",
  AUDIT_VIEW:          "audit.view",
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
  // Integration guide — the handler-URL contract is something
  // prospective clients need to read BEFORE they have a portal
  // account, so the route stays open. No DB hit, no per-user state;
  // the page is a static reference document (moved out of (authed)/
  // 2026-06-29 for this reason).
  if (pathname === "/integration" || pathname.startsWith("/integration/")) {
    return null;
  }

  // Reports + sessions summary — either perm satisfies; the per-row
  // filter is what narrows the result set for `client`. /reports is
  // per-leg, /sessions is per-session rollup, /summary is the
  // pre-aggregated daily rollup (db/015), same underlying data + ACL.
  if (pathname === "/"
      || pathname.startsWith("/reports") || pathname.startsWith("/sessions")
      || pathname.startsWith("/summary")
      || pathname.startsWith("/api/reports") || pathname.startsWith("/api/sessions")
      || pathname.startsWith("/api/summary")) {
    return [Perms.REPORTS_VIEW_OWN, Perms.REPORTS_VIEW_ALL];
  }

  if (pathname.startsWith("/shortcodes") || pathname.startsWith("/api/shortcodes")) {
    // .view satisfies the route gate (auditor reaches the list +
    // detail pages); the write handlers re-check .manage.
    return [Perms.SHORTCODES_VIEW, Perms.SHORTCODES_MANAGE];
  }
  // Operators admin: .view for auditor; .manage (operators have no
  // separate manage perm yet — managed via shortcodes.manage since
  // both are gateway routing config) for super_admin writes.
  if (pathname.startsWith("/operators") || pathname.startsWith("/api/operators")) {
    return [Perms.OPERATORS_VIEW, Perms.SHORTCODES_MANAGE];
  }
  // Exports — anyone with a session can request/download their OWN
  // exports; per-row enforcement is via the shortcode allowlist
  // baked into the filter JSON at enqueue time.
  if (pathname.startsWith("/exports") || pathname.startsWith("/api/exports")) {
    return [Perms.REPORTS_VIEW_OWN, Perms.REPORTS_VIEW_ALL];
  }
  // Portal users: gate-passes for super_admin (manage), auditor
  // (view), AND client/Admin (viewers.manage_own, scoped to their
  // own shortcodes in users.ts). The write handlers re-check.
  if (pathname.startsWith("/users") || pathname.startsWith("/api/users")) {
    return [
      Perms.PORTAL_USERS_VIEW,
      Perms.PORTAL_USERS_MANAGE,
      Perms.VIEWERS_MANAGE_OWN,
    ];
  }
  // Audit log — super_admin only (granted via db/011).
  if (pathname.startsWith("/audit") || pathname.startsWith("/api/audit")) {
    return [Perms.AUDIT_VIEW];
  }
  // Anything else under (authed)/ → require at minimum a session
  // (any perm). Returning empty array means "must be logged in but
  // any perm passes". We use REPORTS_VIEW_OWN as the lowest-common
  // requirement.
  return [Perms.REPORTS_VIEW_OWN, Perms.REPORTS_VIEW_ALL];
}
