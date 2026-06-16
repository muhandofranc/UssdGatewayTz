/**
 * /exports — the user's own export queue. Read-only listing; the only
 * action is "Download" once status='ready'. Export jobs are kicked
 * off from /sessions or /reports via the "Export CSV" button.
 */
import Link from "next/link";
import { getSession } from "@/lib/auth";
import { listExportsForUser, type ExportRow } from "@/lib/exports";

function fmtSize(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtTs(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function statusBadge(status: ExportRow["status"]) {
  const map = {
    queued:  "bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300",
    running: "bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300",
    ready:   "bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300",
    failed:  "bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300",
    expired: "bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300",
  } as const;
  return (
    <span className={`inline-flex items-center rounded-md ${map[status]} px-1.5 py-0.5 text-xs font-mono`}>
      {status}
    </span>
  );
}

function fmtFilters(f: Record<string, unknown>): string {
  const parts: string[] = [];
  if (f.from) parts.push(`from=${f.from}`);
  if (f.to)   parts.push(`to=${f.to}`);
  if (f.msisdn) parts.push(`msisdn=${f.msisdn}`);
  if (f.session_id) parts.push(`session_id=${f.session_id}`);
  if (Array.isArray(f.operators) && f.operators.length) parts.push(`mno=${f.operators.join(",")}`);
  if (f.error_class && f.error_class !== "any") parts.push(`err=${f.error_class}`);
  if (Array.isArray(f.shortcodeIds) && f.shortcodeIds.length) {
    parts.push(`shortcode_ids=${(f.shortcodeIds as number[]).join(",")}`);
  }
  return parts.join("  ·  ") || "(no filters)";
}

export default async function ExportsPage() {
  const session = await getSession();
  if (!session) return null;
  const rows = await listExportsForUser(Number(session.sub));

  const pending = rows.filter((r) => r.status === "queued" || r.status === "running").length;

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Exports</h1>
        <div className="text-xs text-slate-500">
          {pending > 0 ? `${pending} pending. Refresh to update.` : "All up to date."}
        </div>
      </div>

      <p className="text-xs text-slate-500">
        Trigger an export from <Link href="/sessions" className="underline">/sessions</Link> or
        <Link href="/reports" className="underline mx-1">/reports</Link>
        via the "Export CSV" button at the bottom of the filter form. Heavy exports stream
        in the background; this page lists yours and links to ready ones.
      </p>

      <div className="overflow-x-auto rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <table className="min-w-full text-left">
          <thead className="bg-slate-100 dark:bg-slate-800/60">
            <tr>
              <th className="px-2 py-2 text-xs font-medium">Requested</th>
              <th className="px-2 py-2 text-xs font-medium">Granularity</th>
              <th className="px-2 py-2 text-xs font-medium">Status</th>
              <th className="px-2 py-2 text-xs font-medium">Started</th>
              <th className="px-2 py-2 text-xs font-medium">Completed</th>
              <th className="px-2 py-2 text-xs font-medium text-right">Rows</th>
              <th className="px-2 py-2 text-xs font-medium text-right">Size</th>
              <th className="px-2 py-2 text-xs font-medium">Filters</th>
              <th className="px-2 py-2 text-xs font-medium text-right">Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-slate-200 dark:border-slate-800">
                <td className="px-2 py-1.5 text-xs font-mono whitespace-nowrap">{fmtTs(r.requested_at)}</td>
                <td className="px-2 py-1.5 text-xs font-mono">{r.granularity}</td>
                <td className="px-2 py-1.5">{statusBadge(r.status)}</td>
                <td className="px-2 py-1.5 text-xs font-mono whitespace-nowrap">{fmtTs(r.started_at)}</td>
                <td className="px-2 py-1.5 text-xs font-mono whitespace-nowrap">{fmtTs(r.completed_at)}</td>
                <td className="px-2 py-1.5 text-xs text-right tabular-nums">{r.row_count ? Number(r.row_count).toLocaleString() : "—"}</td>
                <td className="px-2 py-1.5 text-xs text-right tabular-nums">{fmtSize(r.file_size_bytes !== null ? Number(r.file_size_bytes) : null)}</td>
                <td className="px-2 py-1.5 text-xs font-mono max-w-[28rem] truncate" title={fmtFilters(r.filters)}>
                  {fmtFilters(r.filters)}
                </td>
                <td className="px-2 py-1.5 text-xs text-right">
                  {r.status === "ready" ? (
                    <a href={`/api/exports/${r.id}/download`} className="underline">Download</a>
                  ) : r.status === "failed" ? (
                    <span className="text-red-600 dark:text-red-300" title={r.error_message ?? ""}>error</span>
                  ) : r.status === "expired" ? (
                    <span className="text-amber-600 dark:text-amber-300" title="File was swept off disk by the retention sweep">retention</span>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr><td className="px-2 py-6 text-center text-sm text-slate-500" colSpan={9}>
                No exports yet.
              </td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
