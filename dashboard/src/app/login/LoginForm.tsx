/**
 * Login form — client component. Wrapped in <Suspense> by the page
 * because useSearchParams() forces dynamic rendering.
 *
 * POSTs to /api/auth/login which sets the JWT cookie + returns either
 *   { ok: true, next: "..." }   or   { error: "..." }
 *
 * Errors render inline; no leaky 401 vs 403 distinction (the API
 * returns a generic message either way to avoid account-enumeration).
 */
"use client";

import { useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export default function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const nextHref = params.get("next") || "/";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const resp = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, next: nextHref }),
      });
      if (resp.ok) {
        const j = await resp.json().catch(() => ({}));
        router.push(j.next || nextHref);
        router.refresh();
        return;
      }
      const j = await resp.json().catch(() => ({}));
      setError(j.error || "Login failed");
    });
  }

  return (
    <form
      onSubmit={onSubmit}
      className="w-full max-w-sm space-y-4 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 shadow-sm"
    >
      <div className="flex items-center gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo.svg" alt="" width={36} height={36} className="rounded-md" />
        <div>
          <h1 className="text-xl font-semibold leading-tight">UssdGatewayTz</h1>
          <p className="text-xs text-slate-500">Sign in to view reports.</p>
        </div>
      </div>

      <div className="space-y-1">
        <label className="text-sm font-medium" htmlFor="email">Email</label>
        <input
          id="email" name="email" type="email" autoComplete="username"
          required value={email} onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-transparent px-3 py-2 text-sm"
        />
      </div>

      <div className="space-y-1">
        <label className="text-sm font-medium" htmlFor="password">Password</label>
        <input
          id="password" name="password" type="password" autoComplete="current-password"
          required value={password} onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-transparent px-3 py-2 text-sm"
        />
      </div>

      {error ? (
        <div className="rounded-md bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      ) : null}

      <button
        type="submit" disabled={pending}
        className="w-full rounded-md bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 px-3 py-2 text-sm font-medium disabled:opacity-50"
      >
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
