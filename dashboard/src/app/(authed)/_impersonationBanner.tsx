/**
 * The "you are viewing as someone else" banner.
 *
 * Deliberately loud and fixed to the top of the viewport. The failure
 * mode this guards against is an admin forgetting they are impersonating
 * and reading a client's narrowed reports as though it were the whole
 * estate — concluding traffic has stopped when they are simply looking
 * through a keyhole. It costs a strip of screen; that is the right
 * trade.
 *
 * Stop posts to /api/auth/impersonate/stop, which re-mints the admin's
 * own session, then hard-reloads: every server component on screen was
 * rendered for the impersonated user and must be re-fetched.
 */
"use client";

import { useState } from "react";

export default function ImpersonationBanner({
  viewingAs, realEmail,
}: { viewingAs: string; realEmail: string }) {
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function stop() {
    setStopping(true);
    setError(null);
    try {
      const r = await fetch("/api/auth/impersonate/stop", { method: "POST" });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        // The admin's own account was deactivated mid-session — there
        // is no session to return to, so sign out rather than leave
        // them stuck as someone else.
        if (body?.signOut) { window.location.href = "/api/auth/logout"; return; }
        setError(body?.error ?? "could not stop impersonating");
        setStopping(false);
        return;
      }
      // Full reload, not router.refresh(): the whole tree was rendered
      // under the other identity.
      window.location.href = "/";
    } catch {
      setError("could not stop impersonating");
      setStopping(false);
    }
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="sticky top-0 z-[90] flex flex-wrap items-center justify-between gap-2 border-b border-amber-300 dark:border-amber-800 bg-amber-100 dark:bg-amber-950/70 px-4 py-2 text-sm text-amber-900 dark:text-amber-100"
    >
      <span className="flex items-center gap-2">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
             className="h-4 w-4 shrink-0" aria-hidden>
          <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
        <span>
          Viewing as <strong className="font-mono">{viewingAs}</strong>
          {" — read-only. Signed in as "}
          <span className="font-mono">{realEmail}</span>.
        </span>
      </span>
      <span className="flex items-center gap-3">
        {error ? <span className="text-rose-700 dark:text-rose-300">{error}</span> : null}
        <button
          onClick={stop}
          disabled={stopping}
          className="rounded-md border border-amber-400 dark:border-amber-700 bg-white/70 dark:bg-amber-900/40 px-2.5 py-1 text-xs font-medium hover:bg-white disabled:opacity-60"
        >
          {stopping ? "Stopping…" : "Stop impersonating"}
        </button>
      </span>
    </div>
  );
}
