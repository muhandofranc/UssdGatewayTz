"use server";

/**
 * Portal users server actions. Mirrors shortcodes/actions.ts:
 * perm check → validate → mutate → audit → revalidate + redirect.
 *
 * No-lockout invariants live in lib/users.ts (updateUser) and run
 * INSIDE a transaction so a concurrent demote can't race past them.
 * Caller catches NoLockoutError and surfaces the message.
 */
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { getSession, hasPerm } from "@/lib/auth";
import { Perms } from "@/lib/rbac";
import {
  createUser, emailExists, resetPassword, updateUser, NoLockoutError,
  createViewerAsAdmin, setViewerGrantsAsAdmin, updateViewerAsAdmin,
  getViewerForAdmin, ScopeError,
  type UserCreate, type UserUpdate, type AdminViewerCreate,
} from "@/lib/users";
import { audit, clientIp } from "@/lib/audit";

async function requireAdmin() {
  const session = await getSession();
  if (!session || !hasPerm(session, Perms.PORTAL_USERS_MANAGE)) {
    redirect("/");
  }
  return session;
}

/**
 * Caller for the Admin → viewer flow. Either a super_admin (has
 * PORTAL_USERS_MANAGE — can manage anything) or a client/Admin (has
 * VIEWERS_MANAGE_OWN — scoped to their own shortcodes). Both reach
 * the same actions below; data-layer scope helpers enforce the
 * per-Admin restriction.
 */
async function requireViewerManager() {
  const session = await getSession();
  if (!session) redirect("/");
  if (
    !hasPerm(session, Perms.PORTAL_USERS_MANAGE)
    && !hasPerm(session, Perms.VIEWERS_MANAGE_OWN)
  ) {
    redirect("/");
  }
  return session;
}

async function reqMeta() {
  const h = await headers();
  return { ip: clientIp(h), ua: h.get("user-agent") };
}

function s(fd: FormData, k: string): string {
  return (fd.get(k)?.toString() ?? "").trim();
}
function i(fd: FormData, k: string): number {
  const n = parseInt(s(fd, k), 10);
  return Number.isFinite(n) ? n : NaN;
}
function b(fd: FormData, k: string): boolean {
  const v = s(fd, k);
  return v === "1" || v === "true" || v === "on";
}

function parseCreate(fd: FormData): { c?: UserCreate; error?: string } {
  const email   = s(fd, "email").toLowerCase();
  const name    = s(fd, "name");
  const phone   = s(fd, "phone") || null;
  const role_id = i(fd, "role_id");
  const password = s(fd, "password");
  const confirm  = s(fd, "password_confirm");

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: "valid email required" };
  if (!name) return { error: "name required" };
  if (!Number.isFinite(role_id)) return { error: "role required" };
  if (password.length < 8) return { error: "password must be ≥8 chars" };
  if (password !== confirm) return { error: "passwords do not match" };

  return { c: { email, name, phone, role_id, password } };
}

function parseUpdate(fd: FormData): { u?: UserUpdate; error?: string } {
  const email   = s(fd, "email").toLowerCase();
  const name    = s(fd, "name");
  const phone   = s(fd, "phone") || null;
  const role_id = i(fd, "role_id");
  const active  = b(fd, "active");

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: "valid email required" };
  if (!name) return { error: "name required" };
  if (!Number.isFinite(role_id)) return { error: "role required" };

  return { u: { email, name, phone, role_id, active } };
}

export async function actionCreateUser(fd: FormData) {
  const session = await requireAdmin();
  const { c, error } = parseCreate(fd);
  if (error || !c) {
    return redirect(`/users/new?error=${encodeURIComponent(error || "invalid input")}`);
  }
  if (await emailExists(c.email)) {
    return redirect(`/users/new?error=${encodeURIComponent("email already in use")}`);
  }
  const id = await createUser(c);
  const meta = await reqMeta();
  await audit({
    actor: session.email, action: "user.create", target: c.email,
    outcome: "success", ip: meta.ip, userAgent: meta.ua,
    detail: { id, role_id: c.role_id },
  });
  revalidatePath("/users");
  redirect("/users");
}

export async function actionUpdateUser(id: number, fd: FormData) {
  const session = await requireAdmin();
  const { u, error } = parseUpdate(fd);
  if (error || !u) {
    return redirect(`/users/${id}?error=${encodeURIComponent(error || "invalid input")}`);
  }
  if (await emailExists(u.email, id)) {
    return redirect(`/users/${id}?error=${encodeURIComponent("email already in use")}`);
  }
  try {
    await updateUser(id, u, Number(session.sub));
  } catch (e) {
    if (e instanceof NoLockoutError) {
      const meta = await reqMeta();
      await audit({
        actor: session.email, action: "user.update", target: u.email,
        outcome: "denied", ip: meta.ip, userAgent: meta.ua,
        detail: { id, reason: e.reason },
      });
      return redirect(`/users/${id}?error=${encodeURIComponent(e.reason)}`);
    }
    throw e;
  }
  const meta = await reqMeta();
  await audit({
    actor: session.email, action: "user.update", target: u.email,
    outcome: "success", ip: meta.ip, userAgent: meta.ua,
    detail: { id, role_id: u.role_id, active: u.active },
  });
  revalidatePath("/users");
  revalidatePath(`/users/${id}`);
  redirect("/users");
}

export async function actionResetPassword(id: number, fd: FormData) {
  const session = await requireAdmin();
  const pw      = s(fd, "password");
  const confirm = s(fd, "password_confirm");
  if (pw.length < 8) {
    return redirect(`/users/${id}?error=${encodeURIComponent("password must be ≥8 chars")}`);
  }
  if (pw !== confirm) {
    return redirect(`/users/${id}?error=${encodeURIComponent("passwords do not match")}`);
  }
  await resetPassword(id, pw);
  const meta = await reqMeta();
  await audit({
    actor: session.email, action: "user.reset_password",
    target: String(id), outcome: "success",
    ip: meta.ip, userAgent: meta.ua,
  });
  revalidatePath(`/users/${id}`);
  redirect(`/users/${id}?reset=1`);
}

// =====================================================================
// Admin → viewer actions (db/010 viewers.manage_own + client_viewer)
// =====================================================================
//
// The Admin (`client` role) flow keeps the /users page as the single
// CRUD surface: the page renders a viewer-focused list + create form
// for them. These actions are invoked by that form.
//
// Each action:
//   * gates via requireViewerManager (PORTAL_USERS_MANAGE OR
//     VIEWERS_MANAGE_OWN)
//   * delegates to a lib/users.ts helper that enforces the
//     scope-by-shortcode-ownership rule inside the same transaction
//   * audits the outcome
//   * redirects back to /users (single-page CRUD)
//
// Errors surface via redirect-with-?error=... (the page reads ?error).

/** Parse list of shortcode ids from a multi-select form field. */
function ids(fd: FormData, k: string): number[] {
  return fd.getAll(k).map((v) => parseInt(String(v), 10)).filter(Number.isFinite);
}

function parseViewerCreate(fd: FormData): { c?: AdminViewerCreate; error?: string } {
  const email          = s(fd, "email").toLowerCase();
  const name           = s(fd, "name");
  const phone          = s(fd, "phone") || null;
  const password       = s(fd, "password");
  const confirm        = s(fd, "password_confirm");
  const shortcode_ids  = ids(fd, "shortcode_ids");

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: "valid email required" };
  if (!name) return { error: "name required" };
  if (password.length < 8) return { error: "password must be ≥8 chars" };
  if (password !== confirm) return { error: "passwords do not match" };
  if (shortcode_ids.length === 0) return { error: "at least one shortcode grant is required" };

  return { c: { email, name, phone, password, shortcode_ids } };
}

export async function actionAdminCreateViewer(fd: FormData) {
  const session = await requireViewerManager();
  const { c, error } = parseViewerCreate(fd);
  if (error || !c) {
    return redirect(`/users?error=${encodeURIComponent(error || "invalid input")}`);
  }
  if (await emailExists(c.email)) {
    return redirect(`/users?error=${encodeURIComponent("email already in use")}`);
  }
  const meta = await reqMeta();
  try {
    const id = await createViewerAsAdmin(c, Number(session.sub));
    await audit({
      actor: session.email, action: "viewer.create", target: c.email,
      outcome: "success", ip: meta.ip, userAgent: meta.ua,
      detail: { id, shortcode_ids: c.shortcode_ids },
    });
    revalidatePath("/users");
    redirect("/users?created=1");
  } catch (e) {
    if (e instanceof ScopeError) {
      await audit({
        actor: session.email, action: "viewer.create", target: c.email,
        outcome: "denied", ip: meta.ip, userAgent: meta.ua,
        detail: { reason: e.reason, shortcode_ids: c.shortcode_ids },
      });
      return redirect(`/users?error=${encodeURIComponent(e.reason)}`);
    }
    throw e;
  }
}

export async function actionAdminSetGrants(viewerId: number, fd: FormData) {
  const session = await requireViewerManager();
  const shortcode_ids = ids(fd, "shortcode_ids");
  const meta = await reqMeta();
  try {
    await setViewerGrantsAsAdmin(viewerId, shortcode_ids, Number(session.sub));
    await audit({
      actor: session.email, action: "viewer.grants.update",
      target: String(viewerId), outcome: "success",
      ip: meta.ip, userAgent: meta.ua,
      detail: { shortcode_ids },
    });
    revalidatePath("/users");
    redirect("/users?saved=1");
  } catch (e) {
    if (e instanceof ScopeError) {
      await audit({
        actor: session.email, action: "viewer.grants.update",
        target: String(viewerId), outcome: "denied",
        ip: meta.ip, userAgent: meta.ua,
        detail: { reason: e.reason, shortcode_ids },
      });
      return redirect(`/users?error=${encodeURIComponent(e.reason)}`);
    }
    throw e;
  }
}

export async function actionAdminUpdateViewer(viewerId: number, fd: FormData) {
  const session = await requireViewerManager();
  const email  = s(fd, "email").toLowerCase();
  const name   = s(fd, "name");
  const phone  = s(fd, "phone") || null;
  const active = b(fd, "active");

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return redirect(`/users?error=${encodeURIComponent("valid email required")}`);
  }
  if (!name) return redirect(`/users?error=${encodeURIComponent("name required")}`);
  if (await emailExists(email, viewerId)) {
    return redirect(`/users?error=${encodeURIComponent("email already in use")}`);
  }
  const meta = await reqMeta();
  try {
    await updateViewerAsAdmin(viewerId, { email, name, phone, active }, Number(session.sub));
    await audit({
      actor: session.email, action: "viewer.update", target: email,
      outcome: "success", ip: meta.ip, userAgent: meta.ua,
      detail: { id: viewerId, active },
    });
    revalidatePath("/users");
    redirect("/users?saved=1");
  } catch (e) {
    if (e instanceof ScopeError) {
      await audit({
        actor: session.email, action: "viewer.update", target: email,
        outcome: "denied", ip: meta.ip, userAgent: meta.ua,
        detail: { id: viewerId, reason: e.reason },
      });
      return redirect(`/users?error=${encodeURIComponent(e.reason)}`);
    }
    throw e;
  }
}

export async function actionAdminResetViewerPassword(viewerId: number, fd: FormData) {
  const session = await requireViewerManager();
  const pw      = s(fd, "password");
  const confirm = s(fd, "password_confirm");
  if (pw.length < 8) {
    return redirect(`/users?error=${encodeURIComponent("password must be ≥8 chars")}`);
  }
  if (pw !== confirm) {
    return redirect(`/users?error=${encodeURIComponent("passwords do not match")}`);
  }
  // Confirm the target is still in this Admin's scope before resetting.
  const viewer = await getViewerForAdmin(viewerId, Number(session.sub));
  if (!viewer) {
    return redirect(`/users?error=${encodeURIComponent("viewer not found")}`);
  }
  await resetPassword(viewerId, pw);
  const meta = await reqMeta();
  await audit({
    actor: session.email, action: "viewer.reset_password",
    target: viewer.email, outcome: "success",
    ip: meta.ip, userAgent: meta.ua,
    detail: { id: viewerId },
  });
  revalidatePath("/users");
  redirect("/users?reset=1");
}
