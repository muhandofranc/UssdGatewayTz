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
  if (!sessionId || !operator) {
    return NextResponse.json({ error: "session_id and operator required" }, { status: 400 });
  }
  const legs = await loadLegsForSession(sessionId, operator, session.shortcodeIds);
  return NextResponse.json({ legs });
}
