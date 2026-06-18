/**
 * /sessions — PER-SESSION rolled-up summary. One row per
 * (session_id, operator) with first/last leg timestamps,
 * duration_secs, leg count, final outcome, and Vodacom 20s billable
 * units.
 *
 * Filters share the shape used on /reports (date range, msisdn,
 * session id, operator, shortcode, error class) — same Filters
 * component, just with `action="/sessions"`.
 *
 * Access control: super_admin sees all sessions; any other role
 * sees only sessions touching one of their owned shortcodes
 * (enforced in lib/reports.ts buildWhere via shortcode_id = ANY()).
 */
import Link from "next/link";
import { getSession } from "@/lib/auth";
import {
  COUNT_CAP, loadBillableSummary, loadSessionPage, loadShortcodeOptions,
  type ReportFilters,
} from "@/lib/reports";
import Filters from "../reports/Filters";
import FilterBar, { defaultFromIfMissing } from "../_filterBar";
import ExpandableSessionRow from "./ExpandableSessionRow";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/* ---------- search-param plumbing (same shape as /reports) ---- */

function asString(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v && v.length ? v : undefined;
}
function asStringArray(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return (Array.isArray(v) ? v : [v]).filter((s) => s.length > 0);
}
function asIntArray(v: string | string[] | undefined): number[] {
  return asStringArray(v).map((s) => parseInt(s, 10)).filter(Number.isFinite);
}
function asPositiveInt(v: string | string[] | undefined, fallback: number, max?: number): number {
  const s = asString(v);
  const n = s ? parseInt(s, 10) : NaN;
  if (!Number.isFinite(n) || n < 1) return fallback;
  return max ? Math.min(n, max) : n;
}

function parseFilters(sp: Awaited<PageProps["searchParams"]>): ReportFilters {
  return {
    // Default to last 24h when neither from nor to is set — keeps
    // queries on the current monthly partition. Users opt out via the
    // Reset button or a manual From= date.
    fromTs:       asString(sp.from) ?? defaultFromIfMissing(sp),
    toTs:         asString(sp.to),
    msisdn:       asString(sp.msisdn),
    sessionId:    asString(sp.session_id),
    operators:    asStringArray(sp.operator),
    shortcodeIds: asIntArray(sp.shortcode_id),
    errorClass:   asString(sp.error_class) || "any",
  };
}

/* ---------- formatters ---------------------------------------- */

function fmtCount(n: number, capped: boolean): string {
  return capped ? `${COUNT_CAP.toLocaleString()}+` : n.toLocaleString();
}

function buildQs(sp: Awaited<PageProps["searchParams"]>, overrides: Record<string, string | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (k === "page") continue;
    if (v === undefined) continue;
    if (Array.isArray(v)) v.forEach((x) => p.append(k, x));
    else p.set(k, v);
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) p.delete(k);
    else p.set(k, v);
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

/* ---------- page --------------------------------------------- */

export default async function SessionsPage({ searchParams }: PageProps) {
  const session = await getSession();
  if (!session) return null;

  const sp = await searchParams;
  const filters = parseFilters(sp);
  const page = asPositiveInt(sp.page, 1);
  const pageSize = asPositiveInt(sp.page_size, 10, 100);

  const [pageResult, summary, shortcodeOpts] = await Promise.all([
    loadSessionPage(filters, session.shortcodeIds, page, pageSize),
    loadBillableSummary(filters, session.shortcodeIds),
    loadShortcodeOptions(session.shortcodeIds),
  ]);

  const totalPages = Math.max(1, Math.ceil(pageResult.totalKnown / pageSize));
  const fromIdx = pageResult.rows.length ? (page - 1) * pageSize + 1 : 0;
  const toIdx = (page - 1) * pageSize + pageResult.rows.length;

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="text-2xl font-semibold">Sessions</h1>
        <div className="flex items-center gap-3 text-sm">
          <Link href="/reports" className="rounded-md border border-slate-300 dark:border-slate-700 px-2.5 py-1 text-xs hover:bg-slate-100 dark:hover:bg-slate-800">
            ← Per-leg view
          </Link>
          <div className="text-slate-500">
            Scope:{" "}
            <span className="font-mono">
              {session.shortcodeIds === null
                ? "all shortcodes (super_admin)"
                : `${session.shortcodeIds.length} owned shortcode(s)`}
            </span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        {summary.per_operator.map((op) => (
          <div key={op.operator_name}
               className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-2">
            <div className="flex items-baseline justify-between">
              <div className="text-[10px] uppercase tracking-wider text-slate-500">{op.operator_name}</div>
              <div className="text-[10px] text-slate-500 font-mono">
                {op.window_secs !== null ? `${op.window_secs}s` : "per-leg"}
              </div>
            </div>
            <div className="text-lg font-semibold tabular-nums">
              {op.billable_units !== null
                ? op.billable_units.toLocaleString()
                : op.sessions.toLocaleString()}
            </div>
            <div className="text-[10px] text-slate-500">
              {op.billable_units !== null
                ? <>sessions · <span className="font-mono">{op.sessions.toLocaleString()}</span> session ID(s)</>
                : <>sessions · per-leg billing</>}
            </div>
          </div>
        ))}
        <div className="rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider text-amber-700 dark:text-amber-300">total sessions</div>
          <div className="text-lg font-semibold tabular-nums">{summary.total_billable_units.toLocaleString()}</div>
          <div className="text-[10px] text-amber-700/80 dark:text-amber-300/80">across all MNOs</div>
        </div>
      </div>

      <FilterBar basePath="/sessions" sp={sp} />
      <Filters defaults={filters} pageSize={pageSize} shortcodeOptions={shortcodeOpts} action="/sessions" />

      <div className="text-sm text-slate-500">
        {pageResult.totalKnown === 0
          ? "No matching sessions."
          : <>
              Showing <span className="font-mono">{fromIdx.toLocaleString()}–{toIdx.toLocaleString()}</span>
              {" "}of <span className="font-mono">{fmtCount(pageResult.totalKnown, pageResult.totalCapped)}</span>
              {" "}session(s)
            </>}
      </div>

      <div className="overflow-x-auto rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <table className="min-w-full text-left">
          <thead className="bg-slate-100 dark:bg-slate-800/60">
            <tr>
              <th className="px-2 py-1.5 text-xs font-medium w-6" aria-label="expand"></th>
              <th className="px-2 py-1.5 text-xs font-medium">Session ID</th>
              <th className="px-2 py-1.5 text-xs font-medium">MNO</th>
              <th className="px-2 py-1.5 text-xs font-medium">Shortcode</th>
              <th className="px-2 py-1.5 text-xs font-medium">MSISDN</th>
              <th className="px-2 py-1.5 text-xs font-medium">Started</th>
              <th className="px-2 py-1.5 text-xs font-medium">Ended</th>
              <th className="px-2 py-1.5 text-xs font-medium text-right">Duration</th>
              <th className="px-2 py-1.5 text-xs font-medium text-right">Legs</th>
              <th className="px-2 py-1.5 text-xs font-medium">Outcome</th>
              <th className="px-2 py-1.5 text-xs font-medium">USSD trail</th>
              <th className="px-2 py-1.5 text-xs font-medium text-right" title="Number of billable sessions per the MNO's duration window. CEIL(duration / window).">Sessions</th>
            </tr>
          </thead>
          <tbody>
            {pageResult.rows.map((r) =>
              <ExpandableSessionRow key={`${r.operator_name}:${r.session_id}`} row={r} />
            )}
            {pageResult.rows.length === 0 ? (
              <tr><td className="px-2 py-6 text-center text-sm text-slate-500" colSpan={12}>
                No sessions match the current filters.
              </td></tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {pageResult.totalKnown > pageSize ? (
        <div className="flex items-center gap-2 text-sm">
          <Link
            href={`/sessions${buildQs(sp, { page: String(Math.max(1, page - 1)) })}`}
            className={`rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1 ${page <= 1 ? "pointer-events-none opacity-40" : ""}`}
          >
            ← Prev
          </Link>
          <span className="text-slate-500">
            Page <span className="font-mono">{page}</span> of <span className="font-mono">{pageResult.totalCapped ? `${totalPages}+` : totalPages}</span>
          </span>
          <Link
            href={`/sessions${buildQs(sp, { page: String(page + 1) })}`}
            className={`rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1 ${page >= totalPages && !pageResult.totalCapped ? "pointer-events-none opacity-40" : ""}`}
          >
            Next →
          </Link>
        </div>
      ) : null}

      <p className="text-[11px] text-slate-500">
        Each row is one MNO-issued <span className="font-mono">session_id</span>. The
        {" "}<strong>Sessions</strong> column is the MNO-billable count.
      </p>
    </div>
  );
}
