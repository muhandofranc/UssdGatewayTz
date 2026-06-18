"use server";

/**
 * Export server actions. createExport accepts a FormData carrying the
 * current /sessions or /reports search params + a granularity choice,
 * stamps the user's shortcode allowlist into the filters JSON (so the
 * worker enforces per-row access), and inserts a queued row.
 */
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { getSession } from "@/lib/auth";
import { audit, clientIp } from "@/lib/audit";
import { enqueueExport, type Granularity } from "@/lib/exports";

function strField(fd: FormData, k: string): string {
  return (fd.get(k)?.toString() ?? "").trim();
}
function strArrayField(fd: FormData, k: string): string[] {
  return fd.getAll(k).map((v) => v.toString().trim()).filter(Boolean);
}
function intArrayField(fd: FormData, k: string): number[] {
  return strArrayField(fd, k)
    .map((v) => parseInt(v, 10))
    .filter(Number.isFinite);
}

export async function actionCreateExport(fd: FormData) {
  const session = await getSession();
  if (!session) redirect("/login");

  const granularityRaw = strField(fd, "granularity") || "legs";
  const granularity: Granularity = granularityRaw === "sessions" ? "sessions" : "legs";

  const filters: Record<string, unknown> = {
    from:         strField(fd, "from")        || null,
    to:           strField(fd, "to")          || null,
    msisdn:       strField(fd, "msisdn")      || null,
    session_id:   strField(fd, "session_id")  || null,
    error_class:  strField(fd, "error_class") || "any",
    operators:    strArrayField(fd, "operator"),
    shortcodeIds: intArrayField(fd, "shortcode_id"),
    // The crucial per-row guard: lift the user's allowlist from the
    // JWT and stamp it into the export. Worker AND's it into every
    // SELECT so the resulting CSV can never contain shortcodes the
    // requester doesn't own. super_admin gets null = unrestricted.
    allowedShortcodeIds: session.shortcodeIds,
    // Useful audit metadata baked in.
    requested_by_email: session.email,
    requested_by_role:  session.role,
  };

  const id = await enqueueExport({
    userId: Number(session.sub),
    granularity,
    filters,
  });

  const h = await headers();
  await audit({
    actor: session.email, action: "export.create",
    target: String(id), outcome: "success",
    ip: clientIp(h), userAgent: h.get("user-agent"),
    detail: {
      id, granularity,
      from: filters.from, to: filters.to,
      operators: filters.operators,
      shortcode_ids: filters.shortcodeIds,
      msisdn: filters.msisdn ? "redacted" : null,
    },
  });

  revalidatePath("/exports");
  redirect("/exports");
}
