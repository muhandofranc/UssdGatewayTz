/**
 * Append-only audit log writer. Mirrors the gateway's portal_audit_log
 * schema; failures are swallowed (log + count) — auditing must NEVER
 * break the user-facing flow.
 */
import { query } from "./db";

export type AuditOutcome = "success" | "failure" | "denied";

export interface AuditRecord {
  actor?: string | null;        // email or "anonymous"
  actorKind?: "portal" | "unknown";
  action: string;               // e.g. "auth.login", "auth.logout", "reports.view"
  target?: string | null;       // e.g. shortcode code, user id
  outcome: AuditOutcome;
  ip?: string | null;
  userAgent?: string | null;
  detail?: Record<string, unknown> | null;
}

export async function audit(rec: AuditRecord): Promise<void> {
  try {
    await query(
      `INSERT INTO portal_audit_log
         (actor, actor_kind, action, target, outcome, ip, user_agent, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        rec.actor ?? null,
        rec.actorKind ?? "portal",
        rec.action,
        rec.target ?? null,
        rec.outcome,
        rec.ip ?? null,
        rec.userAgent ?? null,
        rec.detail ? JSON.stringify(rec.detail) : null,
      ],
    );
  } catch (e) {
    // Swallow — audit failure must not break the request. Log to
    // stderr so it's visible in the container logs.
    console.error("audit insert failed:", e);
  }
}

/**
 * Pull request IP from the standard proxy headers, falling back to
 * the raw socket address. The gateway is typically behind Kong/nginx
 * so x-forwarded-for is the authoritative source.
 */
export function clientIp(req: Request | Headers): string | null {
  const h = req instanceof Headers ? req : req.headers;
  const xff = h.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return h.get("x-real-ip") || null;
}
