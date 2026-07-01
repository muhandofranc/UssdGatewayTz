/**
 * Top-of-page loading bar.
 *
 * Fires on every in-app link click and stops once the URL pathname
 * (or search params) actually change — a reliable proxy for "the new
 * page has committed". This gives the browser-native "something is
 * loading" feel that `useLinkStatus`-based per-link spinners miss
 * when Next.js prefetches the destination (which is most of the
 * time — prefetched clicks navigate instantly with no visible
 * pending state).
 *
 * How it works:
 *  * A delegated click handler on the document catches clicks on
 *    same-origin, non-hash `<a>` elements. External / hash / target-
 *    blank links are ignored — they don't produce SPA navigations.
 *  * On such a click we flip `pending` on, which renders the bar.
 *  * When usePathname/useSearchParams change we flip it off, since
 *    the destination page is now rendering.
 *  * A safety timeout hides the bar if a click somehow doesn't lead
 *    to a route change (form action, modifier-click, etc.) so we
 *    don't leave an orphaned bar on screen.
 */
"use client";

import { useEffect, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

const SAFETY_HIDE_MS = 8000;

export default function TopProgress() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, setPending] = useState(false);

  // Show the bar on any in-app link click.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      // Ignore modifier-clicks (new tab / new window / download).
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      const anchor = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor) return;
      // Ignore explicit "open in new tab" targets and download links.
      if (anchor.target && anchor.target !== "" && anchor.target !== "_self") return;
      if (anchor.hasAttribute("download")) return;

      const href = anchor.getAttribute("href") || "";
      if (!href || href.startsWith("#")) return;

      // Same-origin check — external URLs cause a full document swap,
      // not an SPA transition, so no bar is needed.
      let url: URL;
      try {
        url = new URL(anchor.href, window.location.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin) return;

      // Ignore no-op self-links (same URL as current).
      if (url.pathname === window.location.pathname
          && url.search === window.location.search
          && url.hash === window.location.hash) return;

      setPending(true);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  // Hide the bar as soon as the URL commits to the new route.
  useEffect(() => {
    setPending(false);
  }, [pathname, searchParams]);

  // Safety net — if a click didn't actually route, don't leave the
  // bar spinning forever.
  useEffect(() => {
    if (!pending) return;
    const t = window.setTimeout(() => setPending(false), SAFETY_HIDE_MS);
    return () => window.clearTimeout(t);
  }, [pending]);

  if (!pending) return null;
  return (
    <div
      aria-hidden
      className="fixed left-0 right-0 top-0 z-[100] h-[3px] overflow-hidden pointer-events-none"
    >
      <div className="h-full w-1/3 bg-onfon-red animate-top-progress" />
    </div>
  );
}
