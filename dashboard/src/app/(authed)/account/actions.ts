"use server";

/**
 * Self-service account actions. Same shape as users/actions.ts:
 * session check → validate → mutate → audit → redirect with
 * ?error / ?changed.
 *
 * Impersonation needs no check here: middleware refuses every non-GET
 * on an impersonated session, so an admin viewing as someone can never
 * change that person's password.
 */
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getSession, loadUserClaims, setSessionCookie, signSession } from "@/lib/auth";
import { changeOwnPassword, newPasswordError } from "@/lib/users";
import { audit, clientIp, recentAuditCount } from "@/lib/audit";

const ACTION = "auth.change_password";
// Wrong current passwords tolerated per user per window before the
// form refuses. A stolen session cookie must not become an unlimited
// password-guessing oracle (the current password often unlocks other
// systems too).
const MAX_FAILURES = 5;
const WINDOW_MINUTES = 15;

function back(error: string): never {
  redirect(`/account?error=${encodeURIComponent(error)}`);
}

export async function actionChangeOwnPassword(fd: FormData) {
  const session = await getSession();
  if (!session) redirect("/login");
  const h = await headers();
  const meta = { ip: clientIp(h), ua: h.get("user-agent") };

  // Not trimmed: login compares the raw string, so a password that
  // starts or ends with a space must be stored exactly as typed.
  const current = fd.get("current_password")?.toString() ?? "";
  const pw      = fd.get("password")?.toString() ?? "";
  const confirm = fd.get("password_confirm")?.toString() ?? "";

  if (!current) back("enter your current password");
  const invalid = newPasswordError(pw, confirm);
  if (invalid) back(invalid);
  if (pw === current) back("new password must differ from the current one");

  const failures = await recentAuditCount(session.email, ACTION, "failure", WINDOW_MINUTES);
  if (failures >= MAX_FAILURES) {
    await audit({
      actor: session.email, action: ACTION, target: session.sub,
      outcome: "denied", ip: meta.ip, userAgent: meta.ua,
      detail: { reason: "too_many_failures" },
    });
    back(`too many wrong attempts — try again in ${WINDOW_MINUTES} minutes`);
  }

  const ok = await changeOwnPassword(Number(session.sub), current, pw);
  await audit({
    actor: session.email, action: ACTION, target: session.sub,
    outcome: ok ? "success" : "failure", ip: meta.ip, userAgent: meta.ua,
    detail: ok ? null : { reason: "bad_current_password" },
  });
  if (!ok) back("current password is incorrect");
  // The change bumped password_version, which revokes every session —
  // this one included. Re-mint it so the user stays signed in on the
  // device they changed it from; everywhere else is signed out.
  const claims = await loadUserClaims(Number(session.sub));
  if (!claims) redirect("/login");
  await setSessionCookie(await signSession(claims));
  redirect("/account?changed=1");
}
