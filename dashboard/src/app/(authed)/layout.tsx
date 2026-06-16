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
    { href: "/sessions",    label: "Sessions",    matchPrefix: "/sessions"    },  // per-session summary
    { href: "/reports",     label: "Legs",        matchPrefix: "/reports"     },  // per-HTTP-leg detail
    { href: "/exports",     label: "Exports",     matchPrefix: "/exports"     },  // queued CSV jobs
    { href: "/integration", label: "Integration", matchPrefix: "/integration" },  // handler-URL contract docs
  ];
  if (hasPerm(session, Perms.SHORTCODES_MANAGE)) {
    items.push({ href: "/shortcodes", label: "Shortcodes", matchPrefix: "/shortcodes" });
    items.push({ href: "/operators",  label: "Operators",  matchPrefix: "/operators"  });
  } else {
    // Clients (no SHORTCODES_MANAGE) get a slim owner-only view where they
    // can flip their own shortcodes between active/maintenance and set
    // the on-air message.
    items.push({ href: "/my-shortcodes", label: "My shortcodes", matchPrefix: "/my-shortcodes" });
  }
  if (hasPerm(session, Perms.PORTAL_USERS_MANAGE)) {
    items.push({ href: "/users", label: "Portal users", matchPrefix: "/users" });
  }

  return (
    <div className="min-h-screen md:grid md:grid-cols-[14rem_1fr]">
      {/* Sidebar — same dark slate as the topbar, edge-to-edge from
       * the very top so the chrome reads as one continuous surface;
       * the main content area pops in light. Brand identity is
       * carried by the Onfon "O" logo + gradient-clipped wordmark
       * below, not a coloured strip. */}
      <aside className="hidden md:flex md:flex-col border-r border-slate-800 bg-slate-900 text-slate-200 sticky top-0 h-screen">
        <div className="px-4 py-4 border-b border-slate-800">
          <Link href="/" className="flex items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.svg" alt="" width={28} height={28} className="rounded-md" />
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
              {hasPerm(session, Perms.SHORTCODES_MANAGE)
                ? <Link href="/shortcodes" className="hover:text-onfon-red transition-colors">Shortcodes</Link>
                : null}
              {hasPerm(session, Perms.PORTAL_USERS_MANAGE)
                ? <Link href="/users" className="hover:text-onfon-red transition-colors">Users</Link>
                : null}
            </nav>
            <div className="ml-auto flex items-center gap-3 text-sm">
              <span className="text-slate-300">
                {session.name} · <span className="font-mono text-white">{session.role}</span>
              </span>
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
        <main className="flex-1 px-6 py-6">{children}</main>
      </div>
    </div>
  );
}
