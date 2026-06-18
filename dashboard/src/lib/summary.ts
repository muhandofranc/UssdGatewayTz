/**
 * Daily summary reads. Backed by `daily_session_summary` (db/015) —
 * pre-aggregated nightly, scoped to yesterday-and-earlier. The
 * /summary page reads from here directly; we never hit
 * ussd_session_logs at request time.
 *
 * Per-shortcode access control is enforced the same way as the
 * live reports: every public function takes `allowedShortcodeIds:
 * number[] | null`.
 *   * null  -> unrestricted (super_admin / auditor; anyone with
 *              reports.view_all)
 *   * []    -> nothing (caller owns no shortcodes)
 *   * [...] -> intersect with the user-selected filter
 */
import { query } from "./db";

export type GroupBy =
  | "date"
  | "date_operator"
  | "date_shortcode"
  | "date_owner";

export interface SummaryFilters {
  /** Inclusive YYYY-MM-DD. */
  fromDate: string;
  /** Inclusive YYYY-MM-DD. */
  toDate: string;
  /** User-selected operator filter (operators.id). */
  operatorIds?: number[];
  /** User-selected shortcode filter (shortcodes.id). */
  shortcodeIds?: number[];
  /** User-selected owner filter (portal_users.id). Only visible to
   *  callers with reports.view_all in the UI; server still validates. */
  ownerUserId?: number;
}

export interface SummaryRow {
  date: string;                    // YYYY-MM-DD
  /** Present when groupBy != "date". Operator name / shortcode code /
   *  owner full name. */
  group_label: string | null;
  sessions: number;
  legs: number;
  errors: number;
  billable_units: number;
}

/**
 * The date through which data is considered complete. Rollup contains
 * yesterday-and-earlier only (Option A), so "data through" =
 * yesterday. The /summary page renders this so users don't expect
 * today's traffic to show up.
 */
export function dataThroughDate(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export async function loadDailySummary(
  f: SummaryFilters,
  allowedShortcodeIds: number[] | null,
  groupBy: GroupBy,
  maxRows: number = 5000,
): Promise<SummaryRow[]> {
  // GROUP BY projection per mode. All modes JOIN to the relevant
  // dimension table — small tables (operators ~5 rows, shortcodes
  // ~tens to hundreds, portal_users ~tens) — these joins are cheap.
  let groupCol: string;
  let labelCol: string;
  switch (groupBy) {
    case "date_operator":
      groupCol = "o.name";
      labelCol = "o.display_name";
      break;
    case "date_shortcode":
      // Fall back to 'unmatched' for the shortcode_id=0 sentinel.
      groupCol = "COALESCE(s.code, 'unmatched')";
      labelCol = "COALESCE(s.code || COALESCE(' · ' || s.label, ''), 'unmatched')";
      break;
    case "date_owner":
      // Owner is only resolvable for matched shortcodes (joined via
      // shortcodes.owner_user_id). Unmatched legs (shortcode_id=0)
      // get an 'unmatched' label so the row still shows in the
      // grouped table.
      groupCol = "COALESCE(u.email, 'unmatched')";
      labelCol = "COALESCE(u.name || ' <' || u.email || '>', 'unmatched')";
      break;
    case "date":
    default:
      groupCol = "''";
      labelCol = "NULL";
  }

  const conds: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params: any[] = [];
  const next = (v: unknown) => { params.push(v); return `$${params.length}`; };

  conds.push(`d.date BETWEEN ${next(f.fromDate)}::date AND ${next(f.toDate)}::date`);

  // Per-row access control. shortcode_id = 0 is the sentinel for
  // 'unmatched' legs (legs with no shortcode at the gateway). Only
  // unrestricted callers (super_admin / auditor) see them — that's
  // intentional: clients can't be granted access to 'unmatched'.
  if (allowedShortcodeIds !== null) {
    if (allowedShortcodeIds.length === 0) {
      // Caller owns nothing → no rows.
      conds.push("FALSE");
    } else {
      conds.push(`d.shortcode_id = ANY(${next(allowedShortcodeIds)}::int[])`);
    }
  }

  if (f.operatorIds && f.operatorIds.length) {
    conds.push(`d.operator_id = ANY(${next(f.operatorIds)}::int[])`);
  }
  if (f.shortcodeIds && f.shortcodeIds.length) {
    conds.push(`d.shortcode_id = ANY(${next(f.shortcodeIds)}::int[])`);
  }
  if (f.ownerUserId !== undefined && f.ownerUserId !== null) {
    // Owner filter requires resolving shortcode_id -> owner_user_id.
    // The shortcodes join is added below; we just add the predicate.
    conds.push(`s.owner_user_id = ${next(f.ownerUserId)}`);
  }

  const where = `WHERE ${conds.join(" AND ")}`;

  // The shortcodes + portal_users joins are LEFT so that
  // shortcode_id=0 rows (unmatched legs) still render — they have
  // s.code IS NULL, COALESCE'd to 'unmatched' in the SELECT.
  const sql = `
    SELECT
      d.date::text                                AS date,
      ${labelCol}                                 AS group_label,
      SUM(d.sessions)::bigint                     AS sessions,
      SUM(d.legs)::bigint                         AS legs,
      SUM(d.errors)::bigint                       AS errors,
      SUM(d.billable_units)::bigint               AS billable_units
    FROM daily_session_summary d
    JOIN      operators    o ON o.id = d.operator_id
    LEFT JOIN shortcodes   s ON s.id = d.shortcode_id
    LEFT JOIN portal_users u ON u.id = s.owner_user_id
    ${where}
    GROUP BY d.date, ${groupCol}, ${labelCol === groupCol ? "TRUE" : labelCol}
    ORDER BY d.date DESC, ${groupCol}
    LIMIT ${Math.max(1, Math.min(maxRows, 50000))}
  `;

  const r = await query<{
    date: string;
    group_label: string | null;
    sessions: string;
    legs: string;
    errors: string;
    billable_units: string;
  }>(sql, params);
  return r.rows.map((x) => ({
    date: x.date,
    group_label: x.group_label,
    sessions: Number(x.sessions),
    legs: Number(x.legs),
    errors: Number(x.errors),
    billable_units: Number(x.billable_units),
  }));
}

/** Hard cap on a single CSV export. 50k rows is plenty for a daily
 *  rollup — date×operator×shortcode at 5M sessions/day still fits
 *  well under this even for year-long windows. */
export const SUMMARY_CSV_ROW_CAP = 50_000;

/**
 * Stream the matching summary rows as RFC-4180 CSV. Same filter
 * shape as `loadDailySummary`, with a hard row cap. Returns a Web
 * ReadableStream so the route can hand it to NextResponse without
 * buffering the whole result in memory.
 */
export function streamDailySummaryCsv(
  f: SummaryFilters,
  allowedShortcodeIds: number[] | null,
  groupBy: GroupBy,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const includeGroup = groupBy !== "date";
  const groupHeader =
    groupBy === "date_operator"  ? "operator"  :
    groupBy === "date_shortcode" ? "shortcode" :
    groupBy === "date_owner"     ? "owner"     : "";

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const headers = includeGroup
          ? ["date", groupHeader, "sessions", "legs", "errors", "billable_units"]
          : ["date", "sessions", "legs", "errors", "billable_units"];
        controller.enqueue(encoder.encode(headers.join(",") + "\n"));

        // Reuse the same loader as the page — already encodes the
        // ACL + filter logic. Lift the LIMIT to SUMMARY_CSV_ROW_CAP
        // for the export (vs. the page's default of 5000).
        const rows = await loadDailySummary(
          f, allowedShortcodeIds, groupBy, SUMMARY_CSV_ROW_CAP,
        );

        for (const r of rows) {
          const cells = includeGroup
            ? [r.date, r.group_label ?? "", String(r.sessions), String(r.legs), String(r.errors), String(r.billable_units)]
            : [r.date, String(r.sessions), String(r.legs), String(r.errors), String(r.billable_units)];
          controller.enqueue(encoder.encode(cells.map(csvCell).join(",") + "\n"));
        }

        if (rows.length >= SUMMARY_CSV_ROW_CAP) {
          controller.enqueue(encoder.encode(
            `# truncated at ${SUMMARY_CSV_ROW_CAP} rows — narrow the filter to see more\n`,
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
  if (/[",\r\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

export interface OwnerOption {
  id: number;
  email: string;
  name: string;
  shortcode_count: number;
}

/**
 * Portal users who own at least one ACTIVE shortcode — populates the
 * owner-filter dropdown on /summary for callers with reports.view_all.
 */
export async function listShortcodeOwners(): Promise<OwnerOption[]> {
  const r = await query<OwnerOption>(
    `SELECT u.id, u.email, u.name, COUNT(s.id)::int AS shortcode_count
       FROM portal_users u
       JOIN shortcodes s ON s.owner_user_id = u.id AND s.active = TRUE
      GROUP BY u.id, u.email, u.name
      ORDER BY u.name`,
  );
  return r.rows;
}
