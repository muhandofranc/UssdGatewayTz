/**
 * Operators admin DB queries. The operators table is small + stable
 * (4 rows for TZ today) so we only support EDIT, not create/delete.
 *
 * Edits are scoped to the columns super_admin should actually be
 * able to tune at runtime:
 *   * display_name        — friendly name shown in reports
 *   * billable_window_secs — per-MNO USSD-billing window (nullable
 *                            for per-leg-billing MNOs like Halotel)
 *   * active              — flips the gateway from accepting traffic
 *                            for this MNO (does NOT touch existing
 *                            session logs)
 *
 * `name` is the canonical lowercase routing key the gateway code
 * reads (e.g. /ussd/<name>) — NEVER edit it from the dashboard,
 * since it would silently desync running adapters.
 */
import { query } from "./db";

export interface OperatorRow {
  id: number;
  name: string;
  display_name: string;
  active: boolean;
  billable_window_secs: number | null;
  created_at: string;
}

export interface OperatorWrite {
  display_name: string;
  billable_window_secs: number | null;
  active: boolean;
}

export async function listOperatorsAdmin(): Promise<OperatorRow[]> {
  const r = await query<OperatorRow>(
    `SELECT id, name, display_name, active, billable_window_secs,
            created_at::text
       FROM operators
      ORDER BY id`,
  );
  return r.rows;
}

export async function getOperator(id: number): Promise<OperatorRow | null> {
  const r = await query<OperatorRow>(
    `SELECT id, name, display_name, active, billable_window_secs,
            created_at::text
       FROM operators
      WHERE id = $1`,
    [id],
  );
  return r.rows[0] ?? null;
}

export async function updateOperator(id: number, w: OperatorWrite): Promise<void> {
  await query(
    `UPDATE operators
        SET display_name = $2,
            billable_window_secs = $3,
            active = $4
      WHERE id = $1`,
    [id, w.display_name, w.billable_window_secs, w.active],
  );
}
