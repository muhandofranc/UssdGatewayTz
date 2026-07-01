/**
 * Left-sidebar nav items. Client component so we can highlight the
 * active route via usePathname() — server can't see the URL without
 * a custom header. Items are passed in from the server layout (with
 * RBAC already applied) so this file stays auth-unaware.
 *
 * Styling — sidebar sits on dark slate (matches the topbar). Active
 * item uses the Onfon brand red so it pops against the dark column;
 * inactive items are light slate text with a subtle brand-red hover.
 */
"use client";

import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";

export interface NavItem {
  href: string;
  label: string;
  matchPrefix?: string;     // mark active when pathname starts with this
}

/**
 * Per-link pending indicator. `useLinkStatus()` fires the moment a
 * `<Link>` starts a client-side navigation and turns off when the
 * new route's RSC render lands — that's earlier than any pathname-
 * change observation, so the user sees the spinner INSTANTLY on
 * click.
 *
 * The hook must be called INSIDE a `<Link>` child; that's why it
 * lives in its own component here.
 */
function NavPendingSpinner() {
  const { pending } = useLinkStatus();
  if (!pending) return null;
  return (
    <span
      role="progressbar"
      aria-label="Loading"
      className="ml-2 inline-block h-4 w-4 rounded-full border-2 border-white border-t-transparent animate-spin align-middle drop-shadow-sm"
    />
  );
}

export default function SidebarNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname() || "/";
  return (
    <nav className="flex flex-col gap-1 p-3 text-sm">
      {items.map((it) => {
        const active = it.matchPrefix
          ? (it.matchPrefix === "/" ? pathname === "/" : pathname.startsWith(it.matchPrefix))
          : pathname === it.href;
        return (
          <Link
            key={it.href}
            href={it.href}
            // `prefetch` is on by default but explicit here so a
            // future Next.js default change doesn't silently defeat
            // the pending-spinner UX (prefetch happens on hover +
            // viewport-enter; `pending` fires only for the actual
            // click navigation).
            prefetch
            className={[
              "rounded-md px-3 py-2 transition-colors flex items-center justify-between gap-2",
              active
                ? "bg-onfon-red text-white font-medium shadow-brand-focus"
                : "text-slate-300 hover:bg-onfon-red/15 hover:text-white",
            ].join(" ")}
          >
            <span>{it.label}</span>
            <NavPendingSpinner />
          </Link>
        );
      })}
    </nav>
  );
}
