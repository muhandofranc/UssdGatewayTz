/**
 * The shortcode edit form, rendered by TWO routes:
 *   /shortcodes/[id]            — the standalone page
 *   @modal/(.)shortcodes/[id]   — the same thing as a dialog over the list
 *
 * It lives here rather than in either route so the two can never drift.
 * `variant` changes only the chrome: the page needs its own heading and
 * a way back to the list, the dialog already has both in its shell.
 *
 * The permission check is inside this component, not in the pages, so
 * neither entry point can be added later without it.
 */
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSession, hasPerm } from "@/lib/auth";
import { Perms } from "@/lib/rbac";
import { getShortcode, listOperators, listPossibleOwners } from "@/lib/shortcodes";
import ShortcodeFormFields from "../_form";
import { actionUpdateShortcode } from "../actions";

export interface EditProps {
  id: number;
  error?: string;
  variant: "page" | "modal";
}

/** Heading text, also used as the dialog's accessible label. */
export async function shortcodeEditTitle(id: number): Promise<string> {
  const row = await getShortcode(id);
  return row ? `Edit shortcode ${row.operator_name}/${row.code}` : "Edit shortcode";
}

export default async function ShortcodeEdit({ id, error, variant }: EditProps) {
  // Auditor (SHORTCODES_VIEW only) can reach this route via the
  // middleware gate, but the edit form is meaningless to them — the
  // submit would 403 in actions. Send them back to the list.
  const session = await getSession();
  if (!session || !hasPerm(session, Perms.SHORTCODES_MANAGE)) {
    redirect("/shortcodes");
  }
  if (!Number.isFinite(id)) notFound();

  const [row, operators, owners] = await Promise.all([
    getShortcode(id),
    listOperators(),
    listPossibleOwners(),
  ]);
  if (!row) notFound();

  // Bind the id into the server action via closure.
  const submit = actionUpdateShortcode.bind(null, id);
  const isModal = variant === "modal";

  return (
    <div className={isModal ? "space-y-4" : "max-w-3xl mx-auto space-y-4"}>
      {!isModal ? (
        <div className="flex items-center gap-3">
          <Link href="/shortcodes" className="text-sm underline">← Back</Link>
          <h1 className="text-2xl font-semibold">
            Edit shortcode <span className="font-mono">{row.operator_name}/{row.code}</span>
          </h1>
        </div>
      ) : null}

      {error ? (
        <div className="rounded-md bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      ) : null}

      <form
        action={submit}
        className={isModal
          ? "space-y-6"
          : "space-y-6 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6"}
      >
        <ShortcodeFormFields operators={operators} owners={owners} defaults={row} />
        <div className="flex items-center gap-2 pt-2">
          <button type="submit"
                  className="rounded-md bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 px-3 py-1.5 text-sm font-medium">
            Save changes
          </button>
          {/* In the dialog, dismissing is the shell's job (Esc, backdrop,
              the × button) — a Cancel link here would push a history
              entry and leave the modal reachable via Back. */}
          {!isModal ? (
            <Link href="/shortcodes" className="text-sm underline">Cancel</Link>
          ) : null}
        </div>
      </form>
    </div>
  );
}
