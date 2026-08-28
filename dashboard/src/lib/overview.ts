/**
 * Overview page data helpers.
 *
 * `loadDailyTraffic` reads per-(day, operator) billable counts for
 * the selected month. Backed by two pre-aggregated sources to avoid
 * scanning hundreds of millions of legs from `ussd_session_logs` at
 * page-load time:
 *
 *   * Past days (day < today, Africa/Nairobi)
 *       ← `daily_session_summary` rollup (db/015, refreshed nightly)
 *   * Today (day = today, Africa/Nairobi)
 *       ← `today_session_summary_mv` materialised view (db/016,
 *          refreshed by cron — typically every 5 minutes)
 *
 * The two queries are UNIONed and summed per (day, operator). Today's
 * row is sourced ONLY from the MV — when the MV is stale, the bar
 * for today reflects the last refresh; once the cron next fires, the
 * page picks up the new numbers on its next render.
 *
 * Per-row access control is the same time-scoped allowlist
 * pattern the rest of the dashboard uses. shortcodeIds=null →
 * unrestricted (super_admin / auditor); [] → nothing (caller owns
 * none); [...] → intersection.
 */
import { query } from "./db";
import { aclClause, aclDeniesAll, type ShortcodeAcl } from "./acl";

export interface DailyTrafficRow {
  /** YYYY-MM-DD, Africa/Nairobi local day. */
  day: string;
  operator_name: string;
  billable_units: number;
}

export async function loadDailyTraffic(
  acl: ShortcodeAcl,
  monthYM: string,           // 'YYYY-MM'
): Promise<DailyTrafficRow[]> {
  // ACL predicate — empty allowlist returns nothing without a query.
  if (aclDeniesAll(acl)) return [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params: any[] = [];
  const push = (v: unknown) => { params.push(v); return `$${params.length}`; };

  // Both sources are day-grained, so the ACL's time floor rounds up to
  // a whole day (see lib/acl.ts). The two CTEs below read different
  // tables but need the identical predicate, so build it once and
  // re-alias — building it twice would push the same arrays as a second
  // set of parameters for no reason.
  const pastAcl  = aclClause(acl, {
    scCol: "d.shortcode_id", tsCol: "d.date", grain: "date", push,
  });
  const todayAcl = pastAcl
    .split("d.shortcode_id").join("m.shortcode_id")
    .split("d.date").join("m.date");

  params.push(`${monthYM}-01`);            // monthStart
  const monthIx = params.length;

  // Past days: read from the nightly rollup. d.date < today (EAT).
  // Today: read from the today MV.
  //
  // The two SELECTs return the same shape (day text, operator_name,
  // billable_units bigint). The outer SELECT sums + orders.
  const sql = `
    WITH past_days AS (
        SELECT to_char(d.date, 'YYYY-MM-DD')        AS day,
               o.name                               AS operator_name,
               SUM(d.billable_units)::bigint        AS billable_units
          FROM daily_session_summary d
          JOIN operators o ON o.id = d.operator_id
         WHERE d.date >= $${monthIx}::date
           AND d.date <  ($${monthIx}::date + interval '1 month')::date
           AND d.date <  (now() AT TIME ZONE 'Africa/Nairobi')::date
           AND ${pastAcl}
         GROUP BY d.date, o.name
    ),
    today AS (
        SELECT to_char(m.date, 'YYYY-MM-DD')        AS day,
               o.name                               AS operator_name,
               SUM(m.billable_units)::bigint        AS billable_units
          FROM today_session_summary_mv m
          JOIN operators o ON o.id = m.operator_id
         WHERE m.date >= $${monthIx}::date
           AND m.date <  ($${monthIx}::date + interval '1 month')::date
           AND ${todayAcl}
         GROUP BY m.date, o.name
    )
    SELECT day, operator_name, SUM(billable_units)::bigint AS billable_units
      FROM (SELECT * FROM past_days UNION ALL SELECT * FROM today) u
     GROUP BY day, operator_name
     ORDER BY day, operator_name
  `;

  const r = await query<{ day: string; operator_name: string; billable_units: string }>(
    sql, params,
  );
  return r.rows.map((x) => ({
    day: x.day,
    operator_name: x.operator_name,
    billable_units: Number(x.billable_units),
  }));
}
