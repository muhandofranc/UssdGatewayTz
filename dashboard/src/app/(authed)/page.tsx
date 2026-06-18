/**
 * Landing page — summary tiles + daily traffic-by-network bar chart.
 * Counts are scoped to the JWT's shortcodeIds (null = unrestricted
 * for super_admin).
 */
import { getSession } from "@/lib/auth";
import { query } from "@/lib/db";
import { loadDailyTraffic, type DailyTrafficRow } from "@/lib/overview";
import Link from "next/link";

interface Totals {
  rows_24h: string;            // pg returns bigint as string
  rows_1h: string;
  unique_sessions_24h: string;
  err_24h: string;
}

// ---------------------------------------------------------------------
//  Operator colour map. Static Tailwind classes (NOT a template) so
//  the JIT picks them up. If a new operator is added in the operators
//  table, append it here; rows with an unmapped operator render in
//  slate as a defensive fallback.
// ---------------------------------------------------------------------
const OPERATORS = ["airtel", "vodacom", "tigo", "halotel"] as const;
type Operator = typeof OPERATORS[number];

// Distinct brand-leaning fills so a stacked column stays readable even
// when both red-family Vodacom & Airtel show on the same day. Static
// Tailwind classes (NOT a template) so the JIT picks them up.
const OPERATOR_FILL: Record<Operator, string> = {
  vodacom: "bg-red-700",     // brand red, darker
  airtel:  "bg-red-400",     // brand red, lighter — pairs with vodacom
  tigo:    "bg-blue-500",
  halotel: "bg-orange-500",
};

// ---------------------------------------------------------------------
//  Server queries
// ---------------------------------------------------------------------

async function loadTotals(shortcodeIds: number[] | null): Promise<Totals> {
  const scClause = shortcodeIds === null
    ? "TRUE"
    : (shortcodeIds.length === 0 ? "FALSE" : "shortcode_id = ANY($1::int[])");
  const params = shortcodeIds === null || shortcodeIds.length === 0 ? [] : [shortcodeIds];
  const r = await query<Totals>(
    `SELECT
       (SELECT COUNT(*) FROM ussd_session_logs WHERE ts > now() - interval '24 hours' AND ${scClause}) AS rows_24h,
       (SELECT COUNT(*) FROM ussd_session_logs WHERE ts > now() - interval '1 hour'   AND ${scClause}) AS rows_1h,
       (SELECT COUNT(DISTINCT session_id) FROM ussd_session_logs WHERE ts > now() - interval '24 hours' AND ${scClause}) AS unique_sessions_24h,
       (SELECT COUNT(*) FROM ussd_session_logs WHERE ts > now() - interval '24 hours' AND error_class IS NOT NULL AND ${scClause}) AS err_24h`,
    params,
  );
  return r.rows[0]!;
}

// ---------------------------------------------------------------------
//  Components
// ---------------------------------------------------------------------

function Tile({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-sm">
      <div className="text-xs uppercase tracking-wider text-slate-500">{label}</div>
      <div className="mt-1 text-3xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

interface DayCell {
  day: number;
  total: number;
  counts: Record<string, number>;
}

function buildMonthGrid(rows: DailyTrafficRow[], monthYM: string): DayCell[] {
  const [yr, mo] = monthYM.split("-").map(Number);
  // Date(year, month, 0) = day 0 of next month = last day of current month.
  const lastDay = new Date(yr, mo, 0).getDate();
  // Bucket the rows for O(N) lookup instead of O(N^2) per-cell find.
  const byKey: Record<string, number> = {};
  for (const r of rows) {
    byKey[`${r.day}|${r.operator_name}`] = r.billable_units;
  }
  const grid: DayCell[] = [];
  for (let d = 1; d <= lastDay; d++) {
    const ds = `${monthYM}-${String(d).padStart(2, "0")}`;
    const counts: Record<string, number> = {};
    let total = 0;
    for (const op of OPERATORS) {
      const n = byKey[`${ds}|${op}`] ?? 0;
      counts[op] = n;
      total += n;
    }
    grid.push({ day: d, total, counts });
  }
  return grid;
}

function TrafficBarChart({ rows, monthYM }: { rows: DailyTrafficRow[]; monthYM: string }) {
  const grid = buildMonthGrid(rows, monthYM);
  // Grouped bars: each sub-bar represents ONE MNO's count for ONE day,
  // so the scale reference is the biggest single MNO-day cell — NOT
  // the biggest day total (which was the stacked-bar reference). This
  // way a bar's relative height is directly comparable to every other
  // bar in the chart.
  let max = 1;
  for (const g of grid) {
    for (const op of OPERATORS) {
      const n = g.counts[op] ?? 0;
      if (n > max) max = n;
    }
  }
  const grandTotal = grid.reduce((s, g) => s + g.total, 0);

  return (
    <div>
      {/* Bars row — each day is a sub-group of 4 narrow bars (one per
          MNO) standing side-by-side. Within each day-group we use
          `items-end` so each MNO bar grows up from the day's baseline.
          Outer container DOESN'T use items-end (its children are the
          day-groups, which need full height for their inner items-end
          to reference; same percent-height trap as in the stacked
          version's note). */}
      <div className="flex gap-1 h-48 border-b border-slate-200 dark:border-slate-800 pb-px">
        {grid.map((g) => (
          <div
            key={g.day}
            className="flex-1 flex items-end gap-px h-full"
            title={`Day ${g.day} — ${g.total.toLocaleString()} session counts`}
          >
            {OPERATORS.map((op) => {
              const n = g.counts[op] ?? 0;
              const heightPct = (n / max) * 100;
              return (
                <div
                  key={op}
                  // flex-1 reserves equal width for every MNO slot so
                  // empty-traffic days still show 4 placeholders aligned
                  // with neighbouring days. shrink-0 preserves the
                  // explicit percent height against flex's default
                  // shrink-and-redistribute behaviour.
                  className={`flex-1 shrink-0 rounded-t ${OPERATOR_FILL[op]}`}
                  style={{ height: `${heightPct}%` }}
                  title={`${op}: ${n.toLocaleString()}`}
                />
              );
            })}
          </div>
        ))}
      </div>

      {/* Day-of-month labels */}
      <div className="flex gap-1 mt-1 text-[10px] tabular-nums text-slate-500">
        {grid.map((g) => (
          <div key={g.day} className="flex-1 text-center">
            {g.day}
          </div>
        ))}
      </div>

      {/* Legend + month total */}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-4 text-xs">
          {OPERATORS.map((op) => (
            <div key={op} className="flex items-center gap-1.5">
              <span className={`inline-block w-3 h-3 rounded-sm ${OPERATOR_FILL[op]}`} />
              <span className="capitalize text-slate-700 dark:text-slate-300">{op}</span>
            </div>
          ))}
        </div>
        <div className="text-xs text-slate-500">
          Total: <span className="font-mono tabular-nums">{grandTotal.toLocaleString()}</span> session counts
        </div>
      </div>
    </div>
  );
}

function monthOptions(): { value: string; label: string }[] {
  // Last 12 months including the current one, newest first.
  const opts: { value: string; label: string }[] = [];
  const now = new Date();
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const label = d.toLocaleString("en-US", { month: "long", year: "numeric" });
    opts.push({ value, label });
  }
  return opts;
}

function MonthFilter({ current }: { current: string }) {
  const options = monthOptions();
  return (
    <form method="GET" action="/" className="flex items-center gap-2">
      <label htmlFor="month-select" className="text-xs text-slate-500">
        Month
      </label>
      <select
        id="month-select"
        name="month"
        defaultValue={current}
        className="rounded-md border border-slate-300 dark:border-slate-700 bg-transparent px-2 py-1 text-sm font-mono"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <button
        type="submit"
        className="rounded-md bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 px-3 py-1 text-sm font-medium"
      >
        Apply
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------
//  Page
// ---------------------------------------------------------------------

export default async function Home({
  searchParams,
}: {
  // Next 15: searchParams is a Promise on server components.
  searchParams: Promise<{ month?: string }>;
}) {
  const sp = await searchParams;
  const month = sp.month && /^\d{4}-\d{2}$/.test(sp.month)
    ? sp.month
    : new Date().toISOString().slice(0, 7);

  const session = await getSession();
  if (!session) return null;       // layout already redirected; satisfy TS

  // Fire totals + chart query in parallel — independent reads, no
  // ordering between them.
  const [totals, daily] = await Promise.all([
    loadTotals(session.shortcodeIds),
    loadDailyTraffic(session.shortcodeIds, month),
  ]);

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Overview</h1>
        <div className="text-sm text-slate-500">
          Scope:{" "}
          <span className="font-mono">
            {session.shortcodeIds === null
              ? "all shortcodes (super_admin)"
              : `${session.shortcodeIds.length} owned shortcode(s)`}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Tile label="Legs · 24h"     value={Number(totals.rows_24h).toLocaleString()} />
        <Tile label="Legs · 1h"      value={Number(totals.rows_1h).toLocaleString()} />
        <Tile label="Sessions · 24h" value={Number(totals.unique_sessions_24h).toLocaleString()} />
        <Tile label="Errors · 24h"   value={Number(totals.err_24h).toLocaleString()} />
      </div>

      <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-sm">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h2 className="text-lg font-medium">Daily traffic by network</h2>
            <p className="text-xs text-slate-500">
              Session counts per day, by MNO — sums each operator's
              billable units (CEIL(duration / billing window); 1 unit
              per session for per-leg MNOs). Day boundaries in Africa/Nairobi.
            </p>
          </div>
          <MonthFilter current={month} />
        </div>
        <div className="mt-5">
          <TrafficBarChart rows={daily} monthYM={month} />
        </div>
      </div>

      <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5">
        <h2 className="text-lg font-medium">Reports</h2>
        <p className="mt-1 text-sm text-slate-500">
          Drill into individual sessions, filter by MNO / msisdn / shortcode /
          date range, and (Vodacom) count 20-second billable sessions.
        </p>
        <Link
          href="/reports"
          className="mt-3 inline-flex rounded-md bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 px-3 py-1.5 text-sm font-medium"
        >
          Open reports
        </Link>
      </div>
    </div>
  );
}
