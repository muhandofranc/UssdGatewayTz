/**
 * /my-shortcodes — owner-facing slim view. Lists every shortcode the
 * signed-in user owns. For each row they can flip status between
 * `active` and `maintenance` and author the on-air display message
 * (≤160 chars). Only super_admins can `deactivate` — that option is
 * absent here and rejected server-side as a defence-in-depth.
 *
 * No SHORTCODES_MANAGE permission required — ownership is checked at
 * the query layer (listShortcodesOwnedBy filters by owner_user_id).
 */
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { listShortcodesOwnedBy, type ShortcodeRow } from "@/lib/shortcodes";
import { actionSetShortcodeStatus } from "../shortcodes/actions";

export default async function MyShortcodesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");
  const sp = await searchParams;

  const rows = await listShortcodesOwnedBy(Number(session.sub));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">My shortcodes</h1>
        <span className="text-xs text-slate-500">
          {rows.length} owned · signed in as <code>{session.email}</code>
        </span>
      </div>

      {sp?.error ? (
        <div className="rounded-md border border-rose-200 dark:border-rose-900/50 bg-rose-50 dark:bg-rose-950/40 text-rose-800 dark:text-rose-200 px-3 py-2 text-sm">
          {decodeURIComponent(sp.error)}
        </div>
      ) : null}
      {sp?.ok ? (
        <div className="rounded-md border border-emerald-200 dark:border-emerald-900/50 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-200 px-3 py-2 text-sm">
          {decodeURIComponent(sp.ok)}
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-8 text-center text-sm text-slate-500">
          You don&rsquo;t own any shortcodes yet. Ask a Super Admin to set you as
          the owner of one via the <Link href="/" className="underline">main dashboard</Link>.
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => <OwnerCard key={r.id} row={r} />)}
        </div>
      )}

      <p className="text-xs text-slate-500">
        Setting <strong>maintenance</strong> means the gateway will reply
        with your message instead of calling your handler — useful while
        you patch a backend. Switch back to <strong>active</strong> to
        resume normal forwarding. Only a Super Admin can <em>deactivate</em>
        a shortcode entirely.
      </p>
    </div>
  );
}

function OwnerCard({ row: r }: { row: ShortcodeRow }) {
  // Pre-fill the textarea with whatever message is currently saved so the
  // owner can edit it in place. The form posts back to the same action;
  // we encode the row id into the action so React's server-action wrapping
  // doesn't need a hidden input.
  const goActive = async (fd: FormData) => {
    "use server";
    await actionSetShortcodeStatus(r.id, "active", null);
    redirect(
      "/my-shortcodes?ok=" +
      encodeURIComponent(`${r.operator_name} ${r.code} is now active.`),
    );
  };
  const goMaintenance = async (fd: FormData) => {
    "use server";
    const msg = (fd.get("status_message")?.toString() ?? "").trim();
    await actionSetShortcodeStatus(r.id, "maintenance", msg);
    redirect(
      "/my-shortcodes?ok=" +
      encodeURIComponent(`${r.operator_name} ${r.code} is in maintenance.`),
    );
  };

  return (
    <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="font-mono text-sm">
            <span className="text-slate-500">{r.operator_name}</span> · {r.code}
          </div>
          {r.label ? (
            <div className="text-xs text-slate-500">{r.label}</div>
          ) : null}
        </div>
        <StatusBadge row={r} />
      </div>

      {r.status === "deactivated" ? (
        <div className="mt-3 text-xs text-rose-700 dark:text-rose-300">
          This shortcode has been deactivated by a Super Admin. You can&rsquo;t
          reactivate it from here — please contact your admin.
          {r.status_message ? (
            <div className="mt-1 italic">Reason shown to callers: &ldquo;{r.status_message}&rdquo;</div>
          ) : null}
        </div>
      ) : (
        <form
          action={r.status === "active" ? goMaintenance : goActive}
          className="mt-3 space-y-2"
        >
          {r.status === "active" ? (
            <>
              <label className="block text-xs text-slate-500">
                Maintenance message shown to callers (max 160 chars)
              </label>
              <textarea
                name="status_message" maxLength={160} rows={2}
                required
                defaultValue={r.status_message ?? ""}
                placeholder="e.g. Service under maintenance until 14:00 EAT. Please try later."
                className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-transparent px-2 py-1.5 text-sm"
              />
              <button
                type="submit"
                className="rounded-md bg-amber-600 hover:bg-amber-700 text-white px-3 py-1.5 text-sm font-medium"
              >
                Put into maintenance
              </button>
            </>
          ) : (
            <>
              <div className="text-xs text-slate-500">
                Currently shown to callers:&nbsp;
                <span className="italic">&ldquo;{r.status_message ?? "(default message)"}&rdquo;</span>
              </div>
              <button
                type="submit"
                className="rounded-md bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 text-sm font-medium"
              >
                Resume normal operation
              </button>
            </>
          )}
        </form>
      )}

      {r.status_set_at ? (
        <div className="mt-3 text-[10px] text-slate-500">
          last changed {new Date(r.status_set_at).toLocaleString()}
          {r.status_set_by_email ? ` · by ${r.status_set_by_email}` : ""}
        </div>
      ) : null}
    </div>
  );
}

function StatusBadge({ row: r }: { row: ShortcodeRow }) {
  if (r.status === "active") {
    return (
      <span className="inline-flex items-center rounded-md bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 px-2 py-0.5 text-xs">
        active
      </span>
    );
  }
  if (r.status === "maintenance") {
    return (
      <span className="inline-flex items-center rounded-md bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 px-2 py-0.5 text-xs">
        maintenance
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-md bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 px-2 py-0.5 text-xs">
      deactivated (admin)
    </span>
  );
}
