"use server";

/**
 * Handler-simulator server action. Fires ONE simulated USSD leg at the
 * caller's own shortcode handler and returns the parsed verdict. All
 * scoping + secret handling lives in `@/lib/simulator` (the browser
 * never sees the handler's bearer token or another owner's shortcode).
 */
import { headers } from "next/headers";
import { getSession } from "@/lib/auth";
import { audit, clientIp } from "@/lib/audit";
import {
  runSimulatedLeg, type SimEvent, type SimLegResult,
} from "@/lib/simulator";
// One simulated USSD leg → the caller's own handler URL.

export async function actionSimulateLeg(raw: {
  shortcodeId: number;
  msisdn: string;
  sessionId: string;
  event: SimEvent;
  ussdString: string;
}): Promise<SimLegResult> {
  const session = await getSession();
  if (!session) {
    return {
      ok: false, action: null, message: null, verdict: "not_allowed",
      detail: "Your session expired — sign in again.", elapsedMs: 0, requestBody: {},
    };
  }

  const shortcodeId = Number(raw.shortcodeId);
  const msisdn      = (raw.msisdn ?? "").toString().trim();
  const sessionId   = (raw.sessionId ?? "").toString().trim().slice(0, 128);
  const event: SimEvent = raw.event === "input" ? "input" : "start";
  const ussdString  = (raw.ussdString ?? "").toString().slice(0, 512);

  if (!Number.isFinite(shortcodeId)) {
    return {
      ok: false, action: null, message: null, verdict: "not_found",
      detail: "Pick a shortcode first.", elapsedMs: 0, requestBody: {},
    };
  }

  const result = await runSimulatedLeg(
    { shortcodeId, msisdn, sessionId, event, ussdString },
    session.shortcodeIds,          // null = super_admin = all; else the owner allowlist
  );

  // Audit the attempt (not the reply body — that can be large / PII).
  const h = await headers();
  await audit({
    actor:  session.email,
    action: "simulator.run",
    target: String(shortcodeId),
    outcome: result.ok ? "success" : "failure",
    ip: clientIp(h),
    detail: {
      event, session_id: sessionId, verdict: result.verdict,
      http_status: result.httpStatus ?? null, elapsed_ms: result.elapsedMs,
    },
  });

  return result;
}
