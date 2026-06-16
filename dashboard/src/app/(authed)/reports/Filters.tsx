/**
 * Reports filter form — server-rendered HTML form with method=GET.
 * No client state; submitting causes a full navigation back to
 * /reports with the new search params, and the page re-renders
 * server-side with the new query.
 *
 * Multi-select for operators uses simple checkboxes (4 MNOs only,
 * always fits). Multi-select for shortcodes is a <select multiple>
 * — fine up to ~50 options, after which a Combobox would be nicer
 * (deferred).
 *
 * The form INCLUDES the per-shortcode allowlist already narrowed
 * by the server (loadShortcodeOptions returns only what this user
 * is allowed to see), so a `client` user picks from their own
 * codes only.
 */
import type { ReportFilters } from "@/lib/reports";
import type { ShortcodeOption } from "@/lib/reports";
import { actionCreateExport } from "../exports/actions";

const OPERATORS = ["vodacom", "airtel", "tigo", "halotel"] as const;
const PAGE_SIZES = [10, 25, 50, 100];

interface Props {
  defaults: ReportFilters;
  pageSize: number;
  shortcodeOptions: ShortcodeOption[];
  /** Form action — same-origin path the filter form submits to.
   *  /reports for the per-leg view, /sessions for the per-session
   *  summary. Default keeps backward compat. */
  action?: string;
}

function Field({
  label, children,
}: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="font-medium text-slate-600 dark:text-slate-400">{label}</span>
      {children}
    </label>
  );
}

export default function Filters({ defaults, pageSize, shortcodeOptions, action = "/reports" }: Props) {
  const selectedOps = new Set(defaults.operators ?? []);
  const selectedShortcodes = new Set((defaults.shortcodeIds ?? []).map(String));

  return (
    <form
      method="get"
      action={action}
      className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-3"
    >
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
        <Field label="From">
          <input
            type="date" name="from" defaultValue={defaults.fromTs ?? ""}
            className="rounded-md border border-slate-300 dark:border-slate-700 bg-transparent px-2 py-1"
          />
        </Field>
        <Field label="To">
          <input
            type="date" name="to" defaultValue={defaults.toTs ?? ""}
            className="rounded-md border border-slate-300 dark:border-slate-700 bg-transparent px-2 py-1"
          />
        </Field>
        <Field label="MSISDN">
          <input
            type="text" name="msisdn" defaultValue={defaults.msisdn ?? ""} placeholder="255…"
            className="rounded-md border border-slate-300 dark:border-slate-700 bg-transparent px-2 py-1 font-mono"
          />
        </Field>
        <Field label="Session ID">
          <input
            type="text" name="session_id" defaultValue={defaults.sessionId ?? ""}
            className="rounded-md border border-slate-300 dark:border-slate-700 bg-transparent px-2 py-1 font-mono"
          />
        </Field>
        <Field label="Status">
          <select
            name="error_class" defaultValue={defaults.errorClass ?? "any"}
            className="rounded-md border border-slate-300 dark:border-slate-700 bg-transparent px-2 py-1"
          >
            <option value="any">Any</option>
            <option value="ok">Successful only</option>
            <option value="error">Errors only</option>
            <option value="shortcode_not_found">— shortcode_not_found</option>
            <option value="auth_failed">— auth_failed</option>
            <option value="handler_timeout">— handler_timeout</option>
            <option value="non2xx">— non2xx</option>
            <option value="transport">— transport</option>
          </select>
        </Field>
        <Field label="Page size">
          <select
            name="page_size" defaultValue={String(pageSize)}
            className="rounded-md border border-slate-300 dark:border-slate-700 bg-transparent px-2 py-1"
          >
            {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </Field>
      </div>

      <div className="flex flex-wrap items-start gap-6">
        <fieldset className="text-xs space-y-1">
          <legend className="font-medium text-slate-600 dark:text-slate-400">MNO</legend>
          <div className="flex flex-wrap gap-3">
            {OPERATORS.map((op) => (
              <label key={op} className="inline-flex items-center gap-1.5 font-mono">
                <input type="checkbox" name="operator" value={op}
                       defaultChecked={selectedOps.has(op)} />
                {op}
              </label>
            ))}
          </div>
        </fieldset>

        {shortcodeOptions.length > 0 ? (
          <fieldset className="text-xs space-y-1 min-w-[20rem]">
            <legend className="font-medium text-slate-600 dark:text-slate-400">
              Shortcode {shortcodeOptions.length > 1 ? `(${shortcodeOptions.length} available)` : ""}
            </legend>
            <select
              name="shortcode_id" multiple size={Math.min(6, shortcodeOptions.length)}
              defaultValue={Array.from(selectedShortcodes)}
              className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-transparent px-2 py-1 font-mono"
            >
              {shortcodeOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.operator_name} · {o.code} {o.label ? `(${o.label})` : ""}
                </option>
              ))}
            </select>
            <div className="text-[10px] text-slate-500">Ctrl/⌘-click for multi-select.</div>
          </fieldset>
        ) : null}
      </div>

      <div className="flex items-center gap-2">
        <button
          type="submit"
          className="rounded-md bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 px-3 py-1.5 text-sm font-medium"
        >
          Apply filters
        </button>
        <a
          href={action}
          className="rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-sm"
        >
          Reset
        </a>
        <span className="ml-auto text-xs text-slate-500">
          Heavy exports queue and become available on{" "}
          <a href="/exports" className="underline">/exports</a> when ready.
        </span>
        <button
          type="submit"
          formAction={actionCreateExport}
          formMethod="post"
          name="granularity"
          value={action === "/sessions" ? "sessions" : "legs"}
          className="rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
          title="Enqueue a CSV export of the current filter set"
        >
          ⇣ Export CSV
        </button>
      </div>
    </form>
  );
}
