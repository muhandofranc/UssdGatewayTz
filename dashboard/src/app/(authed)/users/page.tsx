/**
 * /users — branched by caller role:
 *
 *   super_admin (PORTAL_USERS_MANAGE) → full portal users list with
 *     Create + Edit + role/active management. The pre-existing UI.
 *
 *   auditor (PORTAL_USERS_VIEW)       → same list, read-only. The
 *     "+ New user" button + per-row Edit link are hidden; if the
 *     auditor manually navigates to /users/new or /users/[id] the
 *     server actions reject (they gate on PORTAL_USERS_MANAGE).
 *
 *   client/Admin (VIEWERS_MANAGE_OWN) → scoped to viewers granted on
 *     their OWN shortcodes. Inline create form + per-viewer grant
 *     matrix + activate/deactivate. Cannot promote out of lane —
 *     role is fixed to `client_viewer`.
 */
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession, hasPerm } from "@/lib/auth";
import { Perms } from "@/lib/rbac";
import {
  ADMIN_MAX_VIEWERS, listRoles, listUsers, listViewersForAdmin,
  type UserListFilters,
} from "@/lib/users";
import { listShortcodesOwnedBy } from "@/lib/shortcodes";
import {
  actionAdminCreateViewer, actionAdminSetGrants, actionAdminUpdateViewer,
} from "./actions";

type SearchParams = {
  error?: string; saved?: string; created?: string; reset?: string;
  /** Filter querystring (FullList branch only): role_id, active, q. */
  role_id?: string;
  active?: string;        // "1" / "0" / "" (any)
  q?: string;
};

export default async function UsersPage({
  searchParams,
}: { searchParams: Promise<SearchParams> }) {
  const session = await getSession();
  if (!session) redirect("/login");

  const sp = await searchParams;
  const flash = sp.created ? "Viewer created."
              : sp.saved   ? "Saved."
              : sp.reset   ? "Password reset."
              : null;

  const canManageAll = hasPerm(session, Perms.PORTAL_USERS_MANAGE);
  const canViewAll   = hasPerm(session, Perms.PORTAL_USERS_VIEW);
  const canManageOwn = hasPerm(session, Perms.VIEWERS_MANAGE_OWN);

  // super_admin OR auditor → full platform list (auditor sees no edit
  // affordances). Both use the existing listUsers query.
  if (canManageAll || canViewAll) {
    const roleIdRaw = sp.role_id ? parseInt(sp.role_id, 10) : undefined;
    const filters: UserListFilters = {
      roleId: Number.isFinite(roleIdRaw) ? roleIdRaw : undefined,
      active: sp.active === "1" ? true : sp.active === "0" ? false : undefined,
      search: sp.q?.trim() || undefined,
    };
    return (
      <FullList
        readOnly={!canManageAll}
        flash={flash}
        error={sp.error ?? null}
        filters={filters}
      />
    );
  }

  // client/Admin → scoped viewer list + create form + per-row grants
  if (canManageOwn) {
    return (
      <AdminViewerView
        adminUserId={Number(session.sub)}
        flash={flash}
        error={sp.error ?? null}
      />
    );
  }

  // No applicable perm → middleware would normally bounce, but be
  // defensive.
  redirect("/");
}

// --------------------------------------------------------------------
// Full list (super_admin write, auditor read)
// --------------------------------------------------------------------

async function FullList({
  readOnly, flash, error, filters,
}: {
  readOnly: boolean; flash: string | null; error: string | null;
  filters: UserListFilters;
}) {
  const [rows, roles] = await Promise.all([listUsers(filters), listRoles()]);
  const anyFilterActive = !!(filters.roleId || filters.active !== undefined || filters.search);
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Portal users</h1>
        {!readOnly ? (
          <Link href="/users/new"
                className="rounded-md bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 px-3 py-1.5 text-sm font-medium">
            + New user
          </Link>
        ) : (
          <span className="text-xs text-slate-500 italic">read-only</span>
        )}
      </div>

      {/* ---- Filter form (GET → searchParams) ---- */}
      <form method="GET"
            className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4
                       grid gap-3 md:grid-cols-5 items-end">
        <label className="block md:col-span-2">
          <span className="block text-xs font-medium mb-1">Search (email / name / phone)</span>
          <input name="q" type="text" defaultValue={filters.search ?? ""}
                 placeholder="substring"
                 className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1.5 text-sm" />
        </label>

        <label className="block">
          <span className="block text-xs font-medium mb-1">Role</span>
          <select name="role_id" defaultValue={filters.roleId ? String(filters.roleId) : ""}
                  className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1.5 text-sm">
            <option value="">any</option>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>{r.label} ({r.key})</option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="block text-xs font-medium mb-1">Active</span>
          <select name="active"
                  defaultValue={filters.active === true ? "1" : filters.active === false ? "0" : ""}
                  className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1.5 text-sm">
            <option value="">any</option>
            <option value="1">active</option>
            <option value="0">inactive</option>
          </select>
        </label>

        <div className="flex gap-2 md:col-span-5 justify-end">
          <Link href="/users"
                className="rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-sm">
            Reset
          </Link>
          <button type="submit"
                  className="rounded-md bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 px-3 py-1.5 text-sm font-medium">
            Apply
          </button>
        </div>
      </form>

      <div className="text-xs text-slate-500">
        {rows.length} match{rows.length === 1 ? "" : "es"}
        {anyFilterActive ? null : " (no filter applied)"}
      </div>

      <Flash kind="ok"  msg={flash} />
      <Flash kind="err" msg={error} />

      <div className="overflow-x-auto rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <table className="min-w-full text-left">
          <thead className="bg-brand-header">
            <tr>
              <th className="px-2 py-2 text-xs font-medium">Email</th>
              <th className="px-2 py-2 text-xs font-medium">Name</th>
              <th className="px-2 py-2 text-xs font-medium">Role</th>
              <th className="px-2 py-2 text-xs font-medium text-right">Shortcodes</th>
              <th className="px-2 py-2 text-xs font-medium">Phone</th>
              <th className="px-2 py-2 text-xs font-medium">Active</th>
              <th className="px-2 py-2 text-xs font-medium">Last login</th>
              {!readOnly ? <th className="px-2 py-2 text-xs font-medium text-right">Actions</th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => (
              <tr key={u.id} className="border-t border-slate-200 dark:border-slate-800">
                <td className="px-2 py-1.5 text-xs font-mono">{u.email}</td>
                <td className="px-2 py-1.5 text-xs">{u.name}</td>
                <td className="px-2 py-1.5 text-xs font-mono">{u.role_key}</td>
                <td className="px-2 py-1.5 text-xs text-right tabular-nums">{u.owned_shortcode_count}</td>
                <td className="px-2 py-1.5 text-xs font-mono">{u.phone ?? "—"}</td>
                <td className="px-2 py-1.5 text-xs">
                  {u.active
                    ? <span className="inline-flex items-center rounded-md bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 px-1.5 py-0.5">active</span>
                    : <span className="inline-flex items-center rounded-md bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 px-1.5 py-0.5">inactive</span>}
                </td>
                <td className="px-2 py-1.5 text-xs font-mono">
                  {u.last_login ? new Date(u.last_login).toISOString().slice(0,19).replace("T"," ") : "—"}
                </td>
                {!readOnly ? (
                  <td className="px-2 py-1.5 text-xs text-right">
                    <Link href={`/users/${u.id}`} className="underline">Edit</Link>
                  </td>
                ) : null}
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr><td className="px-2 py-6 text-center text-sm text-slate-500" colSpan={readOnly ? 7 : 8}>
                {anyFilterActive ? "No users match the current filters." : "No users."}
              </td></tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-slate-500">
        {readOnly
          ? "Read-only view. Auditors can see every portal user and their role; only super admins can create or edit."
          : "Deactivating a user prevents future sign-ins without removing their history. You cannot deactivate yourself, or the last active super admin."}
      </p>
    </div>
  );
}

// --------------------------------------------------------------------
// Admin (client) view — manage read-only viewers within own scope
// --------------------------------------------------------------------

async function AdminViewerView({
  adminUserId, flash, error,
}: { adminUserId: number; flash: string | null; error: string | null }) {
  const [viewers, myShortcodes] = await Promise.all([
    listViewersForAdmin(adminUserId),
    listShortcodesOwnedBy(adminUserId),
  ]);
  const atLimit = viewers.length >= ADMIN_MAX_VIEWERS;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">My viewer{ADMIN_MAX_VIEWERS === 1 ? "" : "s"}</h1>
        <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
          Create {ADMIN_MAX_VIEWERS === 1 ? "a" : "up to " + ADMIN_MAX_VIEWERS}
          {" "}read-only login{ADMIN_MAX_VIEWERS === 1 ? "" : "s"} scoped to your shortcodes.
          Viewer{ADMIN_MAX_VIEWERS === 1 ? "" : "s"} see reports + session logs for the shortcodes
          you grant them — nothing else.
        </p>
      </div>

      <Flash kind="ok"  msg={flash} />
      <Flash kind="err" msg={error} />

      {/* ---------- Create form ---------- */}
      <section className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5">
        <h2 className="text-lg font-semibold mb-4">+ Add a viewer</h2>
        {myShortcodes.length === 0 ? (
          <p className="text-sm text-amber-700 dark:text-amber-400">
            You don't own any shortcodes yet, so there's nothing to
            grant a viewer access to. Contact a super admin to assign
            you a shortcode first.
          </p>
        ) : atLimit ? (
          <p className="text-sm text-slate-600 dark:text-slate-400">
            You're at the limit of {ADMIN_MAX_VIEWERS} viewer
            {ADMIN_MAX_VIEWERS === 1 ? "" : "s"}. To change which
            shortcodes your viewer can see, use the grants matrix on
            the card below — no need to create another account.
          </p>
        ) : (
          <form action={actionAdminCreateViewer} className="grid gap-3 md:grid-cols-2">
            <Field label="Email" name="email" type="email" required />
            <Field label="Name" name="name" required />
            <Field label="Phone (optional)" name="phone" />
            <Field label="Password (≥8 chars)" name="password" type="password" required />
            <Field label="Confirm password" name="password_confirm" type="password" required />
            <div className="md:col-span-2">
              <label className="block text-xs font-medium mb-1">
                Grant access to (Ctrl/Cmd-click to select multiple)
              </label>
              <select name="shortcode_ids" multiple required
                      className="w-full h-32 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1 text-sm font-mono">
                {myShortcodes.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.operator_name} {s.code} {s.label ? `(${s.label})` : ""}
                  </option>
                ))}
              </select>
            </div>
            <div className="md:col-span-2 flex justify-end">
              <button type="submit"
                      className="rounded-md bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 px-4 py-1.5 text-sm font-medium">
                Create viewer
              </button>
            </div>
          </form>
        )}
      </section>

      {/* ---------- Existing viewers ---------- */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">
          Viewer{ADMIN_MAX_VIEWERS === 1 ? "" : "s"} ({viewers.length}/{ADMIN_MAX_VIEWERS})
        </h2>
        {viewers.length === 0 ? (
          <p className="text-sm text-slate-500">No viewers yet.</p>
        ) : (
          <div className="space-y-3">
            {viewers.map((v) => (
              <ViewerCard key={v.id} viewer={v} myShortcodes={myShortcodes} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function ViewerCard({
  viewer, myShortcodes,
}: {
  viewer: { id: number; email: string; name: string; phone: string | null;
            active: boolean; last_login: string | null; granted_shortcode_ids: number[] };
  myShortcodes: { id: number; operator_name: string; code: string; label: string | null }[];
}) {
  const grantedSet = new Set(viewer.granted_shortcode_ids);
  return (
    <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4">
      <div className="flex items-start justify-between flex-wrap gap-2">
        <div>
          <div className="font-medium">{viewer.name}</div>
          <div className="text-xs font-mono text-slate-600 dark:text-slate-400">{viewer.email}</div>
          <div className="text-xs text-slate-500 mt-1">
            {viewer.active
              ? <span className="inline-flex items-center rounded-md bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 px-1.5 py-0.5">active</span>
              : <span className="inline-flex items-center rounded-md bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 px-1.5 py-0.5">inactive</span>}
            <span className="ml-3">
              Last login: <span className="font-mono">{viewer.last_login ? new Date(viewer.last_login).toISOString().slice(0,19).replace("T"," ") : "—"}</span>
            </span>
          </div>
        </div>
      </div>

      {/* Profile + active state */}
      <form action={actionAdminUpdateViewer.bind(null, viewer.id)}
            className="grid gap-3 md:grid-cols-2 border-t border-slate-200 dark:border-slate-800 pt-4">
        <Field label="Email" name="email" type="email" defaultValue={viewer.email} required />
        <Field label="Name"  name="name"  defaultValue={viewer.name} required />
        <Field label="Phone" name="phone" defaultValue={viewer.phone ?? ""} />
        <label className="flex items-center gap-2 text-sm pt-5">
          <input type="checkbox" name="active" value="1" defaultChecked={viewer.active} />
          <span>Active</span>
        </label>
        <div className="md:col-span-2 flex justify-end">
          <button type="submit"
                  className="rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-sm">
            Save profile
          </button>
        </div>
      </form>

      {/* Grants matrix */}
      <form action={actionAdminSetGrants.bind(null, viewer.id)}
            className="border-t border-slate-200 dark:border-slate-800 pt-4 space-y-3">
        <div className="text-xs font-medium">Granted shortcodes (your scope)</div>
        <div className="grid gap-1 text-sm">
          {myShortcodes.map((s) => (
            <label key={s.id} className="flex items-center gap-2 font-mono text-xs">
              <input type="checkbox" name="shortcode_ids" value={s.id}
                     defaultChecked={grantedSet.has(s.id)} />
              <span>{s.operator_name} {s.code} {s.label ? `· ${s.label}` : ""}</span>
            </label>
          ))}
        </div>
        <div className="flex justify-end">
          <button type="submit"
                  className="rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-sm">
            Save grants
          </button>
        </div>
        <p className="text-[11px] text-slate-500">
          Unchecking a shortcode revokes only YOUR grant. If another
          admin has also granted this viewer the same shortcode, that
          grant stays.
        </p>
      </form>
    </div>
  );
}

// --------------------------------------------------------------------
// Tiny helpers
// --------------------------------------------------------------------

function Field({
  label, name, type = "text", required = false, defaultValue,
}: {
  label: string; name: string; type?: string; required?: boolean; defaultValue?: string;
}) {
  return (
    <label className="block">
      <span className="block text-xs font-medium mb-1">{label}</span>
      <input
        name={name} type={type} required={required} defaultValue={defaultValue}
        className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1 text-sm"
      />
    </label>
  );
}

function Flash({ kind, msg }: { kind: "ok" | "err"; msg: string | null }) {
  if (!msg) return null;
  const cls = kind === "ok"
    ? "bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300 border-emerald-200 dark:border-emerald-900"
    : "bg-rose-50 dark:bg-rose-950/40 text-rose-800 dark:text-rose-300 border-rose-200 dark:border-rose-900";
  return (
    <div className={`rounded-md border px-3 py-2 text-sm ${cls}`}>
      {msg}
    </div>
  );
}
