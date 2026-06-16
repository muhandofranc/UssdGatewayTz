/**
 * Shared shortcode form fields used by /shortcodes/new and
 * /shortcodes/[id]. Server component — no client state. The
 * auth_mode toggle uses CSS to hide bearer_token when auth_mode=none,
 * but the field stays in the DOM so a stale `auth_mode=bearer`
 * submission with a stale token still passes the server-side check.
 */
import type { OperatorOption, OwnerOption, ShortcodeRow } from "@/lib/shortcodes";

interface Props {
  operators: OperatorOption[];
  owners: OwnerOption[];
  defaults?: Partial<ShortcodeRow>;
}

export default function ShortcodeFormFields({ operators, owners, defaults }: Props) {
  const d = defaults ?? {};
  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Operator</span>
          <select
            name="operator_id" required defaultValue={d.operator_id ?? ""}
            className="rounded-md border border-slate-300 dark:border-slate-700 bg-transparent px-2 py-1.5"
          >
            <option value="" disabled>Choose…</option>
            {operators.map((o) => (
              <option key={o.id} value={o.id}>{o.display_name}</option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Code</span>
          <input
            type="text" name="code" required maxLength={32}
            defaultValue={d.code ?? ""} placeholder="*123#  or  glpair"
            className="rounded-md border border-slate-300 dark:border-slate-700 bg-transparent px-2 py-1.5 font-mono"
          />
          <span className="text-xs text-slate-500">
            Dialed USSD (e.g. <code>*123#</code>) for Vodacom/Halotel, or
            URL partner slug (e.g. <code>glpair</code>, <code>glptigo</code>)
            for Airtel/Tigo.
          </span>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Label</span>
          <input
            type="text" name="label" maxLength={120}
            defaultValue={d.label ?? ""}
            placeholder="Friendly name shown in reports"
            className="rounded-md border border-slate-300 dark:border-slate-700 bg-transparent px-2 py-1.5"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Owner</span>
          <select
            name="owner_user_id" required defaultValue={d.owner_user_id ?? ""}
            className="rounded-md border border-slate-300 dark:border-slate-700 bg-transparent px-2 py-1.5"
          >
            <option value="" disabled>Choose…</option>
            {owners.map((u) => (
              <option key={u.id} value={u.id}>{u.email} · {u.name}</option>
            ))}
          </select>
          <span className="text-xs text-slate-500">
            Only this user (and super_admins) will see this shortcode's reports.
          </span>
        </label>

        <label className="flex flex-col gap-1 text-sm md:col-span-2">
          <span className="font-medium">Handler URL</span>
          <input
            type="url" name="handler_url" required
            defaultValue={d.handler_url ?? ""}
            placeholder="https://example.com/ussd"
            className="rounded-md border border-slate-300 dark:border-slate-700 bg-transparent px-2 py-1.5 font-mono"
          />
          <span className="text-xs text-slate-500">
            The gateway POSTs the unified JSON request here on every leg.
          </span>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Auth mode</span>
          <select
            name="auth_mode" defaultValue={d.auth_mode ?? "none"}
            className="rounded-md border border-slate-300 dark:border-slate-700 bg-transparent px-2 py-1.5"
          >
            <option value="none">none (open — internal / VPN)</option>
            <option value="bearer">bearer (Authorization: Bearer …)</option>
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Bearer token</span>
          <input
            type="text" name="bearer_token"
            defaultValue={d.bearer_token ?? ""}
            placeholder="Required when auth_mode=bearer"
            className="rounded-md border border-slate-300 dark:border-slate-700 bg-transparent px-2 py-1.5 font-mono"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Handler timeout (seconds)</span>
          <input
            type="number" name="timeout_secs" min={1} max={30} required
            defaultValue={d.timeout_secs ?? 5}
            className="rounded-md border border-slate-300 dark:border-slate-700 bg-transparent px-2 py-1.5"
          />
          <span className="text-xs text-slate-500">
            Keep well below the MNO's USSD-session budget (~10s).
          </span>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Status</span>
          <select
            name="status"
            defaultValue={d.status ?? (d.active === false ? "deactivated" : "active")}
            className="rounded-md border border-slate-300 dark:border-slate-700 bg-transparent px-2 py-1.5"
          >
            <option value="active">active — accept new traffic</option>
            <option value="maintenance">maintenance — show message, skip handler</option>
            <option value="deactivated">deactivated — show message, skip handler</option>
          </select>
          <span className="text-xs text-slate-500">
            Owners can also toggle active/maintenance from <code>/my-shortcodes</code>.
            Only super admins can deactivate.
          </span>
        </label>

        <label className="flex flex-col gap-1 text-sm md:col-span-2">
          <span className="font-medium">Status message (USSD display)</span>
          <textarea
            name="status_message" maxLength={160} rows={2}
            defaultValue={d.status_message ?? ""}
            placeholder="e.g. Service under maintenance until 14:00 EAT. Please try later."
            className="rounded-md border border-slate-300 dark:border-slate-700 bg-transparent px-2 py-1.5"
          />
          <span className="text-xs text-slate-500">
            Shown to the caller as an END response when status ≠ active. Max
            160 characters — MNOs truncate longer messages.
          </span>
        </label>
      </div>
    </>
  );
}
