/**
 * Sticky filter bar — MNO pill toggles + date quick-picks. Server
 * component (no client state needed); each pill / quick-pick is just
 * a <Link> that toggles the corresponding URL search param. Apply on
 * /sessions and /reports — both pages key off the same searchParams.
 */
import Link from "next/link";

const OPERATORS = ["vodacom", "airtel", "tigo", "halotel"] as const;

/** Defaults `from` to the last-24h window when neither `from` nor
 *  `to` is in the URL — avoids unbounded queries against the full
 *  partitioned table. Returns an ISO date (YYYY-MM-DD), in UTC. */
export function defaultFromIfMissing(
  sp: Record<string, string | string[] | undefined>,
): string | undefined {
  if (sp.from || sp.to) return undefined;
  const d = new Date(Date.now() - 24 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

function setQs(
  sp: Record<string, string | string[] | undefined>,
  overrides: Record<string, string | string[] | undefined>,
): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (k in overrides) continue;
    if (v === undefined) continue;
    if (Array.isArray(v)) v.forEach((x) => p.append(k, x));
    else p.set(k, v);
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) v.forEach((x) => p.append(k, x));
    else p.set(k, v);
  }
  // page resets on filter change so the user lands on row 1
  p.delete("page");
  const s = p.toString();
  return s ? `?${s}` : "";
}

function toggleOperator(
  sp: Record<string, string | string[] | undefined>,
  op: string,
): string {
  const cur = sp.operator;
  const arr = cur === undefined ? [] : (Array.isArray(cur) ? cur : [cur]);
  const next = arr.includes(op) ? arr.filter((x) => x !== op) : [...arr, op];
  return setQs(sp, { operator: next.length ? next : undefined });
}

function isOperatorActive(
  sp: Record<string, string | string[] | undefined>,
  op: string,
): boolean {
  const cur = sp.operator;
  if (cur === undefined) return false;
  return Array.isArray(cur) ? cur.includes(op) : cur === op;
}

interface QuickPick {
  label: string;
  /** millis ago from now for the `from` field (UTC midnight bucketed). */
  ms: number;
}

const QUICK_PICKS: QuickPick[] = [
  { label: "1h",  ms: 1   * 3600 * 1000 },
  { label: "24h", ms: 24  * 3600 * 1000 },
  { label: "7d",  ms: 168 * 3600 * 1000 },
  { label: "30d", ms: 720 * 3600 * 1000 },
];

function quickPickHref(
  basePath: string,
  sp: Record<string, string | string[] | undefined>,
  pick: QuickPick,
): string {
  const d = new Date(Date.now() - pick.ms);
  const fromIso = d.toISOString().slice(0, 10);
  return `${basePath}${setQs(sp, { from: fromIso, to: undefined })}`;
}

function pickActive(
  sp: Record<string, string | string[] | undefined>,
  pick: QuickPick,
): boolean {
  if (!sp.from || sp.to) return false;
  const want = new Date(Date.now() - pick.ms).toISOString().slice(0, 10);
  return sp.from === want;
}

interface Props {
  basePath: "/sessions" | "/reports";
  sp: Record<string, string | string[] | undefined>;
  /** Maximum date-range window (days) this page supports. Quick-picks
   *  that exceed this are dropped from the pill row and the footer
   *  hint reflects the cap. /sessions uses 7 to keep per-session
   *  aggregation snappy; /reports leaves it unset (30d allowed). */
  maxWindowDays?: number;
}

export default function FilterBar({ basePath, sp, maxWindowDays }: Props) {
  const picks = maxWindowDays === undefined
    ? QUICK_PICKS
    : QUICK_PICKS.filter((p) => Math.round(p.ms / (24 * 3600 * 1000)) <= maxWindowDays);

  return (
    <div className="sticky top-[57px] z-10 -mx-6 px-6 py-2 bg-slate-50/95 dark:bg-slate-950/95 backdrop-blur border-b border-slate-200 dark:border-slate-800">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">

        {/* MNO pills */}
        <div className="flex items-center gap-1">
          <span className="text-slate-500 uppercase tracking-wider text-[10px] mr-1">MNO</span>
          {OPERATORS.map((op) => {
            const active = isOperatorActive(sp, op);
            return (
              <Link
                key={op}
                href={`${basePath}${toggleOperator(sp, op)}`}
                className={[
                  "rounded-full px-2.5 py-0.5 border font-mono text-xs transition-colors",
                  active
                    ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 border-slate-900 dark:border-slate-100"
                    : "border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800",
                ].join(" ")}
              >
                {op}
              </Link>
            );
          })}
          {(Array.isArray(sp.operator) ? sp.operator.length > 0 : !!sp.operator) ? (
            <Link
              href={`${basePath}${setQs(sp, { operator: undefined })}`}
              className="text-slate-500 underline ml-1"
            >
              clear
            </Link>
          ) : null}
        </div>

        {/* Date quick-picks */}
        <div className="flex items-center gap-1">
          <span className="text-slate-500 uppercase tracking-wider text-[10px] mr-1">Range</span>
          {picks.map((p) => {
            const active = pickActive(sp, p);
            return (
              <Link
                key={p.label}
                href={quickPickHref(basePath, sp, p)}
                className={[
                  "rounded-full px-2.5 py-0.5 border font-mono text-xs transition-colors",
                  active
                    ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 border-slate-900 dark:border-slate-100"
                    : "border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800",
                ].join(" ")}
              >
                {p.label}
              </Link>
            );
          })}
          {(sp.from || sp.to) ? (
            <Link
              href={`${basePath}${setQs(sp, { from: undefined, to: undefined })}`}
              className="text-slate-500 underline ml-1"
            >
              clear
            </Link>
          ) : null}
        </div>

        <div className="ml-auto text-[10px] text-slate-500">
          Default range: last 24 hours{maxWindowDays !== undefined ? <> &middot; max range: {maxWindowDays} days on this view</> : null}.
        </div>
      </div>
    </div>
  );
}
