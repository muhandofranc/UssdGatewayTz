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

import Link from "next/link";
import { usePathname } from "next/navigation";

export interface NavItem {
  href: string;
  label: string;
  matchPrefix?: string;     // mark active when pathname starts with this
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
            className={[
              "rounded-md px-3 py-2 transition-colors",
              active
                ? "bg-onfon-red text-white font-medium shadow-brand-focus"
                : "text-slate-300 hover:bg-onfon-red/15 hover:text-white",
            ].join(" ")}
          >
            {it.label}
          </Link>
        );
      })}
    </nav>
  );
}
