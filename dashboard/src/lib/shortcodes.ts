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

// 'sandbox' shortcodes are testable ONLY via the simulator — the gateway
// resolver filters them out (migration 024, app/db.py). 'production' is
// the routable environment.
export type ShortcodeEnvironment = "sandbox" | "production";

export interface ShortcodeRow {
  id: number;
  operator_id: number;
  operator_name: string;
  code: string;
  label: string | null;
  environment: ShortcodeEnvironment;
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
  /** When the current owner was given this shortcode (db/025). */
  owner_since: string;
  /**
   * True when this shortcode changed hands after it was created — i.e.
   * the owner's reports start part-way through its history. Drives the
   * "traffic from …" note so an owner doesn't read the missing earlier
   * months as a gap in the data.
   */
  reallocated: boolean;
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
           s.code, s.label, s.environment, s.owner_user_id,
           u.email AS owner_email, u.name AS owner_name,
           s.handler_url, s.auth_mode, s.bearer_token,
           s.timeout_secs, s.active,
           s.status, s.status_message,
           s.status_set_by_id,
           sb.email AS status_set_by_email,
           s.status_set_at::text,
           s.created_at::text, s.updated_at::text,
           s.owner_since::text,
           (s.owner_since > s.created_at) AS reallocated
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
  /** 'sandbox' | 'production' exact match. */
  environment?: ShortcodeEnvironment;
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
  if (f.environment) {
    conds.push(`s.environment = ${next(f.environment)}`);
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

/* ---------- label generation ----------------------------------------
 * Labels are DERIVED, never typed. Uniformity is the whole point: a
 * label a human can edit drifts within weeks, and reports that group
 * by label then split one shortcode across several spellings.
 *
 *   production →  "Acme Ltd · *123# · Vodacom Tanzania"
 *   sandbox    →  "Acme Ltd · *123# · SANDBOX"
 *
 * Sandbox carries no network because it never reaches one — it exists
 * only for the simulator, and the real network is chosen at promotion.
 */
export const LABEL_SEP = " · ";
export const SANDBOX_NETWORK_LABEL = "SANDBOX";

export function buildShortcodeLabel(args: {
  ownerName: string;
  code: string;
  operatorDisplayName?: string | null;
  environment: ShortcodeEnvironment;
}): string {
  const network = args.environment === "sandbox"
    ? SANDBOX_NETWORK_LABEL
    : (args.operatorDisplayName || "").trim();
  const code = args.code.trim();
  // shortcodes.label is VARCHAR(120), so a very long owner name has to
  // give. Clip the OWNER, not the joined string: truncating the tail
  // would drop the code and network — the two parts that identify the
  // shortcode — and leave a label of nothing but a name.
  const tail  = [code, network].filter((x) => x.length > 0);
  const budget = 120 - tail.reduce((n, x) => n + x.length + LABEL_SEP.length, 0);
  let owner = args.ownerName.trim();
  if (owner.length > budget) owner = budget > 1 ? owner.slice(0, budget - 1) + "…" : "";
  return [owner, ...tail].filter((x) => x.length > 0).join(LABEL_SEP);
}

/** Owner display name + operator display name, for label generation. */
export async function labelPartsFor(
  ownerUserId: number, operatorId: number,
): Promise<{ ownerName: string; operatorDisplayName: string }> {
  const r = await query<{ owner_name: string; operator_display_name: string }>(
    `SELECT COALESCE(NULLIF(TRIM(u.name), ''), u.email) AS owner_name,
            o.display_name                              AS operator_display_name
       FROM portal_users u
       CROSS JOIN operators o
      WHERE u.id = $1 AND o.id = $2`,
    [ownerUserId, operatorId],
  );
  const row = r.rows[0];
  return {
    // Falling back to the ids keeps a label generatable even if a row
    // vanished mid-request; the save then still succeeds.
    ownerName: row?.owner_name ?? `user#${ownerUserId}`,
    operatorDisplayName: row?.operator_display_name ?? "",
  };
}

/**
 * The operator a SANDBOX shortcode is filed under.
 *
 * Sandbox is network-agnostic — the gateway never routes it — but
 * `shortcodes.operator_id` is NOT NULL, so a row still needs one. The
 * lowest active operator id is used purely as a placeholder; the real
 * network is chosen by the super_admin at promotion time.
 */
export async function defaultSandboxOperatorId(): Promise<number> {
  const r = await query<{ id: number }>(
    `SELECT id FROM operators WHERE active = TRUE ORDER BY id LIMIT 1`,
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error("no active operator configured");
  return id;
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
  environment: ShortcodeEnvironment;
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
       (operator_id, code, label, environment, owner_user_id, handler_url,
        auth_mode, bearer_token, timeout_secs, active,
        status, status_message, status_set_by_id, status_set_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
             $11, $12, $13, now())
     RETURNING id`,
    [w.operator_id, w.code, w.label, w.environment, w.owner_user_id, w.handler_url,
     w.auth_mode, w.bearer_token, w.timeout_secs, active,
     w.status, w.status_message, byUserId],
  );
  return r.rows[0]!.id;
}

/**
 * Promote a SANDBOX shortcode to PRODUCTION by cloning it into a new
 * production row (the sandbox copy is left intact so testers keep
 * iterating). Caller MUST be super_admin and MUST have verified there is
 * no existing production (operator_id, code) — see actionPromoteShortcode.
 * Returns the new production row's id.
 */
export async function promoteShortcode(
  sandboxId: number, operatorId: number, byUserId: number,
): Promise<number> {
  // The sandbox row carries a placeholder operator and a "… · SANDBOX"
  // label, so neither can be cloned: promotion is where the live network
  // is decided, and the label is rebuilt around it.
  const src = await query<{ code: string; owner_user_id: number }>(
    `SELECT code, owner_user_id FROM shortcodes
      WHERE id = $1 AND environment = 'sandbox'`,
    [sandboxId],
  );
  const row = src.rows[0];
  if (!row) throw new Error("promote failed: shortcode not found or not sandbox");
  const { ownerName, operatorDisplayName } =
    await labelPartsFor(row.owner_user_id, operatorId);
  const label = buildShortcodeLabel({
    ownerName, code: row.code, operatorDisplayName, environment: "production",
  });

  const r = await query<{ id: number }>(
    `INSERT INTO shortcodes
       (operator_id, code, label, environment, owner_user_id, handler_url,
        auth_mode, bearer_token, timeout_secs, active,
        status, status_message, status_set_by_id, status_set_at)
     SELECT $3, code, $4, 'production', owner_user_id, handler_url,
            auth_mode, bearer_token, timeout_secs, TRUE,
            'active', NULL, $2, now()
       FROM shortcodes
      WHERE id = $1 AND environment = 'sandbox'
     RETURNING id`,
    [sandboxId, byUserId, operatorId, label],
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error("promote failed: shortcode not found or not sandbox");
  return id;
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

// Update ONLY the handler URL. Used by owner/clients from /my-shortcodes
// (scoped to their own shortcodes in the server action) and by admins.
// Deliberately narrow — it never touches operator/code/owner/auth/token,
// so a client can't escalate via this path.
export async function setShortcodeHandlerUrl(
  id: number, handlerUrl: string,
): Promise<void> {
  await query(
    `UPDATE shortcodes SET handler_url = $2, updated_at = now() WHERE id = $1`,
    [id, handlerUrl],
  );
}

// Back-compat shim — pre-007 callers used setShortcodeActive(id, bool).
export async function setShortcodeActive(
  id: number, active: boolean, byUserId: number,
): Promise<void> {
  await setShortcodeStatus(id, active ? "active" : "deactivated", null, byUserId);
}

/**
 * Max sandbox shortcodes a self-service user may hold PER OPERATOR that have
 * not yet been promoted. Anti-abuse cap on the /my-shortcodes create path.
 */
export const SANDBOX_PER_OPERATOR_LIMIT = 2;

/**
 * Count a user's sandbox shortcodes for one operator that have NOT yet been
 * promoted — i.e. no production shortcode exists with the same
 * (operator_id, code). A promoted sandbox (its production sibling exists)
 * no longer counts, so promoting one frees a slot for a new sandbox while
 * the sandbox copy stays alive for continued testing.
 */
export async function countUnpromotedSandbox(
  ownerUserId: number, operatorId: number,
): Promise<number> {
  const r = await query<{ n: number }>(
    `SELECT COUNT(*)::int AS n
       FROM shortcodes s
      WHERE s.owner_user_id = $1
        AND s.operator_id   = $2
        AND s.environment   = 'sandbox'
        AND NOT EXISTS (
              SELECT 1 FROM shortcodes p
               WHERE p.operator_id = s.operator_id
                 AND p.code        = s.code
                 AND p.environment = 'production')`,
    [ownerUserId, operatorId],
  );
  return Number(r.rows[0]?.n ?? 0);
}

/**
 * Returns true if (operator_id, code, environment) already exists for
 * another row. Uniqueness is per-environment (migration 024), so the same
 * code may live in both sandbox and production simultaneously.
 */
export async function codeExists(
  operatorId: number, code: string, environment: ShortcodeEnvironment,
  excludeId?: number,
): Promise<boolean> {
  const r = await query<{ id: number }>(
    excludeId
      ? `SELECT id FROM shortcodes WHERE operator_id = $1 AND code = $2 AND environment = $3 AND id <> $4 LIMIT 1`
      : `SELECT id FROM shortcodes WHERE operator_id = $1 AND code = $2 AND environment = $3 LIMIT 1`,
    excludeId ? [operatorId, code, environment, excludeId] : [operatorId, code, environment],
  );
  return r.rows.length > 0;
}
