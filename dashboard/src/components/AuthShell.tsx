/**
 * The signed-out page frame — brand backdrop + card with the logo
 * header — for /forgot-password and /reset-password. Matches the look
 * of /login (whose form draws its own card).
 */
import type { ReactNode } from "react";

export default function AuthShell({ subtitle, children }: { subtitle: string; children: ReactNode }) {
  return (
    <main className="relative min-h-screen grid place-items-center overflow-hidden p-6">
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute inset-x-0 top-0 h-1 bg-brand-gradient" />
        <div className="absolute left-1/2 top-[-20%] h-[50rem] w-[50rem] -translate-x-1/2 rounded-full bg-onfon-red/5 blur-3xl dark:bg-onfon-red/10" />
      </div>
      <div className="w-full max-w-sm overflow-hidden rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-lg">
        <div className="h-1 bg-brand-gradient" />
        <div className="space-y-5 p-7">
          <div className="flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.svg" alt="" width={40} height={40} className="rounded-lg" />
            <div>
              <h1 className="text-xl font-semibold leading-tight brand-text">UssdGatewayTz</h1>
              <p className="text-xs text-slate-500">{subtitle}</p>
            </div>
          </div>
          {children}
        </div>
      </div>
      <p className="absolute bottom-4 text-[11px] text-slate-400">
        UssdGatewayTz · TZ MNO USSD gateway
      </p>
    </main>
  );
}

export const authInputClass =
  "w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent px-3 py-2 text-sm outline-none transition focus:border-onfon-red focus:shadow-brand-focus";

export const authButtonClass =
  "inline-flex w-full items-center justify-center gap-2 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 px-3 py-2.5 text-sm font-medium outline-none transition hover:opacity-90 focus:shadow-brand-focus disabled:opacity-50";

export function AuthError({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 px-3 py-2 text-sm text-red-700 dark:text-red-300">
      {children}
    </div>
  );
}

export function AuthNotice({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
      {children}
    </div>
  );
}
