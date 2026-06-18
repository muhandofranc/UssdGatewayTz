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

// =====================================================================
// Read side — for the super_admin /audit page (db/011 audit.view perm)
// =====================================================================

export interface AuditRow {
  id: number;
  ts: string;                    // ISO
  actor: string | null;
  actor_kind: string | null;
  action: string;
  target: string | null;
  outcome: string;
  ip: string | null;
  user_agent: string | null;
  detail: unknown | null;
}

export interface AuditFilters {
  from?: string | null;          // ISO date (inclusive)
  to?: string | null;            // ISO date (exclusive)
  actor?: string | null;         // ILIKE substring on actor email
  actionPrefix?: string | null;  // e.g. "shortcode" -> action LIKE 'shortcode.%'
  outcome?: "success" | "failure" | "denied" | null;
  page?: number;
  pageSize?: number;
}

export interface AuditPage {
  rows: AuditRow[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * Paginated audit log read. Filters AND together; `page` is 1-based.
 * Caps page size at 200 so a misconfigured caller can't accidentally
 * pull the whole table.
 */
export async function listAuditLog(f: AuditFilters): Promise<AuditPage> {
  const pageSize = Math.min(Math.max(1, f.pageSize ?? 50), 200);
  const page     = Math.max(1, f.page ?? 1);

  const where: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const args: any[] = [];
  const push = (clause: string, ...vals: unknown[]) => {
    args.push(...vals);
    const placeholders = vals.map((_, i) => `$${args.length - vals.length + i + 1}`);
    where.push(clause.replace(/\?/g, () => placeholders.shift()!));
  };

  if (f.from)    push("ts >= ?::timestamptz", f.from);
  if (f.to)      push("ts <  ?::timestamptz", f.to);
  if (f.actor)   push("actor ILIKE ?", `%${f.actor}%`);
  if (f.actionPrefix && f.actionPrefix !== "all") {
    push("action LIKE ?", `${f.actionPrefix}.%`);
  }
  if (f.outcome) push("outcome = ?", f.outcome);

  const whereSql = where.length ? ` WHERE ${where.join(" AND ")}` : "";

  // Count + page in a single round-trip via two queries; cheap because
  // the table is indexed on (ts, actor, action, outcome).
  const totalR = await query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM portal_audit_log${whereSql}`,
    args,
  );
  const total = Number(totalR.rows[0]?.c ?? 0);

  const offset = (page - 1) * pageSize;
  const rowsR = await query<AuditRow>(
    `SELECT id, ts::text AS ts, actor, actor_kind, action, target, outcome,
            ip, user_agent, detail
       FROM portal_audit_log
       ${whereSql}
      ORDER BY ts DESC, id DESC
      LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
    [...args, pageSize, offset],
  );

  return { rows: rowsR.rows, total, page, pageSize };
}

/**
 * Distinct action prefixes seen in the log — used to populate the
 * filter dropdown without hardcoding the catalogue here. Cached at
 * page render; the table is small enough this is cheap.
 */
export async function listActionPrefixes(): Promise<string[]> {
  const r = await query<{ p: string }>(
    `SELECT DISTINCT split_part(action, '.', 1) AS p
       FROM portal_audit_log
      WHERE action IS NOT NULL AND action <> ''
      ORDER BY 1`,
  );
  return r.rows.map((x) => x.p);
}

/** Hard cap on a single CSV export. 100k rows is plenty for an
 *  operator audit review window; if you need more, use SQL directly
 *  on the database. Prevents an accidental "all rows ever" download
 *  from streaming GBs of CSV. */
export const AUDIT_CSV_ROW_CAP = 100_000;

/**
 * Stream the matching audit rows as RFC-4180 CSV. Same filter shape
 * as `listAuditLog`, but no pagination — capped at
 * AUDIT_CSV_ROW_CAP. Used by /api/audit/export.csv.
 *
 * Returns a Web ReadableStream so the route can hand it to Next's
 * NextResponse without buffering the whole result in memory.
 */
export function streamAuditLogCsv(
  f: Omit<AuditFilters, "page" | "pageSize">,
): ReadableStream<Uint8Array> {
  // Build the same WHERE clause as listAuditLog. Duplicating the
  // tiny bit of param-building keeps the two callers independent.
  const where: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const args: any[] = [];
  const push = (clause: string, ...vals: unknown[]) => {
    args.push(...vals);
    const placeholders = vals.map((_, i) => `$${args.length - vals.length + i + 1}`);
    where.push(clause.replace(/\?/g, () => placeholders.shift()!));
  };
  if (f.from)    push("ts >= ?::timestamptz", f.from);
  if (f.to)      push("ts <  ?::timestamptz", f.to);
  if (f.actor)   push("actor ILIKE ?", `%${f.actor}%`);
  if (f.actionPrefix && f.actionPrefix !== "all") {
    push("action LIKE ?", `${f.actionPrefix}.%`);
  }
  if (f.outcome) push("outcome = ?", f.outcome);
  const whereSql = where.length ? ` WHERE ${where.join(" AND ")}` : "";

  const encoder = new TextEncoder();
  const HEADERS = [
    "ts", "actor", "actor_kind", "action", "target",
    "outcome", "ip", "user_agent", "detail",
  ];

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(HEADERS.join(",") + "\n"));
        const r = await query<AuditRow>(
          `SELECT id, ts::text AS ts, actor, actor_kind, action, target, outcome,
                  ip, user_agent, detail
             FROM portal_audit_log
             ${whereSql}
            ORDER BY ts DESC, id DESC
            LIMIT $${args.length + 1}`,
          [...args, AUDIT_CSV_ROW_CAP],
        );
        for (const row of r.rows) {
          const cells = [
            row.ts,
            row.actor ?? "",
            row.actor_kind ?? "",
            row.action,
            row.target ?? "",
            row.outcome,
            row.ip ?? "",
            row.user_agent ?? "",
            row.detail !== null && row.detail !== undefined ? JSON.stringify(row.detail) : "",
          ].map(csvCell).join(",");
          controller.enqueue(encoder.encode(cells + "\n"));
        }
        // If the cap was hit, leave a trailing comment so operators
        // notice and re-narrow the filter.
        if (r.rows.length >= AUDIT_CSV_ROW_CAP) {
          controller.enqueue(encoder.encode(
            `# truncated at ${AUDIT_CSV_ROW_CAP} rows — narrow the filter to see more\n`,
          ));
        }
      } catch (e) {
        controller.error(e);
        return;
      }
      controller.close();
    },
  });
}

/** RFC-4180-style cell quoting: wrap in quotes when needed; escape
 *  embedded quotes by doubling them. */
function csvCell(s: string): string {
  if (s === "") return "";
  // Quote when the cell contains comma, quote, CR, or LF.
  if (/[",\r\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}
