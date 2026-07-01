/**
 * Reports query builder.
 *
 * Per-shortcode access control is enforced HERE — every public
 * function takes a `shortcodeIds: number[] | null` argument lifted
 * from the JWT. `null` = unrestricted (super_admin); any array
 * (including empty) is treated as the allowlist and joined into the
 * WHERE clause via `shortcode_id = ANY($n::int[])`.
 *
 * This is the SINGLE place that turns the JWT's shortcodeIds into
 * SQL. Don't replicate the predicate elsewhere — extend this lib
 * instead, so every new report inherits the access control.
 *
 * Pagination uses OFFSET + a bounded COUNT (capped at 10,000 — past
 * that we show "10,000+" instead of paying for a full COUNT(*) on
 * the partitioned-future ussd_session_logs).
 */
import { query } from "./db";

export const MAX_PAGE_SIZE = 100;
export const COUNT_CAP = 10_000;

/** All filters are optional; missing = no narrowing on that field. */
export interface ReportFilters {
  fromTs?: string;                 // ISO date / 'YYYY-MM-DD' (start of day local)
  toTs?: string;                   // ISO date / 'YYYY-MM-DD' (end of day local)
  msisdn?: string;                 // exact match
  sessionId?: string;              // exact match
  operators?: string[];            // operators.name values
  shortcodeIds?: number[];         // user-selected shortcode ids
  errorClass?: "any" | "ok" | "error" | string;   // 'ok' = error_class IS NULL; 'error' = any non-null; specific class string = =$n
}

export interface ReportRow {
  id: string;                      // bigint as string
  ts: string;                      // ISO
  operator_name: string;
  shortcode_code: string | null;
  msisdn: string | null;
  session_id: string;
  direction: string;
  handler_response_action: string | null;
  handler_response_text: string | null;
  ussd_string: string | null;
  error_class: string | null;
  handler_elapsed_ms: number | null;
}

interface BuiltClause {
  sql: string;            // " WHERE ..." (or "" if no predicates)
  params: any[];
}

/**
 * Compose the WHERE clause from filters + the per-user shortcode
 * allowlist. The first param is always the role-based allowlist
 * predicate ($1), others come from active filters.
 *
 * `allowedShortcodeIds = null` => no per-row restriction.
 * `allowedShortcodeIds = []`   => deny everything (client owns nothing).
 */
function buildWhere(
  filters: ReportFilters,
  allowedShortcodeIds: number[] | null,
): BuiltClause {
  const conds: string[] = [];
  const params: any[] = [];
  const next = (v: any) => { params.push(v); return `$${params.length}`; };

  // Per-row access control — the most important predicate.
  if (allowedShortcodeIds !== null) {
    if (allowedShortcodeIds.length === 0) {
      conds.push("FALSE");                              // owns nothing → no rows
    } else {
      conds.push(`shortcode_id = ANY(${next(allowedShortcodeIds)}::int[])`);
    }
  }

  if (filters.fromTs) conds.push(`ts >= ${next(filters.fromTs)}::timestamptz`);
  if (filters.toTs)   conds.push(`ts <  (${next(filters.toTs)}::date + interval '1 day')`);
  if (filters.msisdn) conds.push(`msisdn = ${next(filters.msisdn)}`);
  if (filters.sessionId) conds.push(`session_id = ${next(filters.sessionId)}`);

  if (filters.operators && filters.operators.length) {
    conds.push(`operator_name = ANY(${next(filters.operators)}::text[])`);
  }

  // User-selected shortcode subset MUST intersect with the allowlist.
  // We already restricted via allowedShortcodeIds above; this further
  // narrows to the user's filter choice.
  if (filters.shortcodeIds && filters.shortcodeIds.length) {
    conds.push(`shortcode_id = ANY(${next(filters.shortcodeIds)}::int[])`);
  }

  if (filters.errorClass === "ok") {
    conds.push(`error_class IS NULL`);
  } else if (filters.errorClass === "error") {
    conds.push(`error_class IS NOT NULL`);
  } else if (filters.errorClass && filters.errorClass !== "any") {
    conds.push(`error_class = ${next(filters.errorClass)}`);
  }

  return {
    sql: conds.length ? ` WHERE ${conds.join(" AND ")}` : "",
    params,
  };
}

export interface ReportPage {
  rows: ReportRow[];
  totalKnown: number;          // 0..COUNT_CAP
  totalCapped: boolean;        // true means "totalKnown >= COUNT_CAP, real count unknown"
}

export async function loadReportPage(
  filters: ReportFilters,
  allowedShortcodeIds: number[] | null,
  page: number,        // 1-indexed
  pageSize: number,
): Promise<ReportPage> {
  const ps = Math.max(1, Math.min(MAX_PAGE_SIZE, pageSize));
  const offset = Math.max(0, (page - 1) * ps);

  const where = buildWhere(filters, allowedShortcodeIds);

  // Bounded count — LIMIT (COUNT_CAP + 1) cap. If we hit cap+1, we
  // report "totalCapped" and don't bother summing further.
  const countSql = `
    SELECT COUNT(*) AS c
      FROM (
        SELECT 1 FROM ussd_session_logs l${where.sql}
        LIMIT ${COUNT_CAP + 1}
      ) capped
  `;
  const countR = await query<{ c: string }>(countSql, where.params);
  const rawCount = Number(countR.rows[0]?.c ?? 0);
  const totalCapped = rawCount > COUNT_CAP;
  const totalKnown  = totalCapped ? COUNT_CAP : rawCount;

  // The row query joins operators + shortcodes so the table shows
  // human-friendly columns without a second round-trip.
  const rowsSql = `
    SELECT l.id::text, l.ts,
           l.operator_name,
           -- Prefer the configured shortcode label; fall back to the
           -- dialed service_code so 'shortcode_not_found' rows still
           -- show what the customer dialed instead of a blank cell.
           COALESCE(s.code, l.service_code) AS shortcode_code,
           l.msisdn, l.session_id, l.direction,
           l.handler_response_action, l.handler_response_text,
           l.ussd_string, l.error_class, l.handler_elapsed_ms
      FROM ussd_session_logs l
 LEFT JOIN shortcodes s ON s.id = l.shortcode_id
       ${where.sql}
  ORDER BY l.ts DESC, l.id DESC
     LIMIT ${ps} OFFSET ${offset}
  `;
  const rowsR = await query<ReportRow>(rowsSql, where.params);
  return { rows: rowsR.rows, totalKnown, totalCapped };
}

export interface OperatorSummary {
  operator_name: string;
  /** Billing window from operators.billable_window_secs (null = MNO
   *  bills per-leg / flat, so billable_units is also null). */
  window_secs: number | null;
  sessions: number;
  /** Sum of GREATEST(1, CEIL(duration / window)) across this MNO's
   *  sessions. null when window_secs is null. */
  billable_units: number | null;
}

export interface BillableSummary {
  /** Per-MNO breakdown: row per operator that appears in the filtered
   *  set. Empty array when no sessions match. */
  per_operator: OperatorSummary[];
  /** Sum of billable_units across operators with a configured window
   *  (Halotel-style NULL-window operators contribute 0). */
  total_billable_units: number;
}

/**
 * Per-MNO session + billable totals. Each MNO's billable window
 * comes from operators.billable_window_secs — editable by super_admin
 * via the /operators admin page. NULL window means the MNO bills
 * per-leg / flat (Halotel) and billable_units is reported as null
 * for that operator.
 */
export async function loadBillableSummary(
  filters: ReportFilters,
  allowedShortcodeIds: number[] | null,
): Promise<BillableSummary> {
  const where = buildWhere(filters, allowedShortcodeIds);

  // Per-(session, operator) duration, then group by operator and
  // compute totals against each operator's configured window.
  const sql = `
    WITH per_session AS (
      SELECT operator_name, session_id,
             EXTRACT(EPOCH FROM (MAX(ts) - MIN(ts)))::float8 AS duration_secs
        FROM ussd_session_logs l${where.sql}
       GROUP BY operator_name, session_id
    ),
    per_op AS (
      SELECT
        ps.operator_name,
        o.billable_window_secs AS window_secs,
        COUNT(*)::bigint AS sessions,
        CASE WHEN o.billable_window_secs IS NOT NULL
             THEN SUM(GREATEST(1, CEIL(ps.duration_secs / o.billable_window_secs::float8))::int)::bigint
             ELSE NULL
        END AS billable_units
      FROM per_session ps
      JOIN operators o ON o.name = ps.operator_name
      GROUP BY ps.operator_name, o.billable_window_secs
    )
    SELECT operator_name,
           window_secs,
           sessions,
           billable_units
      FROM per_op
     ORDER BY operator_name
  `;
  const r = await query<{
    operator_name: string;
    window_secs: number | null;
    sessions: string;
    billable_units: string | null;
  }>(sql, where.params);

  const per_operator: OperatorSummary[] = r.rows.map((x) => ({
    operator_name: x.operator_name,
    window_secs: x.window_secs,
    sessions: Number(x.sessions),
    billable_units: x.billable_units === null ? null : Number(x.billable_units),
  }));
  // For MNOs with a billing window: billable_units (= CEIL(duration/window)).
  // For per-leg MNOs (window NULL, e.g. Halotel): one session_id = one
  // billable session, so the unique-session count IS the billable count.
  // Treating null as 0 here drops Halotel out of the grand total.
  const total_billable_units = per_operator.reduce(
    (acc, op) => acc + (op.billable_units ?? op.sessions), 0,
  );
  return { per_operator, total_billable_units };
}

/**
 * Shortcode dropdown options for the filter form — narrowed by the
 * user's allowlist so a `client` only sees their own codes in the
 * picker (avoids leaking the existence of other partners).
 */
/* ----------------------------------------------------------------
 *  Per-session aggregation — one row per (session_id, operator).
 *
 *  duration_secs = MAX(ts) - MIN(ts) across the session's legs.
 *  A session with exactly one leg has duration_secs = 0.
 *  vodacom_billable_units = FLOOR(duration_secs / 20) + 1   (vodacom only)
 *
 *  Filters apply at the LEG level (a session is included if any of
 *  its legs match), so date-range filters still surface a session
 *  even if only its last leg falls inside the window. That matches
 *  the "show me what was happening yesterday" mental model.
 * ----------------------------------------------------------------*/

/** A single HTTP leg returned by the lazy-fetch /api/sessions/legs.
 *  Subset of ReportRow columns — the ones useful for the per-session
 *  drill-in. */
export interface SessionLeg {
  id: string;
  ts: string;
  msisdn: string | null;
  direction: string;
  handler_response_action: string | null;
  handler_response_text: string | null;
  ussd_string: string | null;
  error_class: string | null;
  handler_elapsed_ms: number | null;
}

/**
 * Fetch every leg for one (session_id, operator) — used by the API
 * route backing the expandable-row chevron. Per-row access control
 * is enforced via the same shortcode allowlist passed to
 * loadSessionPage. Hard cap at 200 legs to keep the API response
 * bounded even for pathological sessions.
 */
export async function loadLegsForSession(
  sessionId: string,
  operatorName: string,
  allowedShortcodeIds: number[] | null,
): Promise<SessionLeg[]> {
  // Build a where clause that pins session_id + operator + the
  // user's shortcode allowlist. We DON'T reuse buildWhere because
  // we want a far narrower predicate (no date range, no filters).
  const conds: string[] = [
    "session_id = $1",
    "operator_name = $2",
  ];
  const params: any[] = [sessionId, operatorName];
  if (allowedShortcodeIds !== null) {
    if (allowedShortcodeIds.length === 0) return [];
    params.push(allowedShortcodeIds);
    conds.push(`shortcode_id = ANY($${params.length}::int[])`);
  }
  const r = await query<SessionLeg>(
    `SELECT id::text, ts::text, msisdn, direction,
            handler_response_action, handler_response_text,
            ussd_string, error_class, handler_elapsed_ms
       FROM ussd_session_logs
      WHERE ${conds.join(" AND ")}
      ORDER BY ts
      LIMIT 200`,
    params,
  );
  return r.rows;
}

export interface SessionRow {
  session_id: string;
  operator_name: string;
  shortcode_code: string | null;
  msisdn: string | null;
  first_ts: string;
  last_ts: string;
  duration_secs: number;
  leg_count: number;
  final_action: string | null;
  final_error_class: string | null;
  final_ussd_string: string | null;
  final_response_text: string | null;
  /** The MNO's billing window in seconds (from operators table).
   *  null = MNO bills per-leg / per-flat-session (Halotel). */
  billable_window_secs: number | null;
  /** GREATEST(1, CEIL(duration_secs / billable_window_secs)) per MNO,
   *  or null when the MNO has no duration-based window. Telecom
   *  convention: any spill into the next window = whole new window;
   *  even a 0-duration session is billed 1 unit. */
  billable_units: number | null;
  /** Per-leg detail is LAZY-LOADED via /api/sessions/legs on chevron
   *  expand — payload size used to scale with leg_count × pageSize
   *  (a 25×3-leg page added ~75KB just from pre-loaded legs), which
   *  hurt latency under high traffic. The row carries no legs by
   *  default now; ExpandableSessionRow fetches them on first open. */
  legs?: SessionLeg[];
}

export interface SessionPage {
  rows: SessionRow[];
  totalKnown: number;
  totalCapped: boolean;
}

/**
 * Fast bounded-count via the `daily_session_summary` rollup (db/015).
 * Returns the SUM of pre-aggregated per-day session counts for a
 * filter set that only touches fields the rollup can answer.
 *
 * Falls through (returns `null`) — signalling the caller to run the
 * slow DISTINCT+LIMIT scan — when ANY of the following holds:
 *
 *   * a filter needs raw-leg data the rollup doesn't carry
 *     (msisdn, sessionId, a specific errorClass beyond ok/error);
 *     `errorClass='error'` also falls through because the rollup
 *     only stores a total error count, not per-class rows;
 *   * the window overlaps today's date — the rollup is nightly-
 *     refreshed and doesn't cover today (see db/015 header note);
 *   * no explicit date range was supplied (an unbounded window
 *     would scan the whole rollup, defeating the purpose).
 *
 * We can't use the rollup for filters.errorClass='ok' either
 * without extra bookkeeping (SUM(sessions) − SUM_of_error_sessions
 * would over-count sessions whose LEGS split across ok+error
 * legs). Kept simple: only errorClass 'any' / undefined qualifies.
 */
async function tryRollupBoundedCount(
  filters: ReportFilters,
  allowedShortcodeIds: number[] | null,
): Promise<number | null> {
  if (filters.msisdn) return null;
  if (filters.sessionId) return null;
  if (filters.errorClass && filters.errorClass !== "any") return null;
  if (!filters.fromTs || !filters.toTs) return null;

  // The rollup covers up through yesterday (Africa/Nairobi day
  // boundary at the server level — we approximate with the JS
  // day boundary here; a mid-day rebuild would only ever OVER-
  // report by one day, never UNDER-report). Bail when toTs is
  // today or later to guarantee no gap.
  const today = new Date().toISOString().slice(0, 10);
  if (filters.toTs >= today) return null;

  // If allowedShortcodeIds is null → user has global report perms,
  // no shortcode restriction. If it's an empty array → the caller
  // has NO shortcodes granted; return 0 without hitting the DB.
  if (allowedShortcodeIds !== null && allowedShortcodeIds.length === 0) {
    return 0;
  }

  const params: any[] = [];
  const next = (v: any) => { params.push(v); return `$${params.length}`; };
  const conds: string[] = [
    `d.date >= ${next(filters.fromTs)}::date`,
    `d.date <= ${next(filters.toTs)}::date`,
  ];

  if (filters.operators && filters.operators.length) {
    // Rollup keys by operator_id; translate the operator_name filter
    // via a subquery so we don't need to teach the caller two shapes.
    conds.push(
      `d.operator_id IN (SELECT id FROM operators WHERE name = ANY(${next(filters.operators)}::text[]))`,
    );
  }
  // Intersect the user-selected shortcode filter with the RBAC allow-
  // list. If the user picked shortcodes, use those; else fall back to
  // the allowlist alone; else no shortcode narrowing at all.
  const scFilter = filters.shortcodeIds && filters.shortcodeIds.length
    ? filters.shortcodeIds.filter(
        (id) => allowedShortcodeIds === null || allowedShortcodeIds.includes(id),
      )
    : allowedShortcodeIds;
  if (scFilter !== null) {
    if (scFilter.length === 0) return 0;
    conds.push(`d.shortcode_id = ANY(${next(scFilter)}::int[])`);
  }

  const sql = `
    SELECT COALESCE(SUM(sessions), 0)::bigint AS c
      FROM daily_session_summary d
     WHERE ${conds.join(" AND ")}
  `;
  try {
    const r = await query<{ c: string }>(sql, params);
    return Number(r.rows[0]?.c ?? 0);
  } catch {
    // If the rollup table is missing (fresh install pre-db/015)
    // or the query fails for any other reason, fall back to the
    // slow path rather than 500-ing the page.
    return null;
  }
}


export async function loadSessionPage(
  filters: ReportFilters,
  allowedShortcodeIds: number[] | null,
  page: number,
  pageSize: number,
): Promise<SessionPage> {
  const ps = Math.max(1, Math.min(MAX_PAGE_SIZE, pageSize));
  const offset = Math.max(0, (page - 1) * ps);
  const where = buildWhere(filters, allowedShortcodeIds);

  // Bounded count of DISTINCT sessions matching the filter set. Two
  // paths: FAST via daily_session_summary (db/015) when the filter
  // set only uses fields the rollup can answer, otherwise the
  // DISTINCT+LIMIT scan.
  //
  // The rollup path skips scanning `ussd_session_logs` entirely for
  // the count step — sub-10ms even on a 30-day window. It falls
  // through to the slow path when a filter can't be answered from
  // the pre-aggregate (msisdn, sessionId, specific error class),
  // OR when the window includes today (rollup only covers past
  // days per db/015).
  const rollupCount = await tryRollupBoundedCount(filters, allowedShortcodeIds);
  let totalKnown: number;
  let totalCapped: boolean;
  if (rollupCount !== null) {
    totalCapped = rollupCount > COUNT_CAP;
    totalKnown = totalCapped ? COUNT_CAP : rollupCount;
  } else {
    const countSql = `
      SELECT COUNT(*) AS c
        FROM (
          SELECT DISTINCT session_id, operator_name
            FROM ussd_session_logs l${where.sql}
           LIMIT ${COUNT_CAP + 1}
        ) capped
    `;
    const countR = await query<{ c: string }>(countSql, where.params);
    const rawCount = Number(countR.rows[0]?.c ?? 0);
    totalCapped = rawCount > COUNT_CAP;
    totalKnown = totalCapped ? COUNT_CAP : rawCount;
  }

  // Rows query — one pass over the base table via DISTINCT ON +
  // window functions (was: six `array_agg(x ORDER BY ts DESC)[1]`
  // aggregates, one per "latest leg" column, each forcing a per-
  // group Sort). The refactor pairs with db/018's composite index
  // (session_id, operator_name, ts DESC) so PG walks the index in
  // order and never has to spill a Sort to disk on wide windows.
  //
  // Semantics of the columns:
  //   * `latest-by-ts` fields (service_code, final_action, ...) —
  //     DISTINCT ON with ORDER BY (session_id, operator_name, ts DESC)
  //     picks the last-arriving leg, which is what the old query did.
  //   * `any-non-null` fields (shortcode_id, msisdn) — FIRST_VALUE
  //     with ORDER BY (col IS NULL, ts DESC) inside an UNBOUNDED
  //     window frame gives the first non-null value across the
  //     partition, preserving the original behaviour where a shortcode
  //     resolved on leg 1 survives even if later legs went NULL.
  //   * aggregates (MIN/MAX/COUNT) — window functions over
  //     `PARTITION BY session_id, operator_name`, evaluated in the
  //     same pass DISTINCT ON already needs, so effectively free.
  //
  // COALESCE(s.code, g.service_code) preserves the "shortcode_not_
  // found" display fallback that the old query provided.
  const rowsSql = `
    WITH grouped AS (
      SELECT DISTINCT ON (session_id, operator_name)
        session_id,
        operator_name,
        service_code,
        handler_response_action AS final_action,
        error_class             AS final_error_class,
        ussd_string             AS final_ussd_string,
        handler_response_text   AS final_response_text,
        MIN(ts) OVER w AS first_ts,
        MAX(ts) OVER w AS last_ts,
        COUNT(*) OVER w AS leg_count,
        FIRST_VALUE(shortcode_id) OVER (
          PARTITION BY session_id, operator_name
          ORDER BY (shortcode_id IS NULL), ts DESC
          ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
        ) AS shortcode_id,
        FIRST_VALUE(msisdn) OVER (
          PARTITION BY session_id, operator_name
          ORDER BY (msisdn IS NULL), ts DESC
          ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
        ) AS msisdn
        FROM ussd_session_logs l${where.sql}
        WINDOW w AS (PARTITION BY session_id, operator_name)
        ORDER BY session_id, operator_name, ts DESC NULLS LAST
    )
    SELECT
      g.session_id, g.operator_name,
      COALESCE(s.code, g.service_code) AS shortcode_code,
      g.msisdn,
      g.first_ts::text, g.last_ts::text,
      -- Sub-second precision, ::float8 so node-postgres delivers a
      -- real JS number rather than a NUMERIC-as-string.
      EXTRACT(EPOCH FROM (g.last_ts - g.first_ts))::float8 AS duration_secs,
      g.leg_count::int,
      g.final_action, g.final_error_class,
      g.final_ussd_string, g.final_response_text,
      o.billable_window_secs,
      CASE WHEN o.billable_window_secs IS NOT NULL
           THEN GREATEST(1, CEIL(
             EXTRACT(EPOCH FROM (g.last_ts - g.first_ts))::float8
             / o.billable_window_secs::float8
           ))::int
           ELSE NULL
      END AS billable_units
    FROM grouped g
    LEFT JOIN shortcodes s ON s.id = g.shortcode_id
    LEFT JOIN operators  o ON o.name = g.operator_name
    ORDER BY g.last_ts DESC, g.session_id DESC
    LIMIT ${ps} OFFSET ${offset}
  `;
  const rowsR = await query<SessionRow>(rowsSql, where.params);
  return { rows: rowsR.rows, totalKnown, totalCapped };
}

export interface ShortcodeOption {
  id: number;
  operator_name: string;
  code: string;
  label: string | null;
}

export async function loadShortcodeOptions(
  allowedShortcodeIds: number[] | null,
): Promise<ShortcodeOption[]> {
  if (allowedShortcodeIds !== null && allowedShortcodeIds.length === 0) {
    return [];
  }
  const where = allowedShortcodeIds === null
    ? ""
    : "WHERE s.id = ANY($1::int[])";
  const params = allowedShortcodeIds === null ? [] : [allowedShortcodeIds];

  const r = await query<ShortcodeOption>(
    `SELECT s.id, o.name AS operator_name, s.code, s.label
       FROM shortcodes s
       JOIN operators o ON o.id = s.operator_id
       ${where}
      ORDER BY o.name, s.code`,
    params,
  );
  return r.rows;
}
