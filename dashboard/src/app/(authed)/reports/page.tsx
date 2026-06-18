/**
 * /reports — paginated PER-LEG session log table. One row per HTTP
 * leg the gateway received. Use /sessions for the rolled-up
 * one-row-per-session summary.
 *
 * Access control: super_admin sees every row (session.shortcodeIds
 * === null); any other role sees only their own shortcodes' rows
 * via the WHERE clause in lib/reports.ts buildWhere().
 *
 * Bounded count (10k cap) + LIMIT/OFFSET pagination.
 */
import Link from "next/link";
import { getSession } from "@/lib/auth";
import {
  COUNT_CAP, loadBillableSummary, loadReportPage, loadShortcodeOptions,
  type ReportFilters, type ReportRow,
} from "@/lib/reports";
import Filters from "./Filters";
import FilterBar, { defaultFromIfMissing } from "../_filterBar";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/* ---------- search-param plumbing ----------------------------- */

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
    fromTs:       asString(sp.from) ?? defaultFromIfMissing(sp),
    toTs:         asString(sp.to),
    msisdn:       asString(sp.msisdn),
    sessionId:    asString(sp.session_id),
    operators:    asStringArray(sp.operator),
    shortcodeIds: asIntArray(sp.shortcode_id),
    errorClass:   asString(sp.error_class) || "any",
  };
}

/* ---------- helpers ------------------------------------------- */

function fmtTs(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

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

/* ---------- row rendering ------------------------------------- */

function statusBadge(action: string | null, errorClass: string | null): React.ReactNode {
  if (errorClass) {
    return (
      <span className="inline-flex items-center rounded-md bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 px-1.5 py-0.5 text-xs font-mono">
        {errorClass}
      </span>
    );
  }
  if (action === "CON") {
    return (
      <span className="inline-flex items-center rounded-md bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 px-1.5 py-0.5 text-xs font-mono">
        CON
      </span>
    );
  }
  if (action === "END") {
    return (
      <span className="inline-flex items-center rounded-md bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 px-1.5 py-0.5 text-xs font-mono">
        END
      </span>
    );
  }
  return <span className="text-xs text-slate-500">—</span>;
}

function Row({ r }: { r: ReportRow }) {
  return (
    <tr className="border-t border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50">
      <td className="px-2 py-1.5 text-xs font-mono whitespace-nowrap">{fmtTs(r.ts)}</td>
      <td className="px-2 py-1.5 text-xs font-mono">{r.operator_name}</td>
      <td className="px-2 py-1.5 text-xs font-mono">{r.shortcode_code ?? "—"}</td>
      <td className="px-2 py-1.5 text-xs font-mono">{r.msisdn ?? "—"}</td>
      <td className="px-2 py-1.5 text-xs font-mono">
        <span title={r.session_id}>{r.session_id.length > 18 ? r.session_id.slice(0, 18) + "…" : r.session_id}</span>
      </td>
      <td className="px-2 py-1.5 text-xs font-mono">{r.direction}</td>
      <td className="px-2 py-1.5">{statusBadge(r.handler_response_action, r.error_class)}</td>
      <td className="px-2 py-1.5 text-xs font-mono max-w-[16rem] truncate" title={r.ussd_string ?? undefined}>
        {r.ussd_string || "—"}
      </td>
      <td className="px-2 py-1.5 text-xs font-mono max-w-[24rem] truncate" title={r.handler_response_text ?? undefined}>
        {r.handler_response_text || "—"}
      </td>
      <td className="px-2 py-1.5 text-xs text-right tabular-nums">
        {r.handler_elapsed_ms !== null ? `${r.handler_elapsed_ms}ms` : "—"}
      </td>
    </tr>
  );
}

/* ---------- page --------------------------------------------- */

export default async function ReportsPage({ searchParams }: PageProps) {
  const session = await getSession();
  if (!session) return null;

  const sp = await searchParams;
  const filters = parseFilters(sp);
  const page = asPositiveInt(sp.page, 1);
  const pageSize = asPositiveInt(sp.page_size, 10, 100);

  const [pageResult, summary, shortcodeOpts] = await Promise.all([
    loadReportPage(filters, session.shortcodeIds, page, pageSize),
    loadBillableSummary(filters, session.shortcodeIds),
    loadShortcodeOptions(session.shortcodeIds),
  ]);

  const totalPages = Math.max(1, Math.ceil(pageResult.totalKnown / pageSize));
  const fromIdx = pageResult.rows.length ? (page - 1) * pageSize + 1 : 0;
  const toIdx = (page - 1) * pageSize + pageResult.rows.length;

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="text-2xl font-semibold">Session legs</h1>
        <div className="flex items-center gap-3 text-sm">
          <Link href="/sessions" className="rounded-md border border-slate-300 dark:border-slate-700 px-2.5 py-1 text-xs hover:bg-slate-100 dark:hover:bg-slate-800">
            View session summary →
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

      <FilterBar basePath="/reports" sp={sp} />
      <Filters defaults={filters} pageSize={pageSize} shortcodeOptions={shortcodeOpts} action="/reports" />

      <div className="text-sm text-slate-500">
        {pageResult.totalKnown === 0
          ? "No matching legs."
          : <>
              Showing <span className="font-mono">{fromIdx.toLocaleString()}–{toIdx.toLocaleString()}</span>
              {" "}of <span className="font-mono">{fmtCount(pageResult.totalKnown, pageResult.totalCapped)}</span>
              {" "}leg(s)
            </>}
      </div>

      <div className="overflow-x-auto rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <table className="min-w-full text-left">
          <thead className="bg-slate-100 dark:bg-slate-800/60">
            <tr>
              <th className="px-2 py-1.5 text-xs font-medium">Timestamp</th>
              <th className="px-2 py-1.5 text-xs font-medium">MNO</th>
              <th className="px-2 py-1.5 text-xs font-medium">Shortcode</th>
              <th className="px-2 py-1.5 text-xs font-medium">MSISDN</th>
              <th className="px-2 py-1.5 text-xs font-medium">Session</th>
              <th className="px-2 py-1.5 text-xs font-medium">Dir</th>
              <th className="px-2 py-1.5 text-xs font-medium">Status</th>
              <th className="px-2 py-1.5 text-xs font-medium">USSD trail</th>
              <th className="px-2 py-1.5 text-xs font-medium">Reply</th>
              <th className="px-2 py-1.5 text-xs font-medium text-right" title="Gateway → handler HTTP round-trip in milliseconds (does not include MNO ↔ gateway legs)">Handler latency</th>
            </tr>
          </thead>
          <tbody>
            {pageResult.rows.map((r) => <Row key={r.id} r={r} />)}
            {pageResult.rows.length === 0 ? (
              <tr><td className="px-2 py-6 text-center text-sm text-slate-500" colSpan={10}>
                No rows match the current filters.
              </td></tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {pageResult.totalKnown > pageSize ? (
        <div className="flex items-center gap-2 text-sm">
          <Link
            href={`/reports${buildQs(sp, { page: String(Math.max(1, page - 1)) })}`}
            className={`rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1 ${page <= 1 ? "pointer-events-none opacity-40" : ""}`}
          >
            ← Prev
          </Link>
          <span className="text-slate-500">
            Page <span className="font-mono">{page}</span> of <span className="font-mono">{pageResult.totalCapped ? `${totalPages}+` : totalPages}</span>
          </span>
          <Link
            href={`/reports${buildQs(sp, { page: String(page + 1) })}`}
            className={`rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1 ${page >= totalPages && !pageResult.totalCapped ? "pointer-events-none opacity-40" : ""}`}
          >
            Next →
          </Link>
        </div>
      ) : null}
    </div>
  );
}
