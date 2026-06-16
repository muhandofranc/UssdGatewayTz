/**
 * Light/dark mode toggle. The current theme is reflected by the
 * `.dark` class on <html> (set initially by the no-flash script in
 * app/layout.tsx). On click we flip the class and persist the choice
 * to localStorage.
 *
 * Hydration: both icons (sun + moon) render server-side. CSS hides
 * the wrong one based on the dark/light class — no React state for
 * the visible icon, so server and client agree on first paint.
 */
"use client";

import { useCallback } from "react";

export default function ThemeToggle() {
  const flip = useCallback(() => {
    const html = document.documentElement;
    const next = !html.classList.contains("dark");
    html.classList.toggle("dark", next);
    try { localStorage.setItem("theme", next ? "dark" : "light"); } catch {}
  }, []);

  return (
    <button
      type="button"
      onClick={flip}
      aria-label="Toggle dark mode"
      title="Toggle dark mode"
      className="inline-flex items-center justify-center w-7 h-7 rounded-md border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300"
    >
      {/* Sun — visible in dark mode (click to go light) */}
      <svg
        className="hidden dark:block w-4 h-4"
        viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
      </svg>
      {/* Moon — visible in light mode (click to go dark) */}
      <svg
        className="block dark:hidden w-4 h-4"
        viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
      </svg>
    </button>
  );
}
