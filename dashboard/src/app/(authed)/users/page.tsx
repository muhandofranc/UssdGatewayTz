/**
 * /users — list with role + status. New / Edit links; no inline
 * activate toggle (active is a stateful field with a no-lockout
 * guard, so changes go through the edit form).
 */
import Link from "next/link";
import { listUsers } from "@/lib/users";

export default async function UsersPage() {
  const rows = await listUsers();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Portal users</h1>
        <Link href="/users/new"
              className="rounded-md bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 px-3 py-1.5 text-sm font-medium">
          + New user
        </Link>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <table className="min-w-full text-left">
          <thead className="bg-slate-100 dark:bg-slate-800/60">
            <tr>
              <th className="px-2 py-2 text-xs font-medium">Email</th>
              <th className="px-2 py-2 text-xs font-medium">Name</th>
              <th className="px-2 py-2 text-xs font-medium">Role</th>
              <th className="px-2 py-2 text-xs font-medium text-right">Shortcodes</th>
              <th className="px-2 py-2 text-xs font-medium">Phone</th>
              <th className="px-2 py-2 text-xs font-medium">Active</th>
              <th className="px-2 py-2 text-xs font-medium">Last login</th>
              <th className="px-2 py-2 text-xs font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => (
              <tr key={u.id} className="border-t border-slate-200 dark:border-slate-800">
                <td className="px-2 py-1.5 text-xs font-mono">{u.email}</td>
                <td className="px-2 py-1.5 text-xs">{u.name}</td>
                <td className="px-2 py-1.5 text-xs font-mono">{u.role_key}</td>
                <td className="px-2 py-1.5 text-xs text-right tabular-nums">{u.owned_shortcode_count}</td>
                <td className="px-2 py-1.5 text-xs font-mono">{u.phone ?? "—"}</td>
                <td className="px-2 py-1.5 text-xs">
                  {u.active
                    ? <span className="inline-flex items-center rounded-md bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 px-1.5 py-0.5">active</span>
                    : <span className="inline-flex items-center rounded-md bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 px-1.5 py-0.5">inactive</span>}
                </td>
                <td className="px-2 py-1.5 text-xs font-mono">
                  {u.last_login ? new Date(u.last_login).toISOString().slice(0,19).replace("T"," ") : "—"}
                </td>
                <td className="px-2 py-1.5 text-xs text-right">
                  <Link href={`/users/${u.id}`} className="underline">Edit</Link>
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr><td className="px-2 py-6 text-center text-sm text-slate-500" colSpan={8}>
                No users.
              </td></tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-slate-500">
        Deactivation is a soft delete — the row stays so audit references
        keep resolving. The no-lockout invariants prevent deactivating
        the last active super_admin or yourself.
      </p>
    </div>
  );
}
