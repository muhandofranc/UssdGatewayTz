import Link from "next/link";
import { listRoles } from "@/lib/users";
import { actionCreateUser } from "../actions";

interface Props { searchParams: Promise<{ error?: string }>; }

export default async function NewUserPage({ searchParams }: Props) {
  const [roles, sp] = await Promise.all([listRoles(), searchParams]);

  return (
    <div className="max-w-2xl mx-auto space-y-4">
      <div className="flex items-center gap-3">
        <Link href="/users" className="text-sm underline">← Back</Link>
        <h1 className="text-2xl font-semibold">New portal user</h1>
      </div>

      {sp.error ? (
        <div className="rounded-md bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          {sp.error}
        </div>
      ) : null}

      <form action={actionCreateUser}
            className="space-y-4 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6">
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
          <Link href="/users" className="text-sm underline">Cancel</Link>
        </div>
      </form>
    </div>
  );
}
