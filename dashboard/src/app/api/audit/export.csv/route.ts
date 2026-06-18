/**
 * GET /api/audit/export.csv
 *
 * Streams a CSV of audit rows matching the query-string filters.
 * Same filter shape as the /audit page (from, to, actor, action,
 * outcome). Hard-capped at AUDIT_CSV_ROW_CAP rows.
 *
 * Gated on the same perm as /audit (AUDIT_VIEW) — defence-in-depth
 * over the middleware. Each download is itself audited so a
 * super_admin's bulk pulls show up in the same log.
 */
import { NextResponse } from "next/server";
import { getSession, hasPerm } from "@/lib/auth";
import { Perms } from "@/lib/rbac";
import {
  audit, clientIp, streamAuditLogCsv,
  type AuditFilters,
} from "@/lib/audit";

export async function GET(req: Request) {
  const session = await getSession();
  if (!session || !hasPerm(session, Perms.AUDIT_VIEW)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const u = new URL(req.url);
  const f: Omit<AuditFilters, "page" | "pageSize"> = {
    from:         u.searchParams.get("from")   || null,
    to:           u.searchParams.get("to")     || null,
    actor:        u.searchParams.get("actor")  || null,
    actionPrefix: u.searchParams.get("action") || null,
    outcome: ((): AuditFilters["outcome"] => {
      const o = u.searchParams.get("outcome");
      return o === "success" || o === "failure" || o === "denied" ? o : null;
    })(),
  };

  await audit({
    actor: session.email, action: "audit.export",
    target: "csv", outcome: "success",
    ip: clientIp(req.headers),
    userAgent: req.headers.get("user-agent"),
    detail: { filters: f },
  });

  const stream = streamAuditLogCsv(f);
  const filename = `portal_audit_${new Date().toISOString().slice(0, 10)}.csv`;
  return new NextResponse(stream as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type":        "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control":       "private, no-store",
    },
  });
}
