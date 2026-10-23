/**
 * /account — the signed-in user's own account: who they are, and a
 * change-password form. Open to every role (see lib/rbac.ts).
 *
 * Admins setting someone ELSE's password use /users instead; this page
 * only ever acts on the session's own user.
 */
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { actionChangeOwnPassword } from "./actions";

interface Props {
  searchParams: Promise<{ error?: string; changed?: string }>;
}

const inputClass =
  "rounded-md border border-slate-300 dark:border-slate-700 bg-transparent px-2 py-1.5 font-mono";

export default async function AccountPage({ searchParams }: Props) {
  const session = await getSession();
  if (!session) redirect("/login");
  const sp = await searchParams;

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <h1 className="text-2xl font-semibold">My account</h1>

      {sp.error ? (
        <div className="rounded-md bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          {sp.error}
        </div>
      ) : null}
      {sp.changed === "1" ? (
        <div className="rounded-md bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
          Password changed. Use the new one next time you sign in.
        </div>
      ) : null}

      <dl className="grid grid-cols-[8rem_1fr] gap-y-2 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 text-sm">
        <dt className="text-slate-500">Name</dt>
        <dd>{session.name}</dd>
        <dt className="text-slate-500">Email</dt>
        <dd className="font-mono">{session.email}</dd>
        <dt className="text-slate-500">Role</dt>
        <dd className="font-mono">{session.role}</dd>
      </dl>

      {session.imp ? (
        <div className="rounded-md bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
          You are viewing as {session.email}. Stop impersonating to change
          your own password.
        </div>
      ) : (
        <form action={actionChangeOwnPassword}
              className="space-y-4 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6">
          <h2 className="text-lg font-medium">Change password</h2>
          <p className="text-xs text-slate-500">
            At least 8 characters. You stay signed in here; every other device
            is signed out.
          </p>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Current password</span>
            <input type="password" name="current_password" required autoComplete="current-password"
                   className={inputClass} />
          </label>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">New password</span>
              <input type="password" name="password" required minLength={8} maxLength={72}
                     autoComplete="new-password" className={inputClass} />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">Confirm new password</span>
              <input type="password" name="password_confirm" required minLength={8} maxLength={72}
                     autoComplete="new-password" className={inputClass} />
            </label>
          </div>
          <button type="submit"
                  className="rounded-md bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 px-3 py-1.5 text-sm font-medium">
            Change password
          </button>
        </form>
      )}
    </div>
  );
}
