/**
 * GET /api/exports/:id/download
 *
 * Streams the CSV the worker produced. Hard-checks ownership: an
 * export's file is only served to the user who requested it (even
 * super_admin can't grab another user's export by URL).
 */
import { NextResponse } from "next/server";
import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";
import { getSession } from "@/lib/auth";
import { getExportForUser } from "@/lib/exports";

interface Ctx { params: Promise<{ id: string }>; }

export async function GET(_req: Request, ctx: Ctx) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id: idStr } = await ctx.params;
  const id = parseInt(idStr, 10);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "bad id" }, { status: 400 });
  }

  const row = await getExportForUser(id, Number(session.sub));
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (row.status !== "ready" || !row.file_path) {
    return NextResponse.json(
      { error: `export not ready (status=${row.status})` },
      { status: 409 },
    );
  }

  let size: number;
  try { size = statSync(row.file_path).size; }
  catch {
    return NextResponse.json({ error: "file missing on disk" }, { status: 410 });
  }

  // Stream directly off disk so a multi-GB CSV doesn't buffer in
  // the Node process. The readable is adapted to the Web Streams
  // API that NextResponse expects.
  const nodeStream = createReadStream(row.file_path);
  const webStream  = Readable.toWeb(nodeStream) as unknown as ReadableStream;

  const filename = `ussd_export_${row.id}_${row.granularity}.csv`;
  return new NextResponse(webStream, {
    status: 200,
    headers: {
      "Content-Type":        "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length":      String(size),
      "Cache-Control":       "private, no-store",
    },
  });
}
