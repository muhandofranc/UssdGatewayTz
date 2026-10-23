/**
 * Reset form. Reads the token from the URL fragment, then strips it from
 * the address bar (history.replaceState) so it doesn't linger in the
 * tab's history or get copied along with the URL.
 */
"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AuthError, authButtonClass, authInputClass } from "@/components/AuthShell";

type State = "checking" | "invalid" | "ready";

export default function ResetForm() {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [state, setState] = useState<State>("checking");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const readOnce = useRef(false);

  useEffect(() => {
    // Strict mode runs effects twice in dev; the second run would find
    // the fragment already stripped and call a good link invalid.
    if (readOnce.current) return;
    readOnce.current = true;
    const t = new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "";
    window.history.replaceState(null, "", window.location.pathname);
    setToken(t);
    if (!t) { setState("invalid"); return; }
    fetch("/api/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: t, check: true }),
    })
      .then((r) => r.json())
      .then((j) => setState(j.valid ? "ready" : "invalid"))
      .catch(() => setState("invalid"));
  }, []);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const resp = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password, password_confirm: confirm }),
      });
      if (resp.ok) {
        router.push("/login?reset=1");
        return;
      }
      const j = await resp.json().catch(() => ({}));
      setError(j.error || "Something went wrong. Try again.");
    });
  }

  if (state === "checking") {
    return <p className="text-sm text-slate-500">Checking your link…</p>;
  }
  if (state === "invalid") {
    return (
      <AuthError>
        This reset link is invalid or has expired. Links work once, for 30
        minutes.{" "}
        <Link href="/forgot-password" className="underline">Request a new one</Link>.
      </AuthError>
    );
  }
  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <div className="space-y-1.5">
        <label className="text-sm font-medium" htmlFor="password">New password</label>
        <input id="password" type="password" autoComplete="new-password" required minLength={8} maxLength={72}
               value={password} onChange={(e) => setPassword(e.target.value)} className={authInputClass} />
      </div>
      <div className="space-y-1.5">
        <label className="text-sm font-medium" htmlFor="password_confirm">Confirm new password</label>
        <input id="password_confirm" type="password" autoComplete="new-password" required minLength={8} maxLength={72}
               value={confirm} onChange={(e) => setConfirm(e.target.value)} className={authInputClass} />
      </div>
      <p className="text-xs text-slate-500">
        At least 8 characters. This signs you out on every device.
      </p>
      {error ? <AuthError>{error}</AuthError> : null}
      <button type="submit" disabled={pending} className={authButtonClass}>
        {pending ? "Saving…" : "Set new password"}
      </button>
    </form>
  );
}
