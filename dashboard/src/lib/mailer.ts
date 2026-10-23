/**
 * Outbound email (password-reset links). Server-only.
 *
 * Off unless SMTP_HOST, SMTP_FROM and DASHBOARD_PUBLIC_URL are all set;
 * the forgot-password endpoint then answers "not configured" instead of
 * pretending to send.
 *
 * DASHBOARD_PUBLIC_URL is where links point. It is configuration, never
 * derived from the request: a link built from the Host header lets
 * anyone who can forge that header have the reset email point at their
 * own server and collect the token when the user clicks it.
 *
 * Env:
 *   SMTP_HOST, SMTP_PORT (465), SMTP_SECURE (default: port 465 → TLS
 *   from the handshake; otherwise STARTTLS when offered),
 *   SMTP_USER / SMTP_PASSWORD (omit both for an unauthenticated relay),
 *   SMTP_FROM, DASHBOARD_PUBLIC_URL (e.g. https://ussdportal.onfonmedia.co.tz)
 */
import nodemailer, { type Transporter } from "nodemailer";

const PORT = Number(process.env.SMTP_PORT || 465);

export function mailEnabled(): boolean {
  return !!(process.env.SMTP_HOST && process.env.SMTP_FROM && publicBaseUrl());
}

/** DASHBOARD_PUBLIC_URL without a trailing slash, or null if unset/invalid. */
export function publicBaseUrl(): string | null {
  const raw = (process.env.DASHBOARD_PUBLIC_URL || "").trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.origin + u.pathname.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

let transport: Transporter | null = null;

function getTransport(): Transporter {
  if (transport) return transport;
  const secureEnv = process.env.SMTP_SECURE;
  const user = process.env.SMTP_USER;
  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: PORT,
    secure: secureEnv ? secureEnv === "1" || secureEnv === "true" : PORT === 465,
    auth: user ? { user, pass: process.env.SMTP_PASSWORD || "" } : undefined,
    // Bounded so a dead mail server can't pile up open sockets.
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  return transport;
}

export async function sendMail(to: string, subject: string, text: string): Promise<void> {
  await getTransport().sendMail({ from: process.env.SMTP_FROM, to, subject, text });
}
