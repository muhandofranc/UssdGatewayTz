/**
 * GET /api/sessions/legs?session_id=...&operator=...
 *
 * Returns the per-leg detail for one session, used by the lazy
 * chevron expand on /sessions. Access control: enforced via the
 * caller's JWT shortcodeIds — the data layer (loadLegsForSession)
 * applies `shortcode_id = ANY(allowlist)` so a client requesting
 * a session_id outside their owned shortcodes just gets [].
 */
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { loadLegsForSession } from "@/lib/reports";

export async function GET(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const sessionId = (url.searchParams.get("session_id") || "").trim();
  const operator  = (url.searchParams.get("operator") || "").trim().toLowerCase();
  // `first_ts` and `last_ts` are OPTIONAL — but supplying them turns
  // a full-partition-scan into a 1-2-partition-scan by unlocking
  // the ts-based partition pruner in Postgres. The frontend always
  // has these values in the parent SessionRow, so callers that
  // omit them are anonymous-testing / curl only.
  const firstTs = (url.searchParams.get("first_ts") || "").trim() || undefined;
  const lastTs  = (url.searchParams.get("last_ts")  || "").trim() || undefined;
  if (!sessionId || !operator) {
    return NextResponse.json({ error: "session_id and operator required" }, { status: 400 });
  }
  const legs = await loadLegsForSession(
    sessionId, operator, session.shortcodeIds, firstTs, lastTs,
  );
  return NextResponse.json({ legs });
}
