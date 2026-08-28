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
 * This component listens for form submits and paints a top progress bar + a
 * status chip. Because a GET submit leaves the current document visible until
 * the new response commits, the chip stays up for the whole wait, then the new
 * page replaces it.
 *
 * Two kinds of submit, two messages:
 *   GET   — a filter search. Only the report pages have a date range worth
 *           warning about, so the wording is chosen per route rather than
 *           telling someone filtering /shortcodes that "a large date range
 *           can take a moment" when that form has no dates in it.
 *   POST  — a server action (create / save / promote). These used to be
 *           ignored entirely, which left a save with NO feedback at all: the
 *           button click did nothing visible until the redirect landed, and
 *           any latency read as "stuck". Forms posting to a real URL (the
 *           Sign-out form) are still skipped — React renders server-action
 *           forms with an empty action attribute, which is what tells them
 *           apart.
 */
"use client";

import { useEffect, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

// Report-pool queries can legitimately run for a couple of minutes on a huge
// window; keep the safety net longer than that so it never hides mid-search.
const SAFETY_HIDE_MS = 200_000;
// Server actions are single-digit-millisecond inserts; if one hasn't
// navigated within this long, the chip is lying and should get out of the way.
const SAVE_SAFETY_HIDE_MS = 20_000;

/** Routes whose filter form actually spans a date range. */
const DATE_RANGE_ROUTES = ["/sessions", "/reports", "/summary", "/audit"];

type Mode = null | "search" | "saving";

export default function SearchProgress() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [mode, setMode] = useState<Mode>(null);

  useEffect(() => {
    const onSubmit = (e: SubmitEvent) => {
      const form = e.target as HTMLFormElement | null;
      if (!form || form.tagName !== "FORM") return;
      // A submit button's formMethod overrides the form's method.
      const submitter = e.submitter as HTMLButtonElement | null;
      const method = (submitter?.formMethod || form.method || "get").toLowerCase();
      if (method === "get") { setMode("search"); return; }
      // POST: a server action renders with action="" (React posts back to the
      // current URL). A form with a real action URL — Sign-out — is a plain
      // navigation and needs no chip.
      const action = form.getAttribute("action");
      if (action === null || action === "") setMode("saving");
    };
    document.addEventListener("submit", onSubmit, true);
    return () => document.removeEventListener("submit", onSubmit, true);
  }, []);

  // Reset once navigation commits (URL changes). In the full-navigation case
  // the component remounts fresh anyway; this covers any SPA-style submit —
  // including the redirect a server action ends with.
  useEffect(() => { setMode(null); }, [pathname, searchParams]);

  // Safety net: a submit that doesn't navigate (client validation block, a
  // server action that redirects back to the SAME url with ?error=…)
  // shouldn't leave the chip stuck on screen.
  useEffect(() => {
    if (!mode) return;
    const t = window.setTimeout(
      () => setMode(null),
      mode === "saving" ? SAVE_SAFETY_HIDE_MS : SAFETY_HIDE_MS,
    );
    return () => window.clearTimeout(t);
  }, [mode]);

  if (!mode) return null;

  const message =
    mode === "saving"                                             ? "Saving\u2026"
    : DATE_RANGE_ROUTES.some((r) => pathname.startsWith(r))       ? "Searching\u2026 a large date range can take a moment."
    :                                                               "Searching\u2026";
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
        {message}
      </div>
    </>
  );
}
