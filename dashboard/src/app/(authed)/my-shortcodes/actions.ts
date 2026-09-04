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
import {
  codeExists, countUnpromotedSandbox, createShortcode,
  SANDBOX_PER_OPERATOR_LIMIT,
  buildShortcodeLabel, labelPartsFor, defaultSandboxOperatorId,
} from "@/lib/shortcodes";
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
  // No operator prompt on the sandbox form: a sandbox shortcode never
  // reaches a network, so asking a client to pick one is a question with
  // no consequence. The placeholder keeps the NOT NULL column satisfied;
  // the real network is chosen by a super_admin at promotion.
  const operator_id  = await defaultSandboxOperatorId();
  const code         = str("code");
  const handler_url  = str("handler_url");
  const auth_mode    = str("auth_mode") === "bearer" ? "bearer" : "none";
  const bearer_token = str("bearer_token") || null;
  const timeout_secs = parseInt(str("timeout_secs"), 10);

  if (!code)                                             return back("code is required");
  if (code.length > 32)                                  return back("code too long (max 32)");
  if (!handler_url || !/^https?:\/\//i.test(handler_url)) return back("handler URL must start with http:// or https://");
  if (handler_url.length > 2048)                         return back("handler URL too long (max 2048 chars)");
  if (auth_mode === "bearer" && !bearer_token)           return back("bearer token required when auth_mode=bearer");
  if (!Number.isFinite(timeout_secs) || timeout_secs < 1 || timeout_secs > 30) {
    return back("timeout must be 1–30 seconds");
  }

  // Anti-abuse cap: at most N un-promoted sandbox shortcodes. Now that
  // every sandbox row sits on the same placeholder operator, this is
  // effectively a per-user cap — so the message no longer says "per
  // operator", which would read as a limit the client cannot see.
  const inFlight = await countUnpromotedSandbox(Number(session.sub), operator_id);
  if (inFlight >= SANDBOX_PER_OPERATOR_LIMIT) {
    return back(
      `You already have ${SANDBOX_PER_OPERATOR_LIMIT} sandbox shortcodes ` +
      `awaiting promotion. Promote one to production before creating another.`,
    );
  }

  // Uniqueness is per-environment: a client may reuse a code that already
  // exists in production, but not one they already have in sandbox.
  if (await codeExists(operator_id, code, "sandbox")) {
    return back("you already have a sandbox shortcode with this code");
  }

  // Label is derived, never typed — that is the whole point of dropping
  // the field from the form: every label reads "Owner · Code · Network".
  const { ownerName } = await labelPartsFor(Number(session.sub), operator_id);
  const label = buildShortcodeLabel({ ownerName, code, environment: "sandbox" });

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
      // Client-created shortcodes ALWAYS get the unified gateway body.
      // The legacy shape exists only to carry pre-gateway integrations
      // across, and switching to it is a super_admin decision on the
      // /shortcodes form (db/030) -- this form must never offer it, or a
      // client could point a brand-new handler at a deprecated contract.
      payload_format: "gateway",
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
