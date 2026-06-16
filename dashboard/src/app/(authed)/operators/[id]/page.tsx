import Link from "next/link";
import { notFound } from "next/navigation";
import { getOperator } from "@/lib/operators";
import { actionUpdateOperator } from "../actions";

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}

export default async function EditOperatorPage({ params, searchParams }: Props) {
  const { id: idStr } = await params;
  const id = parseInt(idStr, 10);
  if (!Number.isFinite(id)) notFound();

  const [op, sp] = await Promise.all([getOperator(id), searchParams]);
  if (!op) notFound();

  const submit = actionUpdateOperator.bind(null, id);

  return (
    <div className="max-w-2xl mx-auto space-y-4">
      <div className="flex items-center gap-3">
        <Link href="/operators" className="text-sm underline">← Back</Link>
        <h1 className="text-2xl font-semibold">
          Edit operator <span className="font-mono">{op.name}</span>
        </h1>
      </div>

      {sp.error ? (
        <div className="rounded-md bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          {sp.error}
        </div>
      ) : null}

      <form action={submit}
            className="space-y-4 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Name (routing key)</span>
          <input type="text" value={op.name} disabled
                 className="rounded-md border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 px-2 py-1.5 font-mono cursor-not-allowed" />
          <span className="text-xs text-slate-500">
            Read-only — the gateway code routes by <code>/ussd/{op.name}</code>.
            Renaming would silently desync the adapters.
          </span>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Display name</span>
          <input type="text" name="display_name" required maxLength={64}
                 defaultValue={op.display_name}
                 className="rounded-md border border-slate-300 dark:border-slate-700 bg-transparent px-2 py-1.5" />
          <span className="text-xs text-slate-500">Friendly name shown in reports.</span>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Billable window (seconds)</span>
          <input
            type="number" name="billable_window_secs"
            min={1} max={600} placeholder="leave blank for per-leg billing"
            defaultValue={op.billable_window_secs ?? ""}
            className="rounded-md border border-slate-300 dark:border-slate-700 bg-transparent px-2 py-1.5 font-mono w-40"
          />
          <span className="text-xs text-slate-500">
            Per-MNO USSD-billing increment. Vodacom <span className="font-mono">20</span>,
            Airtel / Tigo <span className="font-mono">30</span>.
            Leave blank for MNOs that bill per-leg / flat (Halotel).
            Billable units per session = <span className="font-mono">GREATEST(1, CEIL(duration / window))</span>.
          </span>
        </label>

        <label className="inline-flex items-center gap-2 text-sm">
          <input type="checkbox" name="active" value="1" defaultChecked={op.active} />
          <span>Active <span className="text-xs text-slate-500">(gateway accepts new traffic for this MNO)</span></span>
        </label>

        <div className="flex items-center gap-2 pt-2">
          <button type="submit"
                  className="rounded-md bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 px-3 py-1.5 text-sm font-medium">
            Save changes
          </button>
          <Link href="/operators" className="text-sm underline">Cancel</Link>
        </div>
      </form>
    </div>
  );
}
