"use server";

/**
 * Owner-facing server action: self-service creation of a SANDBOX shortcode.
 *
 * Unlike the SA `/shortcodes` create action this is available to any user
 * holding `shortcodes.manage_sandbox` (the `client` role, migration 024).
 * It hard-forces:
 *   - environment = 'sandbox'  (never routable — gateway filters it out)
 *   - owner_user_id = the caller (a client can only create for themselves)
 *   - status = 'active'        (so it's immediately simulatable)
 * so a client can never provision a production shortcode or one owned by
 * someone else through this path. Promotion to production stays a
 * super_admin-approved action (see shortcodes/actions.ts:actionPromoteShortcode).
 */
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { getSession, hasPerm } from "@/lib/auth";
import { Perms } from "@/lib/rbac";
import { codeExists, createShortcode } from "@/lib/shortcodes";
import { audit, clientIp } from "@/lib/audit";

const back = (msg: string, kind: "error" | "ok" = "error") =>
  redirect(`/my-shortcodes?${kind}=${encodeURIComponent(msg)}`);

export async function actionCreateSandboxShortcode(fd: FormData) {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!hasPerm(session, Perms.SHORTCODES_MANAGE_SANDBOX)) {
    return back("you are not allowed to create sandbox shortcodes");
  }

  const str = (k: string) => (fd.get(k)?.toString() ?? "").trim();
  const operator_id  = parseInt(str("operator_id"), 10);
  const code         = str("code");
  const label        = str("label") || null;
  const handler_url  = str("handler_url");
  const auth_mode    = str("auth_mode") === "bearer" ? "bearer" : "none";
  const bearer_token = str("bearer_token") || null;
  const timeout_secs = parseInt(str("timeout_secs"), 10);

  if (!Number.isFinite(operator_id) || operator_id <= 0) return back("operator is required");
  if (!code)                                             return back("code is required");
  if (code.length > 32)                                  return back("code too long (max 32)");
  if (!handler_url || !/^https?:\/\//i.test(handler_url)) return back("handler URL must start with http:// or https://");
  if (handler_url.length > 2048)                         return back("handler URL too long (max 2048 chars)");
  if (auth_mode === "bearer" && !bearer_token)           return back("bearer token required when auth_mode=bearer");
  if (!Number.isFinite(timeout_secs) || timeout_secs < 1 || timeout_secs > 30) {
    return back("timeout must be 1–30 seconds");
  }

  // Uniqueness is per-environment: a client may reuse a code that already
  // exists in production, but not one they already have in sandbox.
  if (await codeExists(operator_id, code, "sandbox")) {
    return back("you already have a sandbox shortcode with this operator + code");
  }

  const id = await createShortcode(
    {
      operator_id, code, label,
      environment: "sandbox",
      owner_user_id: Number(session.sub),
      handler_url,
      auth_mode,
      bearer_token: auth_mode === "bearer" ? bearer_token : null,
      timeout_secs,
      status: "active",
      status_message: null,
    },
    Number(session.sub),
  );

  const h = await headers();
  await audit({
    actor: session.email, action: "shortcode.sandbox.create",
    target: `${operator_id}:${code}`, outcome: "success",
    ip: clientIp(h), userAgent: h.get("user-agent"),
    detail: { id, handler_url, environment: "sandbox" },
  });

  revalidatePath("/my-shortcodes");
  back(`Sandbox shortcode ${code} created. Test it in the simulator.`, "ok");
}
