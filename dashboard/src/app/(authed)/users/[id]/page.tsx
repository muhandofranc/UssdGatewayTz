import Link from "next/link";
import { notFound } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getUser, listRoles } from "@/lib/users";
import { actionResetPassword, actionUpdateUser } from "../actions";

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; reset?: string }>;
}

export default async function EditUserPage({ params, searchParams }: Props) {
  const { id: idStr } = await params;
  const id = parseInt(idStr, 10);
  if (!Number.isFinite(id)) notFound();

  const [user, roles, session, sp] = await Promise.all([
    getUser(id), listRoles(), getSession(), searchParams,
  ]);
  if (!user) notFound();

  const isSelf = session && Number(session.sub) === id;

  const update = actionUpdateUser.bind(null, id);
  const reset  = actionResetPassword.bind(null, id);

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/users" className="text-sm underline">← Back</Link>
        <h1 className="text-2xl font-semibold">Edit user</h1>
      </div>

      {sp.error ? (
        <div className="rounded-md bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          {sp.error}
        </div>
      ) : null}
      {sp.reset === "1" ? (
        <div className="rounded-md bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
          Password reset successfully.
        </div>
      ) : null}

      <form action={update}
            className="space-y-4 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Email</span>
          <input type="email" name="email" required defaultValue={user.email}
                 className="rounded-md border border-slate-300 dark:border-slate-700 bg-transparent px-2 py-1.5 font-mono" />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Name</span>
          <input type="text" name="name" required maxLength={150} defaultValue={user.name}
                 className="rounded-md border border-slate-300 dark:border-slate-700 bg-transparent px-2 py-1.5" />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Phone</span>
          <input type="tel" name="phone" maxLength={32} defaultValue={user.phone ?? ""}
                 className="rounded-md border border-slate-300 dark:border-slate-700 bg-transparent px-2 py-1.5 font-mono" />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Role</span>
          <select name="role_id" required defaultValue={user.role_id}
                  className="rounded-md border border-slate-300 dark:border-slate-700 bg-transparent px-2 py-1.5">
            {roles.map((r) => (
              <option key={r.id} value={r.id}>{r.label} ({r.key})</option>
            ))}
          </select>
        </label>
        <label className="inline-flex items-center gap-2 text-sm">
          <input type="checkbox" name="active" value="1" defaultChecked={user.active} />
          <span>Active {isSelf ? <span className="text-xs text-amber-600">(cannot deactivate yourself)</span> : null}</span>
        </label>

        <div className="text-xs text-slate-500">
          Owns <span className="font-mono">{user.owned_shortcode_count}</span> active shortcode(s).
          {" "}Reassign before deactivating in production.
        </div>

        <div className="flex items-center gap-2 pt-2">
          <button type="submit"
                  className="rounded-md bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 px-3 py-1.5 text-sm font-medium">
            Save changes
          </button>
          <Link href="/users" className="text-sm underline">Cancel</Link>
        </div>
      </form>

      <form action={reset}
            className="space-y-4 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6">
        <h2 className="text-lg font-medium">Reset password</h2>
        <p className="text-xs text-slate-500">
          Replaces the user's password immediately. They'll need the new
          one to sign in.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">New password</span>
            <input type="password" name="password" required minLength={8} autoComplete="new-password"
                   className="rounded-md border border-slate-300 dark:border-slate-700 bg-transparent px-2 py-1.5 font-mono" />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Confirm</span>
            <input type="password" name="password_confirm" required minLength={8} autoComplete="new-password"
                   className="rounded-md border border-slate-300 dark:border-slate-700 bg-transparent px-2 py-1.5 font-mono" />
          </label>
        </div>
        <button type="submit"
                className="rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-sm">
          Reset password
        </button>
      </form>
    </div>
  );
}
