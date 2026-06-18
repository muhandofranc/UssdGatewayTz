/**
 * /summary — pre-aggregated daily summary report.
 *
 * Reads from `daily_session_summary` (db/015) — populated nightly,
 * scoped to yesterday-and-earlier. The "data through <yesterday>"
 * stamp makes the recency explicit; today's traffic shows up
 * tomorrow morning.
 *
 * Filters: date range, operator(s), shortcode(s). Owner filter only
 * appears for callers with reports.view_all (super_admin + auditor)
 * — for client/Admin and client_viewer it'd be meaningless (their
 * allowlist already restricts them).
 *
 * Per-row access:
 *   super_admin / auditor → unrestricted (shortcodeIds=null in JWT)
 *   client (Admin)        → owned shortcodes only
 *   client_viewer         → junction-granted shortcodes only
 */
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession, hasPerm } from "@/lib/auth";
import { Perms } from "@/lib/rbac";
import { loadShortcodeOptions } from "@/lib/reports";
import { listOperators } from "@/lib/shortcodes";
import {
  dataThroughDate, listShortcodeOwners, loadDailySummary,
  type GroupBy, type SummaryFilters,
} from "@/lib/summary";

type SearchParams = {
  from?: string;
  to?: string;
  operator_id?: string | string[];
  shortcode_id?: string | string[];
  owner_user_id?: string;
  group_by?: GroupBy;
};

function defaultFromDate(): string {
  // Last 7 days through yesterday.
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 8);
  return d.toISOString().slice(0, 10);
}

function asArray(v: string | string[] | undefined): string[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function asIntArray(v: string | string[] | undefined): number[] {
  return asArray(v).map((x) => parseInt(x, 10)).filter(Number.isFinite);
}

export default async function SummaryPage({
  searchParams,
}: { searchParams: Promise<SearchParams> }) {
  const session = await getSession();
  if (!session) redirect("/login");
  // Both view_own and view_all callers reach this page (gate is in
  // rbac.ts middleware); the per-row predicate handles scoping.
  const canSeeAll = hasPerm(session, Perms.REPORTS_VIEW_ALL);

  const sp = await searchParams;
  const through = dataThroughDate();
  const fromDate = sp.from || defaultFromDate();
  const toDate   = sp.to   || through;
  // Default per-network breakdown — one row per (date, operator).
  // Users can switch via the "Group by" dropdown.
  const groupBy: GroupBy = sp.group_by ?? "date_operator";
  const operatorIds  = asIntArray(sp.operator_id);
  const shortcodeIds = asIntArray(sp.shortcode_id);
  const ownerUserId  = sp.owner_user_id ? parseInt(sp.owner_user_id, 10) : undefined;

  const filters: SummaryFilters = {
    fromDate, toDate,
    operatorIds:  operatorIds.length  ? operatorIds  : undefined,
    shortcodeIds: shortcodeIds.length ? shortcodeIds : undefined,
    ownerUserId:  canSeeAll && Number.isFinite(ownerUserId) ? ownerUserId : undefined,
  };

  const [rows, operators, shortcodes, owners] = await Promise.all([
    loadDailySummary(filters, session.shortcodeIds, groupBy),
    listOperators(),
    loadShortcodeOptions(session.shortcodeIds),
    canSeeAll ? listShortcodeOwners() : Promise.resolve([]),
  ]);

  // Totals across the visible rows (for the footer summary).
  const totals = rows.reduce(
    (acc, r) => ({
      sessions:       acc.sessions + r.sessions,
      legs:           acc.legs + r.legs,
      billable_units: acc.billable_units + r.billable_units,
    }),
    { sessions: 0, legs: 0, billable_units: 0 },
  );

  const showGroupCol = groupBy !== "date";
  const groupHeader =
    groupBy === "date_operator"   ? "Operator"  :
    groupBy === "date_shortcode"  ? "Shortcode" :
    groupBy === "date_owner"      ? "Owner"     : "";

  // Build the CSV URL with the same filters as the current view.
  const csvParams = new URLSearchParams();
  csvParams.set("from", fromDate);
  csvParams.set("to",   toDate);
  csvParams.set("group_by", groupBy);
  for (const id of operatorIds)  csvParams.append("operator_id",  String(id));
  for (const id of shortcodeIds) csvParams.append("shortcode_id", String(id));
  if (canSeeAll && ownerUserId !== undefined) csvParams.set("owner_user_id", String(ownerUserId));
  const csvHref = `/api/summary/export.csv?${csvParams.toString()}`;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">Daily summary</h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
            Pre-aggregated daily counts of sessions, legs, errors, and
            billable units. Data through {" "}
            <span className="font-mono">{through}</span> — today's
            traffic appears tomorrow morning after the nightly refresh.
          </p>
        </div>
        <a href={csvHref}
           className="rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-sm font-medium hover:bg-slate-50 dark:hover:bg-slate-800">
          ↓ Download CSV
        </a>
      </div>

      {/* ---- Filter form ---- */}
      <form method="GET"
            className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4
                       grid gap-3 md:grid-cols-6 items-end">
        <FilterField label="From" name="from" type="date" defaultValue={fromDate} />
        <FilterField label="To"   name="to"   type="date" defaultValue={toDate} />

        <label className="block">
          <span className="block text-xs font-medium mb-1">Group by</span>
          <select name="group_by" defaultValue={groupBy}
                  className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1.5 text-sm">
            <option value="date">Date only</option>
            <option value="date_operator">Date + Operator</option>
            <option value="date_shortcode">Date + Shortcode</option>
            {canSeeAll ? <option value="date_owner">Date + Owner</option> : null}
          </select>
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
          <span className="block text-xs font-medium mb-1">Shortcode</span>
          <select name="shortcode_id" multiple
                  defaultValue={shortcodeIds.map(String)}
                  className="w-full h-20 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1 text-xs font-mono">
            {shortcodes.map((s) => (
              <option key={s.id} value={s.id}>
                {s.operator_name} {s.code}{s.label ? ` · ${s.label}` : ""}
              </option>
            ))}
          </select>
        </label>

        {canSeeAll ? (
          <label className="block">
            <span className="block text-xs font-medium mb-1">Owner</span>
            <select name="owner_user_id"
                    defaultValue={ownerUserId ? String(ownerUserId) : ""}
                    className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1.5 text-sm">
              <option value="">any</option>
              {owners.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.shortcode_count})
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <div className="flex gap-2">
          <button type="submit"
                  className="rounded-md bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 px-3 py-1.5 text-sm font-medium">
            Apply
          </button>
          <Link href="/summary"
                className="rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-sm">
            Reset
          </Link>
        </div>
      </form>

      <div className="text-xs text-slate-500">
        {rows.length} row{rows.length === 1 ? "" : "s"} · capped at 5,000
      </div>

      {/* ---- Table ---- */}
      <div className="overflow-x-auto rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <table className="min-w-full text-left">
          <thead className="bg-slate-100 dark:bg-slate-800/60">
            <tr>
              <th className="px-2 py-2 text-xs font-medium">Date</th>
              {showGroupCol ? <th className="px-2 py-2 text-xs font-medium">{groupHeader}</th> : null}
              <th className="px-2 py-2 text-xs font-medium text-right">Unique SessionIDs</th>
              <th className="px-2 py-2 text-xs font-medium text-right">Legs</th>
              <th className="px-2 py-2 text-xs font-medium text-right">Session Counts</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.date}_${r.group_label ?? ""}_${i}`}
                  className="border-t border-slate-200 dark:border-slate-800">
                <td className="px-2 py-1.5 text-xs font-mono">{r.date}</td>
                {showGroupCol ? <td className="px-2 py-1.5 text-xs">{r.group_label ?? "—"}</td> : null}
                <td className="px-2 py-1.5 text-xs text-right tabular-nums">{r.sessions.toLocaleString()}</td>
                <td className="px-2 py-1.5 text-xs text-right tabular-nums">{r.legs.toLocaleString()}</td>
                <td className="px-2 py-1.5 text-xs text-right tabular-nums">{r.billable_units.toLocaleString()}</td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr><td className="px-2 py-6 text-center text-sm text-slate-500" colSpan={showGroupCol ? 5 : 4}>
                No data for the current filters.
              </td></tr>
            ) : null}
          </tbody>
          {rows.length > 0 ? (
            <tfoot className="bg-slate-50 dark:bg-slate-900/60 border-t-2 border-slate-300 dark:border-slate-700">
              <tr>
                <td className="px-2 py-2 text-xs font-semibold" colSpan={showGroupCol ? 2 : 1}>Total</td>
                <td className="px-2 py-2 text-xs font-semibold text-right tabular-nums">{totals.sessions.toLocaleString()}</td>
                <td className="px-2 py-2 text-xs font-semibold text-right tabular-nums">{totals.legs.toLocaleString()}</td>
                <td className="px-2 py-2 text-xs font-semibold text-right tabular-nums">{totals.billable_units.toLocaleString()}</td>
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>
    </div>
  );
}

function FilterField({
  label, name, type = "text", defaultValue,
}: {
  label: string; name: string; type?: string; defaultValue?: string;
}) {
  return (
    <label className="block">
      <span className="block text-xs font-medium mb-1">{label}</span>
      <input name={name} type={type} defaultValue={defaultValue}
             className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1.5 text-sm" />
    </label>
  );
}
