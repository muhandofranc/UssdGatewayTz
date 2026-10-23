/**
 * Forgot-password form. The API answers the same way whether or not the
 * email has an account, so the confirmation is worded "if".
 */
"use client";

import { useState, useTransition } from "react";
import { AuthError, AuthNotice, authButtonClass, authInputClass } from "@/components/AuthShell";

export default function ForgotForm() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [pending, startTransition] = useTransition();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const resp = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const j = await resp.json().catch(() => ({}));
      if (resp.ok) setSent(true);
      else setError(j.error || "Something went wrong. Try again.");
    });
  }

  if (sent) {
    return (
      <AuthNotice>
        If an account exists for <span className="font-mono">{email}</span>, a
        reset link is on its way. It expires in 30 minutes. Check your spam
        folder if it doesn&apos;t arrive.
      </AuthNotice>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <p className="text-sm text-slate-600 dark:text-slate-300">
        Enter your account email and we&apos;ll send you a link to choose a
        new password.
      </p>
      <div className="space-y-1.5">
        <label className="text-sm font-medium" htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="username" required
               value={email} onChange={(e) => setEmail(e.target.value)} className={authInputClass} />
      </div>
      {error ? <AuthError>{error}</AuthError> : null}
      <button type="submit" disabled={pending} className={authButtonClass}>
        {pending ? "Sending…" : "Send reset link"}
      </button>
    </form>
  );
}
