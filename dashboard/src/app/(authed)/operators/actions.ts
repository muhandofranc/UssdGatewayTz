"use server";

/**
 * Operators server actions. Reuses the `shortcodes.manage` perm
 * (operators + shortcodes are both "gateway routing config" surface
 * area; one perm covers both rather than introducing a new key).
 */
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { getSession, hasPerm } from "@/lib/auth";
import { Perms } from "@/lib/rbac";
import { updateOperator, type OperatorWrite } from "@/lib/operators";
import { audit, clientIp } from "@/lib/audit";

async function requireAdmin() {
  const session = await getSession();
  if (!session || !hasPerm(session, Perms.SHORTCODES_MANAGE)) redirect("/");
  return session;
}

async function reqMeta() {
  const h = await headers();
  return { ip: clientIp(h), ua: h.get("user-agent") };
}

function s(fd: FormData, k: string): string {
  return (fd.get(k)?.toString() ?? "").trim();
}
function bool(fd: FormData, k: string): boolean {
  const v = s(fd, k);
  return v === "1" || v === "true" || v === "on";
}

function parseWrite(fd: FormData): { write?: OperatorWrite; error?: string } {
  const display_name = s(fd, "display_name");
  const windowStr = s(fd, "billable_window_secs");
  const active = bool(fd, "active");

  if (!display_name) return { error: "display_name required" };
  if (display_name.length > 64) return { error: "display_name too long (max 64)" };

  let billable_window_secs: number | null;
  if (!windowStr || windowStr === "null" || windowStr === "0") {
    // Empty / "null" / "0" all mean "per-leg / no window" (Halotel-style).
    billable_window_secs = null;
  } else {
    const n = parseInt(windowStr, 10);
    if (!Number.isFinite(n) || n < 1 || n > 600) {
      return { error: "billable_window_secs must be empty (per-leg) or 1–600" };
    }
    billable_window_secs = n;
  }

  return { write: { display_name, billable_window_secs, active } };
}

export async function actionUpdateOperator(id: number, fd: FormData) {
  const session = await requireAdmin();
  const { write, error } = parseWrite(fd);
  if (error || !write) {
    return redirect(`/operators/${id}?error=${encodeURIComponent(error || "invalid input")}`);
  }
  await updateOperator(id, write);
  const meta = await reqMeta();
  await audit({
    actor: session.email, action: "operator.update",
    target: String(id), outcome: "success",
    ip: meta.ip, userAgent: meta.ua,
    detail: {
      id,
      display_name: write.display_name,
      billable_window_secs: write.billable_window_secs,
      active: write.active,
    },
  });
  revalidatePath("/operators");
  revalidatePath(`/operators/${id}`);
  redirect("/operators");
}
