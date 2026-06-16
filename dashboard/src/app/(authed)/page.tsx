/**
 * Landing page — summary tiles + daily traffic-by-network bar chart.
 * Counts are scoped to the JWT's shortcodeIds (null = unrestricted
 * for super_admin).
 */
import { getSession } from "@/lib/auth";
import { query } from "@/lib/db";
import Link from "next/link";

interface Totals {
  rows_24h: string;            // pg returns bigint as string
  rows_1h: string;
  unique_sessions_24h: string;
  err_24h: string;
}

interface DailyTrafficRow {
  day: string;                 // 'YYYY-MM-DD' (Africa/Nairobi local)
  operator_name: string;
  legs: number;
}

// ---------------------------------------------------------------------
//  Operator colour map. Static Tailwind classes (NOT a template) so
//  the JIT picks them up. If a new operator is added in the operators
//  table, append it here; rows with an unmapped operator render in
//  slate as a defensive fallback.
// ---------------------------------------------------------------------
const OPERATORS = ["airtel", "vodacom", "tigo", "halotel"] as const;
type Operator = typeof OPERATORS[number];

const OPERATOR_FILL: Record<Operator, string> = {
  airtel:  "bg-red-500",
  vodacom: "bg-violet-500",
  tigo:    "bg-amber-500",
  halotel: "bg-emerald-500",
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

async function loadDailyTraffic(
  shortcodeIds: number[] | null,
  monthYM: string,             // 'YYYY-MM'
): Promise<DailyTrafficRow[]> {
  // Africa/Nairobi day boundaries — the gateway operates in EAT and
  // the dashboard's "today" should match. Without the AT TIME ZONE,
  // late-night UTC legs would tip into the next day's bucket.
  const scClause = shortcodeIds === null
    ? "TRUE"
    : (shortcodeIds.length === 0 ? "FALSE" : "shortcode_id = ANY($1::int[])");
  const baseParams = shortcodeIds === null || shortcodeIds.length === 0 ? [] : [shortcodeIds];
  const monthStart = `${monthYM}-01`;
  const params = [...baseParams, monthStart];
  const ix = baseParams.length + 1;       // $1 or $2 depending on whether scClause uses $1

  const r = await query<{ day: string; operator_name: string; legs: string }>(
    `SELECT
       to_char(date_trunc('day', ts AT TIME ZONE 'Africa/Nairobi'), 'YYYY-MM-DD') AS day,
       operator_name,
       COUNT(*)::bigint AS legs
       FROM ussd_session_logs
      WHERE ts >= ($${ix}::date AT TIME ZONE 'Africa/Nairobi')
        AND ts <  (($${ix}::date AT TIME ZONE 'Africa/Nairobi') + interval '1 month')
        AND ${scClause}
      GROUP BY 1, 2
      ORDER BY 1, 2`,
    params,
  );
  return r.rows.map((x) => ({
    day: x.day,
    operator_name: x.operator_name,
    legs: Number(x.legs),
  }));
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
    byKey[`${r.day}|${r.operator_name}`] = r.legs;
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
  const max = Math.max(1, ...grid.map((g) => g.total));
  const grandTotal = grid.reduce((s, g) => s + g.total, 0);

  return (
    <div>
      {/* Bars row — h-48 (192px) gives reasonable resolution across MNO mixes.
          NOTE on CSS: we DO NOT use `items-end` here. Without it, columns
          stretch to the full 192px (default `items-stretch`), giving the
          segments inside something concrete to compute `height: X%`
          against. With `items-end`, columns auto-size to content, segment
          percents become percent-of-zero, and every bar renders invisible
          even though the data is correct. `flex-col-reverse` is what
          actually pins segments to the BOTTOM of the column — the empty
          top portion just stays transparent. */}
      <div className="flex gap-1 h-48 border-b border-slate-200 dark:border-slate-800 pb-px">
        {grid.map((g) => (
          <div
            key={g.day}
            className="flex-1 flex flex-col-reverse rounded-t overflow-hidden min-h-px"
            title={`Day ${g.day} — ${g.total.toLocaleString()} legs`}
          >
            {OPERATORS.map((op) => {
              const n = g.counts[op];
              if (!n) return null;
              const heightPct = (n / max) * 100;
              return (
                <div
                  key={op}
                  // shrink-0 keeps the explicit percent height from being
                  // squashed when total segments don't fill the column —
                  // otherwise flex's default shrink redistributes space
                  // and the visual proportions stop matching the data.
                  className={`${OPERATOR_FILL[op]} shrink-0`}
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
          Total: <span className="font-mono tabular-nums">{grandTotal.toLocaleString()}</span> legs
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
              Legs per day, stacked by MNO. Day boundaries in Africa/Nairobi.
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
