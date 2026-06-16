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
  type UserCreate, type UserUpdate,
} from "@/lib/users";
import { audit, clientIp } from "@/lib/audit";

async function requireAdmin() {
  const session = await getSession();
  if (!session || !hasPerm(session, Perms.PORTAL_USERS_MANAGE)) {
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
