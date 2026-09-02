/**
 * The portal-user create form, rendered by TWO routes:
 *   /users/new            — the standalone page
 *   @modal/(.)users/new   — the same thing as a dialog over the list
 *
 * Mirrors ./[id]/_edit.tsx — see ../shortcodes/_new.tsx for why the
 * @modal interceptor is mandatory rather than a nicety.
 */
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession, hasPerm } from "@/lib/auth";
import { Perms } from "@/lib/rbac";
import { listRoles } from "@/lib/users";
import { actionCreateUser } from "./actions";

export interface NewProps {
  error?: string;
  variant: "page" | "modal";
}

/** Heading text, also used as the dialog's accessible label. */
export const userNewTitle = "New portal user";

export default async function UserNew({ error, variant }: NewProps) {
  // This is the super_admin-only flexible create form (any role, any
  // shortcode owner). Auditor (view-only) AND client/Admin (creates
  // viewers inline on /users) both get bounced back to the listing.
  const session = await getSession();
  if (!session || !hasPerm(session, Perms.PORTAL_USERS_MANAGE)) {
    redirect("/users");
  }
  const roles = await listRoles();
  const isModal = variant === "modal";

  return (
    <div className={isModal ? "space-y-4" : "max-w-2xl mx-auto space-y-4"}>
      {!isModal ? (
        <div className="flex items-center gap-3">
          <Link href="/users" className="text-sm underline">← Back</Link>
          <h1 className="text-2xl font-semibold">{userNewTitle}</h1>
        </div>
      ) : null}

      {error ? (
        <div className="rounded-md bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      ) : null}

      <form
        action={actionCreateUser}
        className={isModal
          ? "space-y-4"
          : "space-y-4 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6"}
      >
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Email</span>
          <input type="email" name="email" required autoComplete="off"
                 className="rounded-md border border-slate-300 dark:border-slate-700 bg-transparent px-2 py-1.5 font-mono" />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Name</span>
          <input type="text" name="name" required maxLength={150}
                 className="rounded-md border border-slate-300 dark:border-slate-700 bg-transparent px-2 py-1.5" />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Phone (optional)</span>
          <input type="tel" name="phone" maxLength={32}
                 className="rounded-md border border-slate-300 dark:border-slate-700 bg-transparent px-2 py-1.5 font-mono" />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Role</span>
          <select name="role_id" required defaultValue=""
                  className="rounded-md border border-slate-300 dark:border-slate-700 bg-transparent px-2 py-1.5">
            <option value="" disabled>Choose…</option>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>{r.label} ({r.key})</option>
            ))}
          </select>
        </label>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Password</span>
            <input type="password" name="password" required minLength={8} autoComplete="new-password"
                   className="rounded-md border border-slate-300 dark:border-slate-700 bg-transparent px-2 py-1.5 font-mono" />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Confirm password</span>
            <input type="password" name="password_confirm" required minLength={8} autoComplete="new-password"
                   className="rounded-md border border-slate-300 dark:border-slate-700 bg-transparent px-2 py-1.5 font-mono" />
          </label>
        </div>

        <div className="flex items-center gap-2 pt-2">
          <button type="submit"
                  className="rounded-md bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 px-3 py-1.5 text-sm font-medium">
            Create user
          </button>
          {/* In the dialog, dismissing is the shell's job — see
              ../shortcodes/_new.tsx. */}
          {!isModal ? (
            <Link href="/users" className="text-sm underline">Cancel</Link>
          ) : null}
        </div>
      </form>
    </div>
  );
}
