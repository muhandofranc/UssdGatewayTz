/**
 * The shortcode create form, rendered by TWO routes:
 *   /shortcodes/new            — the standalone page
 *   @modal/(.)shortcodes/new   — the same thing as a dialog over the list
 *
 * Mirrors ./[id]/_edit.tsx: the form lives here rather than in either
 * route so the two can never drift, `variant` changes only the chrome,
 * and the permission check sits in the component so neither entry point
 * can be added later without it.
 *
 * The @modal interceptor is not optional. `(.)shortcodes/[id]` is a
 * dynamic segment, so with no sibling `new` route in the slot it
 * matches the literal path /shortcodes/new with id="new" — which
 * parsed to NaN and reached Postgres as `invalid input syntax for type
 * integer`. A static segment outranks the dynamic one and takes the
 * navigation back.
 */
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession, hasPerm } from "@/lib/auth";
import { Perms } from "@/lib/rbac";
import { listOperators, listPossibleOwners } from "@/lib/shortcodes";
import ShortcodeFormFields from "./_form";
import { actionCreateShortcode } from "./actions";

export interface NewProps {
  error?: string;
  variant: "page" | "modal";
}

/** Heading text, also used as the dialog's accessible label. */
export const shortcodeNewTitle = "New shortcode";

export default async function ShortcodeNew({ error, variant }: NewProps) {
  // Auditor (SHORTCODES_VIEW only) can reach this route via the
  // middleware gate, but the create form is meaningless to them —
  // the submit would 403 in actions. Send them back to the list.
  const session = await getSession();
  if (!session || !hasPerm(session, Perms.SHORTCODES_MANAGE)) {
    redirect("/shortcodes");
  }
  const [operators, owners] = await Promise.all([
    listOperators(), listPossibleOwners(),
  ]);
  const isModal = variant === "modal";

  return (
    <div className={isModal ? "space-y-4" : "max-w-3xl mx-auto space-y-4"}>
      {!isModal ? (
        <div className="flex items-center gap-3">
          <Link href="/shortcodes" className="text-sm underline">← Back</Link>
          <h1 className="text-2xl font-semibold">{shortcodeNewTitle}</h1>
        </div>
      ) : null}

      {error ? (
        <div className="rounded-md bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      ) : null}

      <form
        action={actionCreateShortcode}
        className={isModal
          ? "space-y-6"
          : "space-y-6 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6"}
      >
        <ShortcodeFormFields operators={operators} owners={owners} />
        <div className="flex items-center gap-2 pt-2">
          <button type="submit"
                  className="rounded-md bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 px-3 py-1.5 text-sm font-medium">
            Create shortcode
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
