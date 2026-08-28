/**
 * The dialog shell for intercepted edit routes.
 *
 * Paired with Next's parallel + intercepting routes: clicking Edit in a
 * list renders the edit route into the `@modal` slot as an overlay,
 * while the URL becomes the real edit URL. A refresh, a pasted link, or
 * a crawler therefore gets the full standalone page — the modal is a
 * presentation of a route that still exists on its own, not a
 * replacement for one.
 *
 * Dismissing calls router.back(), which pops the intercepted entry and
 * restores the list underneath. That is why closing must never be a
 * <Link> to the list: it would push a new entry and leave the modal in
 * the history for the Back button to reopen.
 */
"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

export default function Modal({
  title, children,
}: { title: string; children: React.ReactNode }) {
  const router = useRouter();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") router.back(); };
    document.addEventListener("keydown", onKey);
    // Stop the list behind from scrolling while the dialog is open —
    // otherwise a wheel gesture over the backdrop moves the page under
    // the form, which reads as the dialog drifting.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Move focus into the panel so keyboard and screen-reader users
    // land inside the dialog rather than at the top of the list behind.
    panelRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [router]);

  return (
    <div
      className="fixed inset-0 z-[95] flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4 backdrop-blur-[2px] sm:p-8"
      // Backdrop click closes; clicks inside the panel must not, so the
      // handler checks the event landed on the backdrop itself.
      onMouseDown={(e) => { if (e.target === e.currentTarget) router.back(); }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-3xl rounded-2xl border border-slate-200 bg-white shadow-2xl outline-none dark:border-slate-800 dark:bg-slate-900"
      >
        <div className="flex items-center justify-between gap-4 border-b border-slate-200 px-5 py-3 dark:border-slate-800">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button
            type="button"
            onClick={() => router.back()}
            aria-label="Close"
            className="rounded-md px-2 py-1 text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-slate-800 dark:hover:text-slate-100"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                 className="h-4 w-4" aria-hidden>
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  );
}
