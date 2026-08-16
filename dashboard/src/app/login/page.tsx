/**
 * /login — server-component wrapper. The form itself is a client
 * component (uses useSearchParams + state); Next 15 requires anything
 * reading the URL search params during static rendering to live inside
 * a Suspense boundary, otherwise prerender bails out.
 */
import { Suspense } from "react";
import LoginForm from "./LoginForm";

// Defence-in-depth: even if a deploy hits this without a SESSION_SECRET
// set, we never want to render a login UI that can't actually mint a
// session. The form lazy-fails on submit, which is OK for dev.
export default function LoginPage() {
  return (
    <main className="relative min-h-screen grid place-items-center overflow-hidden p-6">
      {/* Soft brand backdrop — a faint red glow + the rainbow hairline,
          so the sign-in screen feels branded without competing with the
          card. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute inset-x-0 top-0 h-1 bg-brand-gradient" />
        <div className="absolute left-1/2 top-[-20%] h-[50rem] w-[50rem] -translate-x-1/2 rounded-full bg-onfon-red/5 blur-3xl dark:bg-onfon-red/10" />
      </div>
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
      <p className="absolute bottom-4 text-[11px] text-slate-400">
        UssdGatewayTz · TZ MNO USSD gateway
      </p>
    </main>
  );
}
