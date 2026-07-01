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

/** PG error code for `canceling statement due to statement timeout`.
 *  Distinguishes "your filter is too wide" from real bugs — we catch
 *  57014 in the page render and surface a friendly explanation; every
 *  other error re-throws through the App Router's error boundary.
 *
 *  Two timeout paths can fire on a slow query:
 *    (1) PG server-side statement_timeout → error.code = '57014' (clean)
 *    (2) pg-node client-side query_timeout → error.message =
 *        'Query read timeout' with NO code (socket abandoned).
 *
 *  lib/db.ts is configured so (1) fires ~10s before (2) in normal
 *  operation. But a network blip can flip the order, so we recognise
 *  both here — same amber panel, same recovery path. */
const PG_STATEMENT_TIMEOUT = "57014";
function isPgTimeoutError(e: unknown): boolean {
  const code    = (e as { code?: string })?.code;
  const message = (e as { message?: string })?.message ?? "";
  return code === PG_STATEMENT_TIMEOUT
      || /Query read timeout/i.test(message);
}

function daysBetween(a?: string, b?: string): number {
  if (!a || !b) return 0;
  const ms = new Date(b).getTime() - new Date(a).getTime();
  return Math.max(0, Math.floor(ms / (24 * 3600 * 1000))) + 1;
}

/** Sentinel rendered when the query timed out — see the try/catch
 *  around `Promise.all` for the timing details. */
type QueryTimeout = { __timeout: true; windowDays: number };
function isTimeout<T>(v: T | QueryTimeout): v is QueryTimeout {
  return typeof v === "object" && v !== null
    && (v as QueryTimeout).__timeout === true;
}


export default async function SessionsPage({ searchParams }: PageProps) {
  const session = await getSession();
  if (!session) return null;

  const sp = await searchParams;
  const filters = parseFilters(sp);
  const page = asPositiveInt(sp.page, 1);
  const pageSize = asPositiveInt(sp.page_size, 10, 100);
  const windowDays = daysBetween(filters.fromTs, filters.toTs);

  // Catch statement-timeout (PG error 57014) so a filter that's too
  // wide surfaces a friendly explanation instead of the App Router's
  // generic "Application error" crash boundary. Any OTHER error is
  // re-thrown — those are genuine bugs and should surface loudly.
  //
  // The shortcode-options query is CHEAP (catalog lookup, no legs)
  // so we fetch it inside the try but recover on its own if it
  // was the only casualty.
  let pageResult: Awaited<ReturnType<typeof loadSessionPage>> | QueryTimeout;
  let summary:    Awaited<ReturnType<typeof loadBillableSummary>> | QueryTimeout;
  let shortcodeOpts: Awaited<ReturnType<typeof loadShortcodeOptions>> = [];
  try {
    [pageResult, summary, shortcodeOpts] = await Promise.all([
      loadSessionPage(filters, session.shortcodeIds, page, pageSize),
      loadBillableSummary(filters, session.shortcodeIds),
      loadShortcodeOptions(session.shortcodeIds),
    ]);
  } catch (e) {
    if (!isPgTimeoutError(e)) throw e;
    shortcodeOpts = await loadShortcodeOptions(session.shortcodeIds).catch(() => []);
    pageResult = { __timeout: true, windowDays };
    summary    = { __timeout: true, windowDays };
  }

  if (isTimeout(pageResult)) {
    return (
      <div className="space-y-6">
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="text-2xl font-semibold">Sessions</h1>
        </div>
        <Filters
          defaults={filters}
          pageSize={pageSize}
          shortcodeOptions={shortcodeOpts}
          action="/sessions"
        />
        <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-800 p-4 text-sm">
          <p className="font-medium text-amber-900 dark:text-amber-100">
            Filter is too wide — Postgres cancelled the query at 30&nbsp;seconds.
          </p>
          <p className="mt-2 text-amber-900 dark:text-amber-200">
            You asked for {windowDays}&nbsp;days of per-session detail. The
            per-session view has to touch every leg in that window; at gateway
            scale that easily blows the query-timeout cap.
          </p>
          <ul className="mt-2 list-disc pl-5 text-amber-900 dark:text-amber-200">
            <li>Narrow the date range to 7&nbsp;days or fewer, OR</li>
            <li>Add an operator + shortcode filter to reduce the row set, OR</li>
            <li>Use&nbsp;
              <Link href={`/summary${sp.from || sp.to ? "?" : ""}${sp.from ? `from=${sp.from}` : ""}${sp.from && sp.to ? "&" : ""}${sp.to ? `to=${sp.to}` : ""}`}
                    className="underline font-medium">Reports&nbsp;Summary</Link>
              &nbsp;for aggregate views over long windows (backed by the
              nightly rollup — sub-second even on 30&nbsp;days).
            </li>
          </ul>
        </div>
      </div>
    );
  }
  // TS narrowing — past the `isTimeout` early-return above, both
  // values are their real result types. We shadow the union locals
  // with concrete-typed constants so the rest of the render doesn't
  // need to case-split every access.
  const pageResultOk = pageResult as Awaited<ReturnType<typeof loadSessionPage>>;
  const summaryOk    = summary    as Awaited<ReturnType<typeof loadBillableSummary>>;

  const totalPages = Math.max(1, Math.ceil(pageResultOk.totalKnown / pageSize));
  const fromIdx = pageResultOk.rows.length ? (page - 1) * pageSize + 1 : 0;
  const toIdx = (page - 1) * pageSize + pageResultOk.rows.length;

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
        {summaryOk.per_operator.map((op) => (
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
          <div className="text-lg font-semibold tabular-nums">{summaryOk.total_billable_units.toLocaleString()}</div>
          <div className="text-[10px] text-amber-700/80 dark:text-amber-300/80">across all MNOs</div>
        </div>
      </div>

      <FilterBar basePath="/sessions" sp={sp} />
      <Filters defaults={filters} pageSize={pageSize} shortcodeOptions={shortcodeOpts} action="/sessions" />

      <div className="text-sm text-slate-500">
        {pageResultOk.totalKnown === 0
          ? "No matching sessions."
          : <>
              Showing <span className="font-mono">{fromIdx.toLocaleString()}–{toIdx.toLocaleString()}</span>
              {" "}of <span className="font-mono">{fmtCount(pageResultOk.totalKnown, pageResultOk.totalCapped)}</span>
              {" "}session(s)
            </>}
      </div>

      <div className="overflow-x-auto rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <table className="min-w-full text-left">
          <thead className="bg-brand-header">
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
            {pageResultOk.rows.map((r) =>
              <ExpandableSessionRow key={`${r.operator_name}:${r.session_id}`} row={r} />
            )}
            {pageResultOk.rows.length === 0 ? (
              <tr><td className="px-2 py-6 text-center text-sm text-slate-500" colSpan={12}>
                No sessions match the current filters.
              </td></tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {pageResultOk.totalKnown > pageSize ? (
        <div className="flex items-center gap-2 text-sm">
          <Link
            href={`/sessions${buildQs(sp, { page: String(Math.max(1, page - 1)) })}`}
            className={`rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1 ${page <= 1 ? "pointer-events-none opacity-40" : ""}`}
          >
            ← Prev
          </Link>
          <span className="text-slate-500">
            Page <span className="font-mono">{page}</span> of <span className="font-mono">{pageResultOk.totalCapped ? `${totalPages}+` : totalPages}</span>
          </span>
          <Link
            href={`/sessions${buildQs(sp, { page: String(page + 1) })}`}
            className={`rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1 ${page >= totalPages && !pageResultOk.totalCapped ? "pointer-events-none opacity-40" : ""}`}
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
