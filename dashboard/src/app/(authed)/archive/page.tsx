/**
 * /archive — super_admin-only reader over the cold session-log archive.
 *
 * When a partition passes retention it is re-parented onto
 * `ussd_session_logs_archive` (db/026) instead of being dropped. Those
 * rows are invisible to every other page by design — the live table
 * stays small and nothing plans the archive. This page is the one door
 * back in, for the forensic question that arrives three months late:
 * "what did this MSISDN actually dial?"
 *
 * Two things shape the UI:
 *   1. The archive is UNINDEXED, so a search must prune by ts. The date
 *      range is required and capped (lib/archive.ts) rather than
 *      optional, and the form defaults to a range that exists.
 *   2. Reading it is a privileged act over other people's traffic, so
 *      every search writes an audit row — including the filters, so the
 *      trail says WHAT was looked at, not merely that someone looked.
 */
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getSession, hasPerm } from "@/lib/auth";
import { Perms } from "@/lib/rbac";
import { audit, clientIp } from "@/lib/audit";
import { fmtTs } from "@/lib/datetime";
import {
  archiveCoverage, searchArchive,
  ARCHIVE_MAX_WINDOW_DAYS, ARCHIVE_ROW_CAP,
  type ArchiveRow,
} from "@/lib/archive";

type SearchParams = {
  from?: string;
  to?: string;
  msisdn?: string;
  session_id?: string;
  operator?: string;
};

export default async function ArchivePage({
  searchParams,
}: { searchParams: Promise<SearchParams> }) {
  // Defence-in-depth: middleware already gates the route on
  // ARCHIVE_VIEW, but a misconfigured middleware must not expose it.
  const session = await getSession();
  if (!session || !hasPerm(session, Perms.ARCHIVE_VIEW)) redirect("/");

  const sp = await searchParams;
  const coverage = await archiveCoverage();

  const from = (sp.from ?? "").trim();
  const to   = (sp.to   ?? "").trim();
  // A search runs only when a range was actually asked for — landing on
  // the page shouldn't scan anything.
  const searched = !!(from && to);

  let rows: ArchiveRow[] = [];
  let capped = false;
  let error: string | null = null;

  if (searched) {
    try {
      const result = await searchArchive({
        fromDate: from, toDate: to,
        msisdn:       sp.msisdn?.trim() || undefined,
        sessionId:    sp.session_id?.trim() || undefined,
        operatorName: sp.operator?.trim() || undefined,
      });
      rows = result.rows;
      capped = result.capped;
    } catch (e) {
      error = e instanceof Error ? e.message : "search failed";
    }

    // Audit the READ. Unusual for this dashboard — reads elsewhere
    // aren't logged — but this one reaches data the platform otherwise
    // treats as gone, so "who opened the archive, for what" is worth
    // keeping. MSISDN is recorded as a flag, not a value: the trail
    // shouldn't become a second copy of the thing it guards.
    const h = await headers();
    await audit({
      actor: session.email,
      action: "archive.search",
      target: `${from}..${to}`,
      outcome: error ? "failure" : "success",
      ip: clientIp(h), userAgent: h.get("user-agent"),
      detail: {
        from, to,
        msisdn: sp.msisdn?.trim() ? "redacted" : null,
        session_id: sp.session_id?.trim() || null,
        operator: sp.operator?.trim() || null,
        rows: rows.length, capped, error,
      },
    });
  }

  const coverFrom = coverage.from ? coverage.from.slice(0, 10) : null;
  const coverTo   = coverage.to   ? coverage.to.slice(0, 10)   : null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-semibold">Archive</h1>
        <span className="text-xs text-slate-500">
          cold storage · super admin only · every search is audited
        </span>
      </div>

      {/* What's actually in there. Without this an empty result is
          ambiguous: no matching rows, or no data for that period at
          all? The coverage line answers that before a search is run. */}
      <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 text-sm">
        {coverage.partitions === 0 ? (
          <p className="text-slate-500">
            Nothing archived yet. Partitions move here once they pass the
            120-day retention window; until then every session is still on
            the live pages.
          </p>
        ) : (
          <p className="text-slate-600 dark:text-slate-300">
            Holding <strong>{coverage.partitions}</strong> partition
            {coverage.partitions === 1 ? "" : "s"} covering{" "}
            <strong>{coverFrom}</strong> to <strong>{coverTo}</strong>{" "}
            <span className="text-slate-500">({coverage.size})</span>.
          </p>
        )}
      </div>

      <form method="GET" className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 grid gap-3 md:grid-cols-5 items-end">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">From</span>
          <input type="date" name="from" required defaultValue={from}
                 min={coverFrom ?? undefined} max={coverTo ?? undefined}
                 className="rounded-md border border-slate-300 dark:border-slate-700 bg-transparent px-2 py-1.5" />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">To</span>
          <input type="date" name="to" required defaultValue={to}
                 min={coverFrom ?? undefined} max={coverTo ?? undefined}
                 className="rounded-md border border-slate-300 dark:border-slate-700 bg-transparent px-2 py-1.5" />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">MSISDN</span>
          <input type="text" name="msisdn" defaultValue={sp.msisdn ?? ""}
                 placeholder="255700000000"
                 className="rounded-md border border-slate-300 dark:border-slate-700 bg-transparent px-2 py-1.5 font-mono" />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Session ID</span>
          <input type="text" name="session_id" defaultValue={sp.session_id ?? ""}
                 className="rounded-md border border-slate-300 dark:border-slate-700 bg-transparent px-2 py-1.5 font-mono" />
        </label>
        <button className="rounded-md bg-onfon-red text-white px-3 py-1.5 text-sm font-medium">
          Search
        </button>
        <p className="md:col-span-5 text-xs text-slate-500">
          Archived partitions carry no indexes, so a search reads the days
          you name end to end — the range is limited to{" "}
          <strong>{ARCHIVE_MAX_WINDOW_DAYS} days</strong> at a time and
          runs on the report pool. Expect a second or so per day searched.
        </p>
      </form>

      {error ? (
        <div className="rounded-md border border-rose-200 dark:border-rose-900/50 bg-rose-50 dark:bg-rose-950/40 text-rose-800 dark:text-rose-200 px-3 py-2 text-sm">
          {error}
        </div>
      ) : null}

      {capped ? (
        <div className="rounded-md border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-200 px-3 py-2 text-sm">
          Showing the {ARCHIVE_ROW_CAP} most recent matches — there are more.
          Narrow the range or add an MSISDN to see the rest.
        </div>
      ) : null}

      {searched && !error ? (
        <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-slate-500 border-b border-slate-200 dark:border-slate-800">
              <tr>
                <th className="px-2 py-2">Time</th>
                <th className="px-2 py-2">Operator</th>
                <th className="px-2 py-2">MSISDN</th>
                <th className="px-2 py-2">Session</th>
                <th className="px-2 py-2">Dir</th>
                <th className="px-2 py-2">Dialed</th>
                <th className="px-2 py-2">Response</th>
                <th className="px-2 py-2">Error</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.session_id}-${r.ts}-${i}`}
                    className="border-b border-slate-100 dark:border-slate-800/60">
                  <td className="px-2 py-1.5 text-xs whitespace-nowrap">{fmtTs(r.ts)}</td>
                  <td className="px-2 py-1.5 text-xs">{r.operator_name}</td>
                  <td className="px-2 py-1.5 text-xs font-mono">{r.msisdn ?? "—"}</td>
                  <td className="px-2 py-1.5 text-xs font-mono max-w-[12rem] truncate" title={r.session_id}>
                    {r.session_id}
                  </td>
                  <td className="px-2 py-1.5 text-xs">{r.direction}</td>
                  <td className="px-2 py-1.5 text-xs font-mono">{r.ussd_string ?? "—"}</td>
                  <td className="px-2 py-1.5 text-xs max-w-[18rem] truncate"
                      title={r.handler_response_text ?? ""}>
                    {r.handler_response_action ?? "—"}
                    {r.handler_response_text ? ` · ${r.handler_response_text}` : ""}
                  </td>
                  <td className="px-2 py-1.5 text-xs">
                    {r.error_class ? (
                      <span className="inline-flex items-center rounded-md bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 px-1.5 py-0.5">
                        {r.error_class}
                      </span>
                    ) : "—"}
                  </td>
                </tr>
              ))}
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-2 py-6 text-center text-sm text-slate-500">
                    No archived legs match those filters in {from} → {to}.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
