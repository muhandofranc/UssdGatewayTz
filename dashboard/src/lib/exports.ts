/**
 * Async export queue DB layer. Insert from the web side; the
 * ussd-exports-worker container claims, processes, and finalises
 * rows here without going through Next.js.
 */
import { query } from "./db";

/** Lifecycle: queued → running → ready → expired (file swept by retention sweep).
 *  Alt branches: running → failed (worker error), running → queued (zombie reaper). */
export type ExportStatus = "queued" | "running" | "ready" | "failed" | "expired";
export type Granularity  = "legs"   | "sessions";

export interface ExportRow {
  id: string;                     // bigint as string
  user_id: number;
  granularity: Granularity;
  filters: Record<string, unknown>;
  status: ExportStatus;
  requested_at: string;
  started_at: string | null;
  completed_at: string | null;
  file_path: string | null;
  row_count: string | null;       // bigint as string
  file_size_bytes: string | null;
  error_message: string | null;
}

/** All exports a user can see — the list page only shows their own,
 *  even for super_admin (downloads are tied to who requested). */
export async function listExportsForUser(userId: number): Promise<ExportRow[]> {
  const r = await query<ExportRow>(
    `SELECT id::text, user_id, granularity, filters, status,
            requested_at::text, started_at::text, completed_at::text,
            file_path, row_count::text, file_size_bytes::text, error_message
       FROM portal_exports
      WHERE user_id = $1
      ORDER BY requested_at DESC
      LIMIT 100`,
    [userId],
  );
  return r.rows;
}

export async function getExportForUser(
  exportId: number, userId: number,
): Promise<ExportRow | null> {
  const r = await query<ExportRow>(
    `SELECT id::text, user_id, granularity, filters, status,
            requested_at::text, started_at::text, completed_at::text,
            file_path, row_count::text, file_size_bytes::text, error_message
       FROM portal_exports
      WHERE id = $1 AND user_id = $2`,
    [exportId, userId],
  );
  return r.rows[0] ?? null;
}

export interface EnqueueArgs {
  userId: number;
  granularity: Granularity;
  /** Sanitised filter JSON; the worker applies the user's shortcode
   *  allowlist that lives inside it, so the export respects per-row
   *  access control across the async boundary. */
  filters: Record<string, unknown>;
}

export async function enqueueExport(args: EnqueueArgs): Promise<number> {
  const r = await query<{ id: string }>(
    `INSERT INTO portal_exports (user_id, granularity, filters)
     VALUES ($1, $2, $3::jsonb)
     RETURNING id::text`,
    [args.userId, args.granularity, JSON.stringify(args.filters)],
  );
  return Number(r.rows[0]!.id);
}
