/**
 * /audit — super_admin-only viewer over portal_audit_log.
 *
 * Read-only: filter form + paginated reverse-chronological table.
 * Every actor write across the dashboard goes through `audit()`
 * (lib/audit.ts) so this page is the canonical "who did what when"
 * trail for shortcodes, operators, users, viewers, exports, logins,
 * password resets, and login failures (success/failure/denied
 * outcomes).
 */
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession, hasPerm } from "@/lib/auth";
import { Perms } from "@/lib/rbac";
import {
  listActionPrefixes, listAuditLog,
  type AuditFilters, type AuditRow,
} from "@/lib/audit";

type SearchParams = {
  from?: string;
  to?: string;
  actor?: string;
  action?: string;     // prefix, e.g. "shortcode"
  outcome?: "success" | "failure" | "denied" | "";
  page?: string;
};

export default async function AuditPage({
  searchParams,
}: { searchParams: Promise<SearchParams> }) {
  // Defence-in-depth: middleware already requires AUDIT_VIEW for this
  // route, but a misconfigured middleware shouldn't expose the page.
  const session = await getSession();
  if (!session || !hasPerm(session, Perms.AUDIT_VIEW)) redirect("/");

  const sp = await searchParams;
  const filters: AuditFilters = {
    from:         sp.from || null,
    to:           sp.to   || null,
    actor:        sp.actor || null,
    actionPrefix: sp.action && sp.action !== "all" ? sp.action : null,
    outcome:      sp.outcome === "success" || sp.outcome === "failure" || sp.outcome === "denied"
                    ? sp.outcome : null,
    page:         Math.max(1, parseInt(sp.page ?? "1", 10) || 1),
    pageSize:     50,
  };

  const [{ rows, total, page, pageSize }, prefixes] = await Promise.all([
    listAuditLog(filters),
    listActionPrefixes(),
  ]);

  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  // Preserve filters in pagination links (drop the page key).
  const baseQS = new URLSearchParams();
  if (sp.from)    baseQS.set("from", sp.from);
  if (sp.to)      baseQS.set("to", sp.to);
  if (sp.actor)   baseQS.set("actor", sp.actor);
  if (sp.action)  baseQS.set("action", sp.action);
  if (sp.outcome) baseQS.set("outcome", sp.outcome);
  const linkFor = (p: number) => {
    const qs = new URLSearchParams(baseQS);
    qs.set("page", String(p));
    return `/audit?${qs.toString()}`;
  };
  const csvHref = `/api/audit/export.csv${baseQS.toString() ? "?" + baseQS.toString() : ""}`;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">Audit log</h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
            Every user write across the dashboard — logins, password
            resets, shortcodes, operators, portal users, viewers,
            exports. Read-only.
          </p>
        </div>
        <a href={csvHref}
           className="rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-sm font-medium hover:bg-slate-50 dark:hover:bg-slate-800">
          ↓ Download CSV
        </a>
      </div>

      {/* ---- Filter form ---- */}
      <form method="GET"
            className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4
                       grid gap-3 md:grid-cols-6 items-end">
        <FilterField label="From" name="from" type="datetime-local" defaultValue={isoToLocal(sp.from)} />
        <FilterField label="To"   name="to"   type="datetime-local" defaultValue={isoToLocal(sp.to)} />
        <FilterField label="Actor email" name="actor" defaultValue={sp.actor ?? ""} placeholder="substring" />
        <label className="block">
          <span className="block text-xs font-medium mb-1">Action</span>
          <select name="action"
                  defaultValue={sp.action ?? "all"}
                  className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1.5 text-sm">
            <option value="all">all</option>
            {prefixes.map((p) => (
              <option key={p} value={p}>{p}.*</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="block text-xs font-medium mb-1">Outcome</span>
          <select name="outcome"
                  defaultValue={sp.outcome ?? ""}
                  className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1.5 text-sm">
            <option value="">any</option>
            <option value="success">success</option>
            <option value="failure">failure</option>
            <option value="denied">denied</option>
          </select>
        </label>
        <div className="flex gap-2">
          <button type="submit"
                  className="rounded-md bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 px-3 py-1.5 text-sm font-medium">
            Apply
          </button>
          <Link href="/audit"
                className="rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-sm">
            Reset
          </Link>
        </div>
      </form>

      <div className="text-xs text-slate-500">
        {total.toLocaleString()} matching rows · page {page} of {pageCount}
      </div>

      {/* ---- Table ---- */}
      <div className="overflow-x-auto rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <table className="min-w-full text-left">
          <thead className="bg-slate-100 dark:bg-slate-800/60">
            <tr>
              <th className="px-2 py-2 text-xs font-medium">When (UTC)</th>
              <th className="px-2 py-2 text-xs font-medium">Actor</th>
              <th className="px-2 py-2 text-xs font-medium">Action</th>
              <th className="px-2 py-2 text-xs font-medium">Target</th>
              <th className="px-2 py-2 text-xs font-medium">Outcome</th>
              <th className="px-2 py-2 text-xs font-medium">IP</th>
              <th className="px-2 py-2 text-xs font-medium">Detail</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => <Row key={r.id} r={r} />)}
            {rows.length === 0 ? (
              <tr><td className="px-2 py-6 text-center text-sm text-slate-500" colSpan={7}>
                No matching audit rows.
              </td></tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {/* ---- Pagination ---- */}
      {pageCount > 1 ? (
        <div className="flex items-center justify-between text-sm">
          <div>{rows.length} of {total.toLocaleString()} shown</div>
          <div className="flex gap-2">
            {page > 1 ? <Link href={linkFor(page - 1)} className="underline">← Prev</Link> : <span className="text-slate-400">← Prev</span>}
            <span className="text-slate-500">{page} / {pageCount}</span>
            {page < pageCount ? <Link href={linkFor(page + 1)} className="underline">Next →</Link> : <span className="text-slate-400">Next →</span>}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Row({ r }: { r: AuditRow }) {
  return (
    <tr className="border-t border-slate-200 dark:border-slate-800 align-top">
      <td className="px-2 py-1.5 text-xs font-mono whitespace-nowrap">
        {r.ts.slice(0, 19).replace("T", " ")}
      </td>
      <td className="px-2 py-1.5 text-xs font-mono">
        {r.actor ?? <span className="text-slate-400">—</span>}
      </td>
      <td className="px-2 py-1.5 text-xs font-mono">{r.action}</td>
      <td className="px-2 py-1.5 text-xs font-mono max-w-[16rem] truncate" title={r.target ?? ""}>
        {r.target ?? <span className="text-slate-400">—</span>}
      </td>
      <td className="px-2 py-1.5 text-xs"><OutcomeBadge v={r.outcome} /></td>
      <td className="px-2 py-1.5 text-xs font-mono">
        {r.ip ?? <span className="text-slate-400">—</span>}
      </td>
      <td className="px-2 py-1.5 text-xs">
        {r.detail
          ? <details>
              <summary className="cursor-pointer text-slate-600 dark:text-slate-400">view</summary>
              <pre className="mt-1 text-[10px] font-mono whitespace-pre-wrap max-w-[28rem] break-all">
                {JSON.stringify(r.detail, null, 2)}
              </pre>
            </details>
          : <span className="text-slate-400">—</span>}
      </td>
    </tr>
  );
}

function OutcomeBadge({ v }: { v: string }) {
  const cls = v === "success" ? "bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300"
            : v === "failure" ? "bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300"
            : v === "denied"  ? "bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300"
            : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400";
  return <span className={`inline-flex items-center rounded-md px-1.5 py-0.5 ${cls}`}>{v}</span>;
}

function FilterField({
  label, name, type = "text", defaultValue, placeholder,
}: {
  label: string; name: string; type?: string;
  defaultValue?: string; placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="block text-xs font-medium mb-1">{label}</span>
      <input name={name} type={type} defaultValue={defaultValue} placeholder={placeholder}
             className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1.5 text-sm" />
    </label>
  );
}

/** Convert ISO datetime in search params to the `datetime-local`
 *  input value format. Returns "" on missing/bad input. */
function isoToLocal(s: string | undefined | null): string {
  if (!s) return "";
  // Accept "YYYY-MM-DDTHH:MM" or full ISO; trim to the local-input shape.
  const m = s.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/);
  return m ? m[1]! : "";
}
