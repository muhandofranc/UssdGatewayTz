/**
 * GET /api/summary/export.csv
 *
 * Streams a CSV of daily-summary rows matching the query-string
 * filters. Same filter shape as the /summary page — date range,
 * operator(s), shortcode(s), owner, group_by. Hard-capped at
 * SUMMARY_CSV_ROW_CAP rows.
 *
 * Gated on the same perms as /summary (reports.view_own OR
 * reports.view_all). The per-row ACL is enforced via session.shortcodeIds
 * exactly like the page; clients only get their own shortcodes,
 * super_admin / auditor get everything.
 *
 * Each download is itself audited (action="summary.export") so a
 * super_admin's bulk pulls show up in the audit log.
 */
import { NextResponse } from "next/server";
import { getSession, hasPerm } from "@/lib/auth";
import { Perms } from "@/lib/rbac";
import { audit, clientIp } from "@/lib/audit";
import {
  streamDailySummaryCsv, dataThroughDate,
  type GroupBy, type SummaryFilters,
} from "@/lib/summary";

function asIntArray(v: string[] | undefined): number[] {
  if (!v) return [];
  return v.map((x) => parseInt(x, 10)).filter(Number.isFinite);
}

export async function GET(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!hasPerm(session, Perms.REPORTS_VIEW_OWN) && !hasPerm(session, Perms.REPORTS_VIEW_ALL)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const u = new URL(req.url);
  const through  = dataThroughDate();
  const fromDate = u.searchParams.get("from") || through;
  const toDate   = u.searchParams.get("to")   || through;
  const operatorIds  = asIntArray(u.searchParams.getAll("operator_id"));
  const shortcodeIds = asIntArray(u.searchParams.getAll("shortcode_id"));
  const ownerRaw     = u.searchParams.get("owner_user_id");
  const ownerUserId  = ownerRaw ? parseInt(ownerRaw, 10) : undefined;
  const groupByRaw   = u.searchParams.get("group_by");
  const groupBy: GroupBy =
    groupByRaw === "date_operator"  ? "date_operator"  :
    groupByRaw === "date_shortcode" ? "date_shortcode" :
    groupByRaw === "date_owner"     ? "date_owner"     : "date";

  // Owner filter only applies when the caller has reports.view_all;
  // otherwise the per-row ACL already restricts to their shortcodes
  // and accepting an arbitrary owner here would let a client cheat
  // the filter (an empty result, but still — explicit is safer).
  const canSeeAll = hasPerm(session, Perms.REPORTS_VIEW_ALL);
  const filters: SummaryFilters = {
    fromDate, toDate,
    operatorIds:  operatorIds.length  ? operatorIds  : undefined,
    shortcodeIds: shortcodeIds.length ? shortcodeIds : undefined,
    ownerUserId:  canSeeAll && Number.isFinite(ownerUserId) ? ownerUserId : undefined,
  };

  await audit({
    actor: session.email, action: "summary.export",
    target: "csv", outcome: "success",
    ip: clientIp(req.headers),
    userAgent: req.headers.get("user-agent"),
    detail: { filters, groupBy },
  });

  const stream = streamDailySummaryCsv(filters, session.shortcodeIds, groupBy);
  const filename = `ussd_summary_${fromDate}_to_${toDate}_${groupBy}.csv`;
  return new NextResponse(stream as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type":        "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control":       "private, no-store",
    },
  });
}
