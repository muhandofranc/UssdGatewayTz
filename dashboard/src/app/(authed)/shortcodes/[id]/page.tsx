import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSession, hasPerm } from "@/lib/auth";
import { Perms } from "@/lib/rbac";
import { getShortcode, listOperators, listPossibleOwners } from "@/lib/shortcodes";
import ShortcodeFormFields from "../_form";
import { actionUpdateShortcode } from "../actions";

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}

export default async function EditShortcodePage({ params, searchParams }: Props) {
  // Auditor (SHORTCODES_VIEW only) can reach this route via the
  // middleware gate, but the edit form is meaningless to them — the
  // submit would 403 in actions. Send them back to the list.
  const session = await getSession();
  if (!session || !hasPerm(session, Perms.SHORTCODES_MANAGE)) {
    redirect("/shortcodes");
  }
  const { id: idStr } = await params;
  const id = parseInt(idStr, 10);
  if (!Number.isFinite(id)) notFound();

  const [row, operators, owners, sp] = await Promise.all([
    getShortcode(id),
    listOperators(),
    listPossibleOwners(),
    searchParams,
  ]);
  if (!row) notFound();

  // Bind the id into the server action via closure.
  const submit = actionUpdateShortcode.bind(null, id);

  return (
    <div className="max-w-3xl mx-auto space-y-4">
      <div className="flex items-center gap-3">
        <Link href="/shortcodes" className="text-sm underline">← Back</Link>
        <h1 className="text-2xl font-semibold">
          Edit shortcode <span className="font-mono">{row.operator_name}/{row.code}</span>
        </h1>
      </div>

      {sp.error ? (
        <div className="rounded-md bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          {sp.error}
        </div>
      ) : null}

      <form action={submit} className="space-y-6 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6">
        <ShortcodeFormFields operators={operators} owners={owners} defaults={row} />
        <div className="flex items-center gap-2 pt-2">
          <button type="submit"
                  className="rounded-md bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 px-3 py-1.5 text-sm font-medium">
            Save changes
          </button>
          <Link href="/shortcodes" className="text-sm underline">Cancel</Link>
        </div>
      </form>
    </div>
  );
}
