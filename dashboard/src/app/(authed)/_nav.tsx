/**
 * Left-sidebar nav items. Client component so we can highlight the
 * active route via usePathname() — server can't see the URL without
 * a custom header. Items are passed in from the server layout (with
 * RBAC already applied) so this file stays auth-unaware.
 *
 * Styling — sidebar sits on dark slate (matches the topbar). Active
 * item uses the Onfon brand red so it pops against the dark column;
 * inactive items are light slate text with a subtle brand-red hover.
 *
 * Icons — each item carries an `icon` KEY (a plain string), not a
 * component. The layout that builds the item list is a SERVER
 * component and can't hand a function across the RSC boundary, so
 * the key→SVG lookup lives here on the client side.
 */
"use client";

import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/** Every icon the sidebar knows how to draw. */
export type NavIconKey =
  | "overview" | "summary" | "sessions" | "hops" | "exports"
  | "integration" | "simulator" | "shortcodes" | "operators"
  | "myShortcodes" | "users" | "audit";

export interface NavItem {
  href: string;
  label: string;
  icon: NavIconKey;
  matchPrefix?: string;     // mark active when pathname starts with this
}

/* ---------------------------------------------------------------- */
/*  Inline icons — no dependency; stroke follows the link's text     */
/*  colour, so they invert automatically on the active (red) item.   */
/*  Same 24-box / 1.8 stroke as the overview tiles, at h-4 to sit    */
/*  correctly against 14px nav text.                                 */
/* ---------------------------------------------------------------- */
function Svg({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
         strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"
         aria-hidden="true">
      {children}
    </svg>
  );
}

const NAV_ICONS: Record<NavIconKey, ReactNode> = {
  // Dashboard tiles
  overview: <Svg><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /></Svg>,
  // Bar chart — pre-aggregated rollup
  summary: <Svg><path d="M3 3v18h18" /><rect x="7" y="10" width="3" height="7" rx="1" /><rect x="13" y="6" width="3" height="11" rx="1" /></Svg>,
  // Pulse — live per-session traffic
  sessions: <Svg><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></Svg>,
  // Stacked layers — per-HTTP-leg detail
  hops: <Svg><path d="M12 3 3 8l9 5 9-5-9-5Z" /><path d="m3 12 9 5 9-5" /><path d="m3 16 9 5 9-5" /></Svg>,
  // Tray with down-arrow — queued CSV downloads
  exports: <Svg><path d="M12 3v12" /><path d="m7 11 5 5 5-5" /><path d="M3 17v2a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-2" /></Svg>,
  // Document — handler-URL contract docs
  integration: <Svg><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6" /><path d="M9 13h6" /><path d="M9 17h4" /></Svg>,
  // Beaker — test your handler live
  simulator: <Svg><path d="M9 3h6" /><path d="M10 3v6.5L5 18a2 2 0 0 0 1.7 3h10.6A2 2 0 0 0 19 18l-5-8.5V3" /><path d="M7 14h10" /></Svg>,
  // Hash — the *123# codes themselves
  shortcodes: <Svg><path d="M10 3 8 21" /><path d="M16 3l-2 18" /><path d="M3.5 8.5h17" /><path d="M3 15.5h17" /></Svg>,
  // Broadcast tower — MNOs
  operators: <Svg><path d="M12 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z" /><path d="M16.2 5.8a6 6 0 0 1 0 8.4" /><path d="M7.8 14.2a6 6 0 0 1 0-8.4" /><path d="M19 3a10 10 0 0 1 0 14" /><path d="M5 17A10 10 0 0 1 5 3" /><path d="m11 12-1 9h4l-1-9" /></Svg>,
  // Starred hash — the subset this client owns
  myShortcodes: <Svg><path d="m12 2 2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17l-5.9 3 1.2-6.5L2.5 8.9 9.1 8Z" /></Svg>,
  // People — portal accounts
  users: <Svg><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.9" /><path d="M16 3.1a4 4 0 0 1 0 7.8" /></Svg>,
  // Shield with tick — tamper-evident trail
  audit: <Svg><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" /><path d="m9 12 2 2 4-4" /></Svg>,
};

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
              "group rounded-md px-3 py-2 transition-colors flex items-center justify-between gap-2",
              active
                ? "bg-onfon-red text-white font-medium shadow-brand-focus"
                : "text-slate-300 hover:bg-onfon-red/15 hover:text-white",
            ].join(" ")}
          >
            <span className="flex min-w-0 items-center gap-2.5">
              {/* Dimmed when inactive so the label stays the focal
                  point; full-strength on the active/hovered row. */}
              <span className={active ? "shrink-0" : "shrink-0 text-slate-400 transition-colors group-hover:text-white"}>
                {NAV_ICONS[it.icon]}
              </span>
              <span className="truncate">{it.label}</span>
            </span>
            <NavPendingSpinner />
          </Link>
        );
      })}
    </nav>
  );
}
