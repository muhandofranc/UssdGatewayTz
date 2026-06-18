/**
 * Shortcodes admin DB queries.
 *
 * `delete` is soft (status='deactivated') — `ussd_session_logs.shortcode_id`
 * is FK'd here, so a hard DROP would either fail or cascade-delete
 * historical traffic. Soft delete preserves the audit trail; the gateway
 * branches on `status` and renders the owner / SA's custom message when
 * a non-active status is seen.
 *
 * `active` (legacy boolean) stays in lockstep with `status='active'` so any
 * pre-007 tooling that still reads it sees consistent values.
 */
import { query } from "./db";

export type ShortcodeStatus = "active" | "maintenance" | "deactivated";

export interface ShortcodeRow {
  id: number;
  operator_id: number;
  operator_name: string;
  code: string;
  label: string | null;
  owner_user_id: number;
  owner_email: string;
  owner_name: string;
  handler_url: string;
  auth_mode: "none" | "bearer";
  bearer_token: string | null;
  timeout_secs: number;
  active: boolean;
  status: ShortcodeStatus;
  status_message: string | null;
  status_set_by_id: number | null;
  status_set_by_email: string | null;
  status_set_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface OperatorOption {
  id: number;
  name: string;
  display_name: string;
}

// Shared SELECT list — listShortcodes / getShortcode / listShortcodesOwnedBy
// all return the identical column shape so callers can share table components.
const SHORTCODE_SELECT = `
    SELECT s.id, s.operator_id, o.name AS operator_name,
           s.code, s.label, s.owner_user_id,
           u.email AS owner_email, u.name AS owner_name,
           s.handler_url, s.auth_mode, s.bearer_token,
           s.timeout_secs, s.active,
           s.status, s.status_message,
           s.status_set_by_id,
           sb.email AS status_set_by_email,
           s.status_set_at::text,
           s.created_at::text, s.updated_at::text
      FROM shortcodes s
      JOIN operators o    ON o.id = s.operator_id
      JOIN portal_users u ON u.id = s.owner_user_id
 LEFT JOIN portal_users sb ON sb.id = s.status_set_by_id
`;

export interface ShortcodeListFilters {
  /** operators.id values; OR'd via ANY(). Empty/undefined = no narrowing. */
  operatorIds?: number[];
  /** Exact match on shortcodes.status. */
  status?: ShortcodeStatus;
  /** 'none' | 'bearer' exact match. */
  authMode?: "none" | "bearer";
  /** portal_users.id exact match — typically only used by callers
   *  with reports.view_all (the page hides the dropdown otherwise). */
  ownerUserId?: number;
  /** Free-text ILIKE on code / label / handler_url. */
  search?: string;
}

export async function listShortcodes(
  f: ShortcodeListFilters = {},
): Promise<ShortcodeRow[]> {
  const conds: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params: any[] = [];
  const next = (v: unknown) => { params.push(v); return `$${params.length}`; };

  if (f.operatorIds && f.operatorIds.length) {
    conds.push(`s.operator_id = ANY(${next(f.operatorIds)}::int[])`);
  }
  if (f.status) {
    conds.push(`s.status = ${next(f.status)}`);
  }
  if (f.authMode) {
    conds.push(`s.auth_mode = ${next(f.authMode)}`);
  }
  if (f.ownerUserId !== undefined && Number.isFinite(f.ownerUserId)) {
    conds.push(`s.owner_user_id = ${next(f.ownerUserId)}`);
  }
  if (f.search && f.search.trim()) {
    const q = `%${f.search.trim()}%`;
    const p = next(q);
    conds.push(`(s.code ILIKE ${p} OR s.label ILIKE ${p} OR s.handler_url ILIKE ${p})`);
  }

  const where = conds.length ? ` WHERE ${conds.join(" AND ")}` : "";
  const r = await query<ShortcodeRow>(
    SHORTCODE_SELECT + where + " ORDER BY o.name, s.code",
    params,
  );
  return r.rows;
}

export async function getShortcode(id: number): Promise<ShortcodeRow | null> {
  const r = await query<ShortcodeRow>(SHORTCODE_SELECT + " WHERE s.id = $1", [id]);
  return r.rows[0] ?? null;
}

/**
 * For /my-shortcodes — every row a given portal user owns. The page
 * passes the session userId from cookies, so a client can't see another
 * client's shortcodes regardless of permission set.
 */
export async function listShortcodesOwnedBy(userId: number): Promise<ShortcodeRow[]> {
  const r = await query<ShortcodeRow>(
    SHORTCODE_SELECT + " WHERE s.owner_user_id = $1 ORDER BY o.name, s.code",
    [userId],
  );
  return r.rows;
}

export async function listOperators(): Promise<OperatorOption[]> {
  const r = await query<OperatorOption>(
    `SELECT id, name, display_name FROM operators WHERE active = TRUE ORDER BY id`,
  );
  return r.rows;
}

export interface OwnerOption {
  id: number;
  email: string;
  name: string;
}

export async function listPossibleOwners(): Promise<OwnerOption[]> {
  // Any active portal_user can own a shortcode. (Future tightening:
  // restrict to a "shortcode_owner" sub-role if we add one.)
  const r = await query<OwnerOption>(
    `SELECT id, email, name FROM portal_users WHERE active = TRUE ORDER BY email`,
  );
  return r.rows;
}

export interface ShortcodeWrite {
  operator_id: number;
  code: string;
  label: string | null;
  owner_user_id: number;
  handler_url: string;
  auth_mode: "none" | "bearer";
  bearer_token: string | null;
  timeout_secs: number;
  status: ShortcodeStatus;
  status_message: string | null;
}

export async function createShortcode(
  w: ShortcodeWrite, byUserId: number,
): Promise<number> {
  // Legacy `active` boolean stays in lockstep with status='active'.
  const active = w.status === "active";
  const r = await query<{ id: number }>(
    `INSERT INTO shortcodes
       (operator_id, code, label, owner_user_id, handler_url,
        auth_mode, bearer_token, timeout_secs, active,
        status, status_message, status_set_by_id, status_set_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
             $10, $11, $12, now())
     RETURNING id`,
    [w.operator_id, w.code, w.label, w.owner_user_id, w.handler_url,
     w.auth_mode, w.bearer_token, w.timeout_secs, active,
     w.status, w.status_message, byUserId],
  );
  return r.rows[0]!.id;
}

export async function updateShortcode(
  id: number, w: ShortcodeWrite, byUserId: number,
): Promise<void> {
  const active = w.status === "active";
  await query(
    `UPDATE shortcodes
        SET operator_id = $2, code = $3, label = $4,
            owner_user_id = $5, handler_url = $6,
            auth_mode = $7, bearer_token = $8,
            timeout_secs = $9, active = $10,
            status = $11, status_message = $12,
            status_set_by_id = $13, status_set_at = now(),
            updated_at = now()
      WHERE id = $1`,
    [id, w.operator_id, w.code, w.label, w.owner_user_id, w.handler_url,
     w.auth_mode, w.bearer_token, w.timeout_secs, active,
     w.status, w.status_message, byUserId],
  );
}

/**
 * Lightweight status flip — used by /my-shortcodes (owner-facing) and the
 * SA quick-actions on the list page. Doesn't touch any other field. Caller
 * MUST verify the user is allowed to flip this shortcode (owner may set
 * active/maintenance on their own; super_admin may also set deactivated
 * on any shortcode).
 */
export async function setShortcodeStatus(
  id: number, status: ShortcodeStatus,
  message: string | null, byUserId: number,
): Promise<void> {
  // The `active` boolean is derived in JS rather than recomputed in SQL so
  // we don't have to reuse a single parameter in two different type
  // contexts (the previous shape `active = ($2::text = 'active')`
  // tripped Postgres 16's "inconsistent types deduced for parameter $2"
  // — error 42P08, "text versus character varying" — because pg infers
  // $2 from `status = $2` as varchar AND from the boolean expr as text).
  const active = status === "active";
  await query(
    `UPDATE shortcodes
        SET status = $2,
            status_message = $3,
            status_set_by_id = $4,
            status_set_at = now(),
            active = $5,
            updated_at = now()
      WHERE id = $1`,
    [id, status, message, byUserId, active],
  );
}

// Back-compat shim — pre-007 callers used setShortcodeActive(id, bool).
export async function setShortcodeActive(
  id: number, active: boolean, byUserId: number,
): Promise<void> {
  await setShortcodeStatus(id, active ? "active" : "deactivated", null, byUserId);
}

/** Returns true if (operator_id, code) already exists for another row. */
export async function codeExists(
  operatorId: number, code: string, excludeId?: number,
): Promise<boolean> {
  const r = await query<{ id: number }>(
    excludeId
      ? `SELECT id FROM shortcodes WHERE operator_id = $1 AND code = $2 AND id <> $3 LIMIT 1`
      : `SELECT id FROM shortcodes WHERE operator_id = $1 AND code = $2 LIMIT 1`,
    excludeId ? [operatorId, code, excludeId] : [operatorId, code],
  );
  return r.rows.length > 0;
}
