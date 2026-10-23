/**
 * /forgot-password — ask for a reset link by email. Public.
 * Linked from /login; the form posts to /api/auth/forgot-password.
 */
import Link from "next/link";
import AuthShell from "@/components/AuthShell";
import { mailEnabled } from "@/lib/mailer";
import ForgotForm from "./ForgotForm";

export const dynamic = "force-dynamic";   // mailEnabled() reads runtime env

export default function ForgotPasswordPage() {
  return (
    <AuthShell subtitle="Reset your password.">
      {mailEnabled() ? (
        <ForgotForm />
      ) : (
        <p className="text-sm text-slate-600 dark:text-slate-300">
          Password reset by email isn&apos;t set up. Ask an administrator to
          reset your password.
        </p>
      )}
      <Link href="/login" className="block text-center text-xs text-slate-500 underline">
        Back to sign in
      </Link>
    </AuthShell>
  );
}
