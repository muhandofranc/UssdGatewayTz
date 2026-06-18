/**
 * /shortcodes — list + filter form.
 *
 * super_admin gets the full write surface; auditor sees the same
 * listing with all write affordances hidden (read-only). Middleware
 * + the action layer both gate writes on SHORTCODES_MANAGE.
 *
 * Filters (querystring → searchParams) — same GET-form pattern as
 * /audit + /summary:
 *   operator_id  (multi)  — operators.id
 *   status                — active | maintenance | deactivated
 *   auth_mode             — none | bearer
 *   owner_user_id         — portal_users.id (the dropdown is only
 *                            useful for super_admin/auditor; client/
 *                            client_viewer already have a narrowed
 *                            view via the data-level allowlist)
 *   q                     — free-text on code / label / handler_url
 */
import Link from "next/link";
import { getSession, hasPerm } from "@/lib/auth";
import { Perms } from "@/lib/rbac";
import {
  listOperators, listShortcodes,
  type ShortcodeListFilters, type ShortcodeStatus,
} from "@/lib/shortcodes";
import { listShortcodeOwners } from "@/lib/summary";
import { actionSetShortcodeActive } from "./actions";

type SearchParams = {
  operator_id?: string | string[];
  status?: string;
  auth_mode?: string;
  owner_user_id?: string;
  q?: string;
};

function asArray(v: string | string[] | undefined): string[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function asIntArray(v: string | string[] | undefined): number[] {
  return asArray(v).map((x) => parseInt(x, 10)).filter(Number.isFinite);
}

const STATUSES: ShortcodeStatus[] = ["active", "maintenance", "deactivated"];

export default async function ShortcodesPage({
  searchParams,
}: { searchParams: Promise<SearchParams> }) {
  const session = await getSession();
  const canManage = !!session && hasPerm(session, Perms.SHORTCODES_MANAGE);
  const sp = await searchParams;

  const operatorIds  = asIntArray(sp.operator_id);
  const status       = STATUSES.includes(sp.status as ShortcodeStatus)
                         ? (sp.status as ShortcodeStatus) : undefined;
  const authMode     = sp.auth_mode === "none" || sp.auth_mode === "bearer"
                         ? sp.auth_mode : undefined;
  const ownerUserId  = sp.owner_user_id ? parseInt(sp.owner_user_id, 10) : undefined;
  const search       = sp.q?.trim() || undefined;

  const filters: ShortcodeListFilters = {
    operatorIds:  operatorIds.length ? operatorIds : undefined,
    status,
    authMode,
    ownerUserId:  Number.isFinite(ownerUserId) ? ownerUserId : undefined,
    search,
  };

  const [rows, operators, owners] = await Promise.all([
    listShortcodes(filters),
    listOperators(),
    listShortcodeOwners(),
  ]);

  const anyFilterActive = !!(operatorIds.length || status || authMode || ownerUserId || search);

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

      {/* ---- Filter form ---- */}
      <form method="GET"
            className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4
                       grid gap-3 md:grid-cols-6 items-end">
        <label className="block md:col-span-2">
          <span className="block text-xs font-medium mb-1">Search (code / label / handler URL)</span>
          <input name="q" type="text" defaultValue={search ?? ""}
                 placeholder="substring"
                 className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1.5 text-sm" />
        </label>

        <label className="block">
          <span className="block text-xs font-medium mb-1">Operator</span>
          <select name="operator_id" multiple
                  defaultValue={operatorIds.map(String)}
                  className="w-full h-20 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1 text-xs font-mono">
            {operators.map((o) => (
              <option key={o.id} value={o.id}>{o.display_name}</option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="block text-xs font-medium mb-1">Status</span>
          <select name="status" defaultValue={status ?? ""}
                  className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1.5 text-sm">
            <option value="">any</option>
            <option value="active">active</option>
            <option value="maintenance">maintenance</option>
            <option value="deactivated">deactivated</option>
          </select>
        </label>

        <label className="block">
          <span className="block text-xs font-medium mb-1">Auth mode</span>
          <select name="auth_mode" defaultValue={authMode ?? ""}
                  className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1.5 text-sm">
            <option value="">any</option>
            <option value="none">none</option>
            <option value="bearer">bearer</option>
          </select>
        </label>

        <label className="block">
          <span className="block text-xs font-medium mb-1">Owner</span>
          <select name="owner_user_id" defaultValue={ownerUserId ? String(ownerUserId) : ""}
                  className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1.5 text-sm">
            <option value="">any</option>
            {owners.map((u) => (
              <option key={u.id} value={u.id}>{u.name} ({u.shortcode_count})</option>
            ))}
          </select>
        </label>

        <div className="flex gap-2 md:col-span-6 justify-end">
          <Link href="/shortcodes"
                className="rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-sm">
            Reset
          </Link>
          <button type="submit"
                  className="rounded-md bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 px-3 py-1.5 text-sm font-medium">
            Apply
          </button>
        </div>
      </form>

      <div className="text-xs text-slate-500">
        {rows.length} match{rows.length === 1 ? "" : "es"}
        {anyFilterActive ? null : " (no filter applied)"}
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
                {anyFilterActive
                  ? "No shortcodes match the current filters."
                  : canManage
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
