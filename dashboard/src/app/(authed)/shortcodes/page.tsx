/**
 * /shortcodes — list with inline activate/deactivate + link to edit
 * and new. super_admin gets the full write surface; auditor sees the
 * same listing with all write affordances hidden (read-only).
 * Middleware + the action layer both gate writes on SHORTCODES_MANAGE.
 */
import Link from "next/link";
import { getSession, hasPerm } from "@/lib/auth";
import { Perms } from "@/lib/rbac";
import { listShortcodes } from "@/lib/shortcodes";
import { actionSetShortcodeActive } from "./actions";

export default async function ShortcodesPage() {
  const session = await getSession();
  const canManage = !!session && hasPerm(session, Perms.SHORTCODES_MANAGE);
  const rows = await listShortcodes();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Shortcodes</h1>
        {canManage ? (
          <Link
            href="/shortcodes/new"
            className="rounded-md bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 px-3 py-1.5 text-sm font-medium"
          >
            + New shortcode
          </Link>
        ) : (
          <span className="text-xs text-slate-500 italic">read-only</span>
        )}
      </div>

      <div className="overflow-x-auto rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <table className="min-w-full text-left">
          <thead className="bg-slate-100 dark:bg-slate-800/60">
            <tr>
              <th className="px-2 py-2 text-xs font-medium">MNO</th>
              <th className="px-2 py-2 text-xs font-medium">Code</th>
              <th className="px-2 py-2 text-xs font-medium">Label</th>
              <th className="px-2 py-2 text-xs font-medium">Owner</th>
              <th className="px-2 py-2 text-xs font-medium">Handler URL</th>
              <th className="px-2 py-2 text-xs font-medium">Auth</th>
              <th className="px-2 py-2 text-xs font-medium text-right">timeout</th>
              <th className="px-2 py-2 text-xs font-medium">Status</th>
              {canManage ? <th className="px-2 py-2 text-xs font-medium text-right">Actions</th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-slate-200 dark:border-slate-800">
                <td className="px-2 py-1.5 text-xs font-mono">{r.operator_name}</td>
                <td className="px-2 py-1.5 text-xs font-mono">{r.code}</td>
                <td className="px-2 py-1.5 text-xs">{r.label ?? "—"}</td>
                <td className="px-2 py-1.5 text-xs">
                  <span title={r.owner_email} className="font-mono">{r.owner_name}</span>
                </td>
                <td className="px-2 py-1.5 text-xs font-mono max-w-[20rem] truncate" title={r.handler_url}>
                  {r.handler_url}
                </td>
                <td className="px-2 py-1.5 text-xs font-mono">{r.auth_mode}</td>
                <td className="px-2 py-1.5 text-xs text-right tabular-nums">{r.timeout_secs}s</td>
                <td className="px-2 py-1.5 text-xs">
                  {r.status === "active" ? (
                    <span className="inline-flex items-center rounded-md bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 px-1.5 py-0.5">active</span>
                  ) : r.status === "maintenance" ? (
                    <span className="inline-flex items-center rounded-md bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 px-1.5 py-0.5" title={r.status_message ?? ""}>
                      maintenance
                    </span>
                  ) : (
                    <span className="inline-flex items-center rounded-md bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 px-1.5 py-0.5" title={r.status_message ?? ""}>
                      deactivated
                    </span>
                  )}
                  {r.status !== "active" && r.status_message ? (
                    <div className="text-[10px] text-slate-500 max-w-[14rem] truncate" title={r.status_message}>
                      “{r.status_message}”
                    </div>
                  ) : null}
                </td>
                {canManage ? (
                  <td className="px-2 py-1.5 text-xs text-right space-x-2">
                    <Link href={`/shortcodes/${r.id}`} className="underline">Edit</Link>
                    <form action={async () => {
                      "use server";
                      await actionSetShortcodeActive(r.id, r.status !== "active");
                    }} className="inline">
                      <button className="underline">
                        {r.status === "active" ? "Deactivate" : "Reactivate"}
                      </button>
                    </form>
                  </td>
                ) : null}
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr><td className="px-2 py-6 text-center text-sm text-slate-500" colSpan={canManage ? 9 : 8}>
                {canManage
                  ? <>No shortcodes yet. Click <Link href="/shortcodes/new" className="underline">+ New shortcode</Link> to add one.</>
                  : "No shortcodes yet."}
              </td></tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-slate-500">
        Deactivation is a soft delete — the row stays in the DB so historical
        ussd_session_logs keep their join. Reactivate any time.
      </p>
    </div>
  );
}
