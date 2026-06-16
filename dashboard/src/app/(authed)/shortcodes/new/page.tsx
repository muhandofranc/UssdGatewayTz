import Link from "next/link";
import { listOperators, listPossibleOwners } from "@/lib/shortcodes";
import ShortcodeFormFields from "../_form";
import { actionCreateShortcode } from "../actions";

interface Props { searchParams: Promise<{ error?: string }>; }

export default async function NewShortcodePage({ searchParams }: Props) {
  const [operators, owners, sp] = await Promise.all([
    listOperators(), listPossibleOwners(), searchParams,
  ]);

  return (
    <div className="max-w-3xl mx-auto space-y-4">
      <div className="flex items-center gap-3">
        <Link href="/shortcodes" className="text-sm underline">← Back</Link>
        <h1 className="text-2xl font-semibold">New shortcode</h1>
      </div>

      {sp.error ? (
        <div className="rounded-md bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          {sp.error}
        </div>
      ) : null}

      <form action={actionCreateShortcode} className="space-y-6 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6">
        <ShortcodeFormFields operators={operators} owners={owners} />
        <div className="flex items-center gap-2 pt-2">
          <button type="submit"
                  className="rounded-md bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 px-3 py-1.5 text-sm font-medium">
            Create shortcode
          </button>
          <Link href="/shortcodes" className="text-sm underline">Cancel</Link>
        </div>
      </form>
    </div>
  );
}
