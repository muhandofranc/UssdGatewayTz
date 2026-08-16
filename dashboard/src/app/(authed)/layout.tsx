/**
 * Authed shell — left sidebar (logo + nav, RBAC-filtered) + top
 * bar (user chip + logout) + main content. Defence-in-depth: even
 * if the edge middleware were misconfigured, this layout would
 * re-check the session and redirect away. The middleware's job is
 * cheap front-line filtering; this is the second wall.
 *
 * Sidebar is hidden on small viewports — the topbar links still
 * work because they're routed by the same href set; the sidebar's
 * a fixed 14rem column on md+ screens.
 */
import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession, hasPerm } from "@/lib/auth";
import { Perms } from "@/lib/rbac";
import SidebarNav, { type NavItem } from "./_nav";
import ThemeToggle from "@/components/ThemeToggle";
import TopProgress from "./_topProgress";
import SearchProgress from "./_searchProgress";

export default async function AuthedLayout({
  children,
}: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/login");

  // RBAC-filtered nav. Overview + Sessions are always shown
  // (everyone with a session has at least reports.view_own).
  // Admin sections only for users that carry the matching perm.
  const items: NavItem[] = [
    { href: "/",            label: "Overview" },                                  // exact "/" match
    { href: "/summary",     label: "Reports Summary",     matchPrefix: "/summary"     },  // pre-aggregated daily rollup
    { href: "/sessions",    label: "Sessions",    matchPrefix: "/sessions"    },  // per-session summary
    { href: "/reports",     label: "Session Hops",        matchPrefix: "/reports"     },  // per-HTTP-leg detail
    { href: "/exports",     label: "Download Exports",     matchPrefix: "/exports"     },  // queued CSV jobs
    { href: "/integration", label: "Integration Document", matchPrefix: "/integration" },  // handler-URL contract docs
    { href: "/simulator",   label: "Handler Simulator",    matchPrefix: "/simulator"   },  // test your handler URL live
  ];
  // Shortcodes/Operators sidebar: show for super_admin (manage) AND
  // auditor (view-only). Client/Admin sees their slim "My shortcodes"
  // owner view; client_viewer sees neither.
  const canSeeShortcodesAdmin =
    hasPerm(session, Perms.SHORTCODES_MANAGE) || hasPerm(session, Perms.SHORTCODES_VIEW);
  const canSeeOperatorsAdmin =
    hasPerm(session, Perms.SHORTCODES_MANAGE) || hasPerm(session, Perms.OPERATORS_VIEW);
  if (canSeeShortcodesAdmin) {
    items.push({ href: "/shortcodes", label: "Shortcodes", matchPrefix: "/shortcodes" });
  }
  if (canSeeOperatorsAdmin) {
    items.push({ href: "/operators",  label: "Operators",  matchPrefix: "/operators"  });
  }
  // "My shortcodes": only for the Admin/client (they own shortcodes
  // they can put into maintenance). Auditor sees the global list
  // instead; client_viewer doesn't own anything.
  if (!canSeeShortcodesAdmin && session.role === "client") {
    items.push({ href: "/my-shortcodes", label: "My shortcodes", matchPrefix: "/my-shortcodes" });
  }
  // Users sidebar: super_admin (manage), auditor (view), AND
  // client/Admin (viewers.manage_own — manages their own read-only
  // viewers via the same /users page, scoped server-side).
  if (
    hasPerm(session, Perms.PORTAL_USERS_MANAGE)
    || hasPerm(session, Perms.PORTAL_USERS_VIEW)
    || hasPerm(session, Perms.VIEWERS_MANAGE_OWN)
  ) {
    items.push({ href: "/users", label: "Portal users", matchPrefix: "/users" });
  }
  // Audit log — super_admin only (db/011).
  if (hasPerm(session, Perms.AUDIT_VIEW)) {
    items.push({ href: "/audit", label: "Audit log", matchPrefix: "/audit" });
  }

  // Up-to-2-letter avatar initials from the display name.
  const initials =
    (session.name || "?")
      .split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join("").toUpperCase() || "?";

  return (
    <div className="min-h-screen md:grid md:grid-cols-[14rem_1fr]">
      <TopProgress />
      <SearchProgress />
      {/* Sidebar — same dark slate as the topbar, edge-to-edge from
       * the very top so the chrome reads as one continuous surface;
       * the main content area pops in light. Brand identity: a slim
       * rainbow strip up top + the Onfon "O" logo + gradient wordmark. */}
      <aside className="hidden md:flex md:flex-col border-r border-slate-800 bg-slate-900 text-slate-200 sticky top-0 h-screen">
        <div className="h-1 bg-brand-gradient" />
        <div className="px-4 py-4 border-b border-slate-800">
          <Link href="/" className="flex items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.svg" alt="" width={28} height={28} className="rounded-md ring-1 ring-white/10" />
            <div className="flex flex-col leading-tight">
              <span className="font-semibold text-base brand-text">UssdGatewayTz</span>
              <span className="text-[10px] uppercase tracking-wider text-slate-400">
                TZ MNO USSD gateway
              </span>
            </div>
          </Link>
        </div>
        <SidebarNav items={items} />
        <div className="mt-auto p-3 text-[11px] text-slate-500 border-t border-slate-800">
          v0.1.0 · dev
        </div>
      </aside>

      {/* Right column: topbar + main */}
      <div className="flex flex-col min-h-screen">
        {/* Topbar — dark slate (the black hue from the Onfon Media
         * wordmark + the asymmetric halo around the O). Sober, won't
         * fight content for attention; brand identity is carried by
         * the red 1-px rainbow strip on the sidebar and the
         * red-highlighted active nav, not by a vivid topbar. */}
        <header className="sticky top-0 z-10 border-b border-slate-800 bg-slate-900 text-white">
          <div className="h-1 bg-slate-900 md:hidden" aria-hidden="true" />
          <div className="px-4 py-3 flex items-center gap-4">
            {/* Mobile-only inline nav (sidebar hidden < md). White
             * links, hover tints to brand red so the navy stays calm
             * while still feeling clickable. */}
            <nav className="flex md:hidden items-center gap-3 text-sm">
              <Link href="/"            className="hover:text-onfon-red transition-colors">Overview</Link>
              <Link href="/sessions"    className="hover:text-onfon-red transition-colors">Sessions</Link>
              <Link href="/reports"     className="hover:text-onfon-red transition-colors">Legs</Link>
              <Link href="/integration" className="hover:text-onfon-red transition-colors">Integration</Link>
              <Link href="/simulator"   className="hover:text-onfon-red transition-colors">Simulator</Link>
              {canSeeShortcodesAdmin
                ? <Link href="/shortcodes" className="hover:text-onfon-red transition-colors">Shortcodes</Link>
                : null}
              {(hasPerm(session, Perms.PORTAL_USERS_MANAGE)
                || hasPerm(session, Perms.PORTAL_USERS_VIEW)
                || hasPerm(session, Perms.VIEWERS_MANAGE_OWN))
                ? <Link href="/users" className="hover:text-onfon-red transition-colors">Users</Link>
                : null}
            </nav>
            <div className="ml-auto flex items-center gap-3 text-sm">
              <div className="flex items-center gap-2">
                <div className="flex h-7 w-7 items-center justify-center rounded-full bg-onfon-red/25 text-[11px] font-semibold text-white ring-1 ring-white/15">
                  {initials}
                </div>
                <div className="hidden sm:flex flex-col leading-tight">
                  <span className="text-slate-100">{session.name}</span>
                  <span className="font-mono text-[10px] uppercase tracking-wider text-slate-400">{session.role}</span>
                </div>
              </div>
              <ThemeToggle />
              <form action="/api/auth/logout" method="post">
                <button
                  type="submit"
                  className="rounded-md border border-slate-600 px-2.5 py-1 text-xs text-slate-100 hover:bg-slate-800 hover:border-slate-500 transition-colors"
                >
                  Sign out
                </button>
              </form>
            </div>
          </div>
        </header>
        <main className="flex-1 px-6 py-6">
          <div className="mx-auto w-full max-w-[100rem]">{children}</div>
        </main>
      </div>
    </div>
  );
}
