/**
 * /reset-password — choose a new password from an emailed link. Public.
 *
 * The link is /reset-password#token=…: the token sits in the fragment,
 * which browsers never send to the server, so this page can't see it —
 * ResetForm reads it client-side and posts it in a request body.
 * next.config.mjs also sends Referrer-Policy: no-referrer here.
 */
import Link from "next/link";
import AuthShell from "@/components/AuthShell";
import ResetForm from "./ResetForm";

export default function ResetPasswordPage() {
  return (
    <AuthShell subtitle="Choose a new password.">
      <ResetForm />
      <Link href="/login" className="block text-center text-xs text-slate-500 underline">
        Back to sign in
      </Link>
    </AuthShell>
  );
}
