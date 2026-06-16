"use server";

/**
 * Shortcodes server actions — invoked by form submissions on the
 * /shortcodes pages. Each action:
 *   1. checks the session perm (defence-in-depth on top of middleware)
 *   2. validates input (uniqueness, format)
 *   3. mutates the DB
 *   4. writes an audit row
 *   5. revalidates + redirects
 *
 * Errors surface via redirect-with-?error=... so the page renders
 * the message inline next to the form.
 */
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { getSession, hasPerm } from "@/lib/auth";
import { Perms } from "@/lib/rbac";
import {
  codeExists, createShortcode, setShortcodeActive, setShortcodeStatus,
  updateShortcode, type ShortcodeStatus, type ShortcodeWrite,
} from "@/lib/shortcodes";
import { audit, clientIp } from "@/lib/audit";

async function requireAdmin() {
  const session = await getSession();
  if (!session || !hasPerm(session, Perms.SHORTCODES_MANAGE)) {
    redirect("/");
  }
  return session;
}

async function reqMeta() {
  const h = await headers();
  return {
    ip: clientIp(h),
    ua: h.get("user-agent"),
  };
}

/* ---------- read + validate form fields ---------- */

function strField(fd: FormData, k: string): string {
  return (fd.get(k)?.toString() ?? "").trim();
}
function intField(fd: FormData, k: string): number {
  const n = parseInt(strField(fd, k), 10);
  return Number.isFinite(n) ? n : NaN;
}
function boolField(fd: FormData, k: string): boolean {
  const v = strField(fd, k);
  return v === "1" || v === "true" || v === "on";
}

function parseWrite(fd: FormData): { write?: ShortcodeWrite; error?: string } {
  const operator_id   = intField(fd, "operator_id");
  const code          = strField(fd, "code");
  const label         = strField(fd, "label") || null;
  const owner_user_id = intField(fd, "owner_user_id");
  const handler_url   = strField(fd, "handler_url");
  const auth_mode     = strField(fd, "auth_mode") as "none" | "bearer";
  const bearer_token  = strField(fd, "bearer_token") || null;
  const timeout_secs  = intField(fd, "timeout_secs");
  // Status (post-007): replaces the legacy boolean `active`. The form may
  // still send `active=1` as a back-compat fallback — interpret it as
  // status=active vs deactivated when no explicit status is posted.
  const rawStatus = strField(fd, "status").toLowerCase();
  let status: ShortcodeStatus;
  if (rawStatus === "active" || rawStatus === "maintenance" || rawStatus === "deactivated") {
    status = rawStatus;
  } else {
    status = boolField(fd, "active") ? "active" : "deactivated";
  }
  const status_message = strField(fd, "status_message") || null;

  if (!Number.isFinite(operator_id) || operator_id <= 0)  return { error: "operator is required" };
  if (!code)                                              return { error: "code is required" };
  if (code.length > 32)                                   return { error: "code too long (max 32)" };
  if (!Number.isFinite(owner_user_id) || owner_user_id <= 0) return { error: "owner is required" };
  if (!handler_url || !/^https?:\/\//i.test(handler_url)) return { error: "handler URL must start with http:// or https://" };
  if (auth_mode !== "none" && auth_mode !== "bearer")     return { error: "auth_mode must be 'none' or 'bearer'" };
  if (auth_mode === "bearer" && !bearer_token)            return { error: "bearer token required when auth_mode=bearer" };
  if (!Number.isFinite(timeout_secs) || timeout_secs < 1 || timeout_secs > 30) {
    return { error: "timeout_secs must be 1–30" };
  }
  if (status !== "active" && !status_message) {
    return { error: "a status message is required when status is maintenance or deactivated" };
  }
  // USSD payloads are tight; the MNO may truncate at ~160 chars.
  if (status_message && status_message.length > 160) {
    return { error: "status message too long (max 160 chars — MNOs truncate at session size)" };
  }

  return {
    write: {
      operator_id, code, label, owner_user_id, handler_url,
      auth_mode,
      bearer_token: auth_mode === "bearer" ? bearer_token : null,
      timeout_secs,
      status, status_message,
    },
  };
}

/* ---------- actions ---------- */

export async function actionCreateShortcode(fd: FormData) {
  const session = await requireAdmin();
  const { write, error } = parseWrite(fd);
  if (error || !write) {
    return redirect(`/shortcodes/new?error=${encodeURIComponent(error || "invalid input")}`);
  }
  if (await codeExists(write.operator_id, write.code)) {
    return redirect(`/shortcodes/new?error=${encodeURIComponent("operator+code already exists")}`);
  }
  const id = await createShortcode(write, Number(session.sub));
  const meta = await reqMeta();
  await audit({
    actor: session.email, action: "shortcode.create",
    target: `${write.operator_id}:${write.code}`, outcome: "success",
    ip: meta.ip, userAgent: meta.ua, detail: { id, handler_url: write.handler_url },
  });
  revalidatePath("/shortcodes");
  redirect("/shortcodes");
}

export async function actionUpdateShortcode(id: number, fd: FormData) {
  const session = await requireAdmin();
  const { write, error } = parseWrite(fd);
  if (error || !write) {
    return redirect(`/shortcodes/${id}?error=${encodeURIComponent(error || "invalid input")}`);
  }
  if (await codeExists(write.operator_id, write.code, id)) {
    return redirect(`/shortcodes/${id}?error=${encodeURIComponent("operator+code already exists")}`);
  }
  await updateShortcode(id, write, Number(session.sub));
  const meta = await reqMeta();
  await audit({
    actor: session.email, action: "shortcode.update",
    target: `${write.operator_id}:${write.code}`, outcome: "success",
    ip: meta.ip, userAgent: meta.ua, detail: { id, status: write.status },
  });
  revalidatePath("/shortcodes");
  revalidatePath(`/shortcodes/${id}`);
  redirect("/shortcodes");
}

export async function actionSetShortcodeActive(id: number, active: boolean) {
  const session = await requireAdmin();
  await setShortcodeActive(id, active, Number(session.sub));
  const meta = await reqMeta();
  await audit({
    actor: session.email,
    action: active ? "shortcode.activate" : "shortcode.deactivate",
    target: String(id), outcome: "success",
    ip: meta.ip, userAgent: meta.ua,
  });
  revalidatePath("/shortcodes");
}

/**
 * Status flip used by both the SA list-page quick buttons and the
 * owner-facing /my-shortcodes page (via the wrapper below).
 *
 * Authorisation:
 *  - super_admin (Perms.SHORTCODES_MANAGE) → any status, any shortcode
 *  - owner of the shortcode                → 'active' / 'maintenance' only
 *  - anyone else                           → redirected away
 *
 * The owner check requires looking up the row's owner_user_id; we do
 * that with a single SELECT before the UPDATE.
 */
export async function actionSetShortcodeStatus(
  id: number, status: ShortcodeStatus, message: string | null,
) {
  const session = await getSession();
  if (!session) redirect("/");
  const isAdmin = hasPerm(session, Perms.SHORTCODES_MANAGE);

  // Server-side guard. Even if a client crafts a request, this enforces
  // the rules listed above.
  if (!isAdmin) {
    const { getShortcode } = await import("@/lib/shortcodes");
    const sc = await getShortcode(id);
    if (!sc || sc.owner_user_id !== Number(session.sub)) {
      return redirect("/my-shortcodes?error=not_authorized");
    }
    if (status === "deactivated") {
      return redirect("/my-shortcodes?error=only_admins_can_deactivate");
    }
  }
  if (status !== "active" && !message) {
    return redirect(
      (isAdmin ? `/shortcodes/${id}` : "/my-shortcodes") +
      `?error=${encodeURIComponent("a status message is required")}`,
    );
  }
  if (message && message.length > 160) {
    return redirect(
      (isAdmin ? `/shortcodes/${id}` : "/my-shortcodes") +
      `?error=${encodeURIComponent("status message too long (max 160 chars)")}`,
    );
  }

  await setShortcodeStatus(id, status, message, Number(session.sub));
  const meta = await reqMeta();
  await audit({
    actor: session.email, action: `shortcode.status.${status}`,
    target: String(id), outcome: "success",
    ip: meta.ip, userAgent: meta.ua,
    detail: { id, status, message_len: message?.length ?? 0 },
  });
  revalidatePath("/shortcodes");
  revalidatePath(`/shortcodes/${id}`);
  revalidatePath("/my-shortcodes");
}
