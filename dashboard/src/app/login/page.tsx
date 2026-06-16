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
    <main className="min-h-screen grid place-items-center p-6">
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </main>
  );
}
