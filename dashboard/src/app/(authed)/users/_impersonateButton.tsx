/**
 * "View as" button on the /users list.
 *
 * A plain client-side POST rather than a server action: middleware
 * refuses non-GET requests while impersonating, and it exempts exactly
 * two paths — the stop endpoint and logout. A server action would post
 * to /users itself, which is not exempt, so starting a second
 * impersonation from within one would be blocked in a way that reads as
 * a bug. Going straight to the API keeps the rule legible.
 *
 * On success the whole page is reloaded, not refreshed: every server
 * component in the tree was rendered under the old identity.
 */
"use client";

import { useState } from "react";

export default function ImpersonateButton({
  userId, email, disabled,
}: { userId: number; email: string; disabled?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    // A deliberate speed bump. Impersonation is audited under the
    // admin's name, and clicking the wrong row means reading a
    // different client's traffic.
    if (!window.confirm(`View the dashboard as ${email}?\n\nRead-only, and recorded in the audit log.`)) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/auth/impersonate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        setError(body?.error ?? "could not start");
        setBusy(false);
        return;
      }
      window.location.href = "/";
    } catch {
      setError("could not start");
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-1">
      {error ? <span className="text-rose-600 dark:text-rose-400">{error}</span> : null}
      <button
        onClick={go}
        disabled={busy || disabled}
        title={disabled
          ? "Inactive users cannot be impersonated"
          : `View the dashboard as ${email} (read-only, audited)`}
        className="underline text-amber-700 dark:text-amber-400 disabled:no-underline disabled:opacity-40"
      >
        {busy ? "Starting…" : "View as"}
      </button>
    </span>
  );
}
