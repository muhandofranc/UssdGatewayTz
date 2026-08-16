/**
 * Landing page — summary tiles + daily traffic-by-network bar chart.
 * Counts are scoped to the JWT's shortcodeIds (null = unrestricted
 * for super_admin).
 */
import type { ReactNode } from "react";
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

// Distinct brand-leaning fills so a grouped column stays readable.
// Static Tailwind classes (NOT a template) so the JIT picks them up.
const OPERATOR_FILL: Record<Operator, string> = {
  vodacom: "bg-red-700",     // brand red, darker
  airtel:  "bg-red-400",     // brand red, lighter — pairs with vodacom
  tigo:    "bg-blue-500",
  halotel: "bg-orange-500",
};

// ---------------------------------------------------------------------
//  Inline icons (no dependency; stroke = currentColor)
// ---------------------------------------------------------------------
function Svg({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
         strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
      {children}
    </svg>
  );
}
const IconLayers   = <Svg><path d="M12 3 3 8l9 5 9-5-9-5Z" /><path d="m3 12 9 5 9-5" /><path d="m3 16 9 5 9-5" /></Svg>;
const IconClock    = <Svg><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Svg>;
const IconActivity = <Svg><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></Svg>;
const IconAlert    = <Svg><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4" /><path d="M12 17h.01" /></Svg>;
const IconGrid     = <Svg><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /></Svg>;
const IconList     = <Svg><path d="M8 6h13" /><path d="M8 12h13" /><path d="M8 18h13" /><path d="M3 6h.01" /><path d="M3 12h.01" /><path d="M3 18h.01" /></Svg>;
const IconChart    = <Svg><path d="M3 3v18h18" /><rect x="7" y="10" width="3" height="7" rx="1" /><rect x="13" y="6" width="3" height="11" rx="1" /></Svg>;
const IconBeaker   = <Svg><path d="M9 3h6" /><path d="M10 3v6.5L5 18a2 2 0 0 0 1.7 3h10.6A2 2 0 0 0 19 18l-5-8.5V3" /><path d="M7 14h10" /></Svg>;
const IconArrow    = <Svg><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></Svg>;

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

type Tone = "slate" | "sky" | "emerald" | "rose";
const TONE_ICON: Record<Tone, string> = {
  slate:   "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
  sky:     "bg-sky-50 text-sky-600 dark:bg-sky-950/50 dark:text-sky-400",
  emerald: "bg-emerald-50 text-emerald-600 dark:bg-emerald-950/50 dark:text-emerald-400",
  rose:    "bg-rose-50 text-rose-600 dark:bg-rose-950/50 dark:text-rose-400",
};

function Tile({
  label, value, hint, icon, tone = "slate",
}: {
  label: string;
  value: string | number;
  hint?: ReactNode;
  icon: ReactNode;
  tone?: Tone;
}) {
  return (
    <div className="group rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-sm transition-all duration-200 hover:shadow-md hover:border-slate-300 dark:hover:border-slate-700">
      <div className="flex items-center gap-3">
        <div className={`flex h-9 w-9 items-center justify-center rounded-xl ${TONE_ICON[tone]}`}>
          {icon}
        </div>
        <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
          {label}
        </div>
      </div>
      <div className="mt-3 text-3xl font-semibold tabular-nums tracking-tight">{value}</div>
      <div className="mt-1 min-h-[1rem] text-xs text-slate-500">{hint}</div>
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
  // so the scale reference is the biggest single MNO-day cell.
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
      {/* Chart area — dashed gridlines behind, grouped bars in front.
          Each day is a sub-group of narrow bars (one per MNO). A 2px
          min-height keeps a tiny non-zero bar visible. */}
      <div className="relative h-52">
        <div className="pointer-events-none absolute inset-0 flex flex-col justify-between">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="border-t border-dashed border-slate-100 dark:border-slate-800/70" />
          ))}
        </div>
        <div className="relative flex h-full items-end gap-1 border-b border-slate-200 dark:border-slate-800 pb-px">
          {grid.map((g) => (
            <div
              key={g.day}
              className="flex h-full flex-1 items-end gap-px rounded-sm transition-colors hover:bg-slate-100/60 dark:hover:bg-slate-800/40"
              title={`Day ${g.day} — ${g.total.toLocaleString()} session counts`}
            >
              {OPERATORS.map((op) => {
                const n = g.counts[op] ?? 0;
                const heightPct = (n / max) * 100;
                return (
                  <div
                    key={op}
                    className={`flex-1 shrink-0 rounded-t transition-opacity hover:opacity-80 ${OPERATOR_FILL[op]}`}
                    style={{ height: `${heightPct}%`, minHeight: n > 0 ? 2 : 0 }}
                    title={`${op}: ${n.toLocaleString()}`}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {/* Day-of-month labels */}
      <div className="mt-1 flex gap-1 text-[10px] tabular-nums text-slate-400">
        {grid.map((g) => (
          <div key={g.day} className="flex-1 text-center">
            {g.day}
          </div>
        ))}
      </div>

      {/* Legend + peak + month total */}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 dark:border-slate-800 pt-3">
        <div className="flex flex-wrap gap-4 text-xs">
          {OPERATORS.map((op) => (
            <div key={op} className="flex items-center gap-1.5">
              <span className={`inline-block w-3 h-3 rounded-sm ${OPERATOR_FILL[op]}`} />
              <span className="capitalize text-slate-700 dark:text-slate-300">{op}</span>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-4 text-xs text-slate-500">
          <span>peak/day <span className="font-mono tabular-nums text-slate-700 dark:text-slate-300">{max.toLocaleString()}</span></span>
          <span>total <span className="font-mono tabular-nums text-slate-700 dark:text-slate-300">{grandTotal.toLocaleString()}</span></span>
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
        className="rounded-md bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 px-3 py-1 text-sm font-medium hover:opacity-90 transition-opacity"
      >
        Apply
      </button>
    </form>
  );
}

const QUICK_LINKS: { href: string; title: string; desc: string; icon: ReactNode }[] = [
  { href: "/sessions",  title: "Sessions",         desc: "Per-session summary & billing units", icon: IconGrid },
  { href: "/reports",   title: "Session Hops",     desc: "Per-leg detail, filter & drill in",   icon: IconList },
  { href: "/summary",   title: "Reports Summary",  desc: "Aggregate counts over long windows",  icon: IconChart },
  { href: "/simulator", title: "Handler Simulator", desc: "Test a shortcode's handler URL live", icon: IconBeaker },
];

function QuickLinks() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {QUICK_LINKS.map((l) => (
        <Link
          key={l.href}
          href={l.href}
          className="group rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md hover:border-onfon-red/40"
        >
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-slate-100 text-slate-600 transition-colors group-hover:bg-onfon-red/10 group-hover:text-onfon-red dark:bg-slate-800 dark:text-slate-300">
              {l.icon}
            </div>
            <div className="font-medium">{l.title}</div>
            <span className="ml-auto text-slate-300 transition-all group-hover:translate-x-0.5 group-hover:text-onfon-red">
              {IconArrow}
            </span>
          </div>
          <p className="mt-2 text-xs text-slate-500">{l.desc}</p>
        </Link>
      ))}
    </div>
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

  const legs24 = Number(totals.rows_24h);
  const legs1h = Number(totals.rows_1h);
  const sessions24 = Number(totals.unique_sessions_24h);
  const err24 = Number(totals.err_24h);
  const errRate = legs24 > 0 ? (err24 / legs24) * 100 : 0;
  const legsPerSession = sessions24 > 0 ? legs24 / sessions24 : 0;

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            Live USSD traffic &amp; billing across your networks.
          </p>
        </div>
        <div className="rounded-full border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-1 text-xs text-slate-500">
          Scope:{" "}
          <span className="font-mono text-slate-700 dark:text-slate-300">
            {session.shortcodeIds === null
              ? "all shortcodes"
              : `${session.shortcodeIds.length} owned`}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Tile
          label="Legs · 24h" tone="slate" icon={IconLayers}
          value={legs24.toLocaleString()}
          hint={<><span className="font-mono tabular-nums text-slate-600 dark:text-slate-300">{legs1h.toLocaleString()}</span> in the last hour</>}
        />
        <Tile
          label="Legs · 1h" tone="sky" icon={IconClock}
          value={legs1h.toLocaleString()}
          hint="rolling 60-minute window"
        />
        <Tile
          label="Sessions · 24h" tone="emerald" icon={IconActivity}
          value={sessions24.toLocaleString()}
          hint={sessions24 > 0 ? <><span className="font-mono tabular-nums text-slate-600 dark:text-slate-300">{legsPerSession.toFixed(1)}</span> legs / session</> : "no sessions yet"}
        />
        <Tile
          label="Errors · 24h" tone={err24 > 0 ? "rose" : "emerald"} icon={IconAlert}
          value={err24.toLocaleString()}
          hint={<><span className={`font-mono tabular-nums ${err24 > 0 ? "text-rose-600 dark:text-rose-400" : "text-emerald-600 dark:text-emerald-400"}`}>{errRate.toFixed(1)}%</span> error rate</>}
        />
      </div>

      <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-sm">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Daily traffic by network</h2>
            <p className="text-xs text-slate-500">
              Session counts per day, by MNO — sums each operator&rsquo;s
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

      <div>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-500">
          Jump to
        </h2>
        <QuickLinks />
      </div>
    </div>
  );
}
