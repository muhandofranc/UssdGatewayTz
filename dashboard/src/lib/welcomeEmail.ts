/**
 * "Your account is ready" email for users an admin creates — login URL,
 * email and the initial password. Server-only.
 *
 * Carrying the password is a deliberate choice (2026-10-24): it stays
 * readable in the mailbox, so the email asks the user to change it at
 * once on /account. Never log or audit the password itself.
 */
import { mailEnabled, publicBaseUrl, sendMail } from "./mailer";

/** Outcome shown to the admin after the create redirect. */
export type WelcomeEmailResult = "sent" | "failed" | "off" | "skipped";

export interface WelcomeEmail {
  to: string;
  name: string;
  password: string;
  createdBy: string;   // the admin's email, so the user knows who set it up
}

function body(w: WelcomeEmail): string {
  return [
    `Hello ${w.name},`,
    "",
    "An account has been created for you on the UssdGatewayTz portal.",
    "",
    `Sign in at: ${publicBaseUrl()}/login`,
    `Email:      ${w.to}`,
    `Password:   ${w.password}`,
    "",
    "Please change this password as soon as you sign in: click your name",
    "at the top right, then \"Change password\". If you forget it, use",
    "\"Forgot password?\" on the sign-in page.",
    "",
    `Your account was set up by ${w.createdBy}.`,
  ].join("\n");
}

/**
 * Send the email if asked to and mail is configured. Never throws: the
 * account already exists, so a mail failure is reported, not fatal.
 */
export async function sendWelcomeEmail(
  w: WelcomeEmail, wanted: boolean,
): Promise<{ result: WelcomeEmailResult; error?: string }> {
  if (!wanted) return { result: "skipped" };
  if (!mailEnabled()) return { result: "off" };
  try {
    await sendMail(w.to, "Your UssdGatewayTz portal account", body(w));
    return { result: "sent" };
  } catch (e) {
    console.error("welcome email send failed:", e);
    return { result: "failed", error: String((e as Error)?.message ?? e).slice(0, 300) };
  }
}

/** The sentence appended to the green "created" notice on /users. */
export function welcomeEmailNotice(result: string | undefined): string {
  switch (result) {
    case "sent": return " Login details were emailed to the user.";
    case "off":  return " Email isn't configured, so share the login details yourself.";
    default:     return "";   // "failed" shows as an error instead
  }
}

export const WELCOME_EMAIL_FAILED =
  "The account was created, but the login details email could not be sent — share them another way.";
