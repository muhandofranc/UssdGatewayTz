/**
 * Search progress indicator for the filter forms.
 *
 * The /reports and /sessions filter bars are native `<form method="get">`
 * elements — submitting them triggers a FULL-DOCUMENT navigation, which does
 * NOT engage the App Router's loading.tsx or the link-based _topProgress. On a
 * slow query (a wide date range now runs for many seconds on the report pool)
 * the browser keeps the old page frozen with no feedback, which reads as
 * "blank / hung".
 *
 * This component listens for GET form submits and paints a top progress bar +
 * a "Searching…" chip. Because a GET submit leaves the current document visible
 * until the new response commits, the chip stays up for the whole wait, then
 * the new page replaces it. POST submits (the Export CSV button → server
 * action, and the Sign-out form) are ignored — only a GET search navigates.
 */
"use client";

import { useEffect, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

// Report-pool queries can legitimately run for a couple of minutes on a huge
// window; keep the safety net longer than that so it never hides mid-search.
const SAFETY_HIDE_MS = 200_000;

export default function SearchProgress() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const onSubmit = (e: SubmitEvent) => {
      const form = e.target as HTMLFormElement | null;
      if (!form || form.tagName !== "FORM") return;
      // A submit button's formMethod overrides the form's method. The Export
      // button POSTs to a server action and the logout form POSTs — only a GET
      // submit is a filter search that does a full navigation worth indicating.
      const submitter = e.submitter as HTMLButtonElement | null;
      const method = (submitter?.formMethod || form.method || "get").toLowerCase();
      if (method !== "get") return;
      setSearching(true);
    };
    document.addEventListener("submit", onSubmit, true);
    return () => document.removeEventListener("submit", onSubmit, true);
  }, []);

  // Reset once navigation commits (URL changes). In the full-navigation case
  // the component remounts fresh anyway; this covers any SPA-style submit.
  useEffect(() => { setSearching(false); }, [pathname, searchParams]);

  // Safety net: a submit that doesn't navigate (client validation block, etc.)
  // shouldn't leave the chip stuck on screen.
  useEffect(() => {
    if (!searching) return;
    const t = window.setTimeout(() => setSearching(false), SAFETY_HIDE_MS);
    return () => window.clearTimeout(t);
  }, [searching]);

  if (!searching) return null;
  return (
    <>
      <div
        aria-hidden
        className="fixed left-0 right-0 top-0 z-[100] h-[3px] overflow-hidden pointer-events-none"
      >
        <div className="h-full w-1/3 bg-onfon-red animate-top-progress" />
      </div>
      <div
        role="status"
        aria-live="polite"
        className="fixed left-1/2 top-3 z-[100] -translate-x-1/2 flex items-center gap-2 rounded-full border border-slate-200 dark:border-slate-700 bg-white/95 dark:bg-slate-900/95 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 shadow-lg backdrop-blur"
      >
        <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-slate-300 border-t-onfon-red" />
        Searching&hellip; a large date range can take a moment.
      </div>
    </>
  );
}
