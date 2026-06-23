/**
 * /operators — list of MNOs with billing-window + active state. The
 * rows are fixed (4 TZ MNOs seeded by db/001_init.sql), so there's
 * no create/delete flow; just per-row edit.
 *
 * The "name" column is read-only on the edit page because the
 * gateway code routes by it (/ussd/<name>) and any rename would
 * silently desync the adapters.
 */
import Link from "next/link";
import { getSession, hasPerm } from "@/lib/auth";
import { Perms } from "@/lib/rbac";
import { listOperatorsAdmin } from "@/lib/operators";

export default async function OperatorsPage() {
  const session = await getSession();
  const canManage = !!session && hasPerm(session, Perms.SHORTCODES_MANAGE);
  const rows = await listOperatorsAdmin();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Operators</h1>
        <div className="text-xs text-slate-500">
          {canManage
            ? "Per-MNO billing-window configuration. Edit a row to change."
            : "Per-MNO billing-window configuration (read-only)."}
        </div>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <table className="min-w-full text-left">
          <thead className="bg-brand-header">
            <tr>
              <th className="px-2 py-2 text-xs font-medium">Name (routing key)</th>
              <th className="px-2 py-2 text-xs font-medium">Display</th>
              <th className="px-2 py-2 text-xs font-medium text-right">Billable window</th>
              <th className="px-2 py-2 text-xs font-medium">Active</th>
              {canManage ? <th className="px-2 py-2 text-xs font-medium text-right">Actions</th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-slate-200 dark:border-slate-800">
                <td className="px-2 py-1.5 text-xs font-mono">{r.name}</td>
                <td className="px-2 py-1.5 text-xs">{r.display_name}</td>
                <td className="px-2 py-1.5 text-xs text-right tabular-nums">
                  {r.billable_window_secs !== null
                    ? <span className="font-mono">{r.billable_window_secs}s</span>
                    : <span className="text-slate-500" title="MNO bills per leg, not per duration window">— (per-leg)</span>}
                </td>
                <td className="px-2 py-1.5 text-xs">
                  {r.active
                    ? <span className="inline-flex items-center rounded-md bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 px-1.5 py-0.5">active</span>
                    : <span className="inline-flex items-center rounded-md bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 px-1.5 py-0.5">inactive</span>}
                </td>
                {canManage ? (
                  <td className="px-2 py-1.5 text-xs text-right">
                    <Link href={`/operators/${r.id}`} className="underline">Edit</Link>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-slate-500">
        Billable window = the per-MNO USSD billing increment.
      </p>
    </div>
  );
}
