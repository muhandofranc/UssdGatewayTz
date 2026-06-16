/**
 * Landing page — summary tiles for the signed-in user. Counts are
 * scoped to the JWT's shortcodeIds (null = unrestricted for super_admin).
 *
 * Phase 3A: just the tiles. Reports table lives at /reports (Phase 3B).
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

function Tile({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-sm">
      <div className="text-xs uppercase tracking-wider text-slate-500">{label}</div>
      <div className="mt-1 text-3xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

export default async function Home() {
  const session = await getSession();
  if (!session) return null;       // layout already redirected; satisfy TS
  const totals = await loadTotals(session.shortcodeIds);

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

      <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5">
        <h2 className="text-lg font-medium">Reports</h2>
        <p className="mt-1 text-sm text-slate-500">
          Phase 3B — drill into individual sessions, filter by MNO / msisdn /
          shortcode / date range, and (Vodacom) count 20-second billable
          sessions.
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
