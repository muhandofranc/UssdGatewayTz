/**
 * Handler simulator — server-side.
 *
 * Lets a logged-in client fire a simulated USSD leg at their OWN
 * shortcode's configured handler URL and see the reply, exactly the
 * way the gateway would. This mirrors the gateway forwarder's contract
 * (`app/forwarder.py`):
 *
 *   Request  (JSON we POST to handler_url):
 *     { operator, msisdn, session_id, service_code, ussd_string,
 *       event: "start" | "input", raw_payload }
 *   Reply    (handler → us), either:
 *     JSON  { "action": "CON" | "END", "message": "..." }   (case-insensitive)
 *     text  "CON ..." / "END ..." (with or without a separator)
 *   Anything else → the gateway treats it as `bad_action` and returns
 *   an END "Service unavailable"; we surface the same verdict here.
 *
 * The reply contract is MNO-agnostic — the handler sees the same JSON
 * whether the leg came from Vodacom (sync XML), Airtel/Tigo (plain
 * text) or Halotel (async SOAP), so one simulator covers every operator.
 *
 * Security:
 *   * We NEVER accept a handler URL / token from the browser. The
 *     shortcode id is looked up server-side and scoped to the caller's
 *     allowlist (`allowedShortcodeIds`; null = super_admin = all), so a
 *     client can only ever hit a handler they own.
 *   * `bearer_token` stays server-side — it is attached to the outbound
 *     request here and never returned to the client.
 *
 * Only ever imported by server components / server actions (page.tsx,
 * actions.ts); the client component imports TYPES from here with
 * `import type`, which the bundler elides.
 */
import { query } from "./db";

// Row shape for a shortcode the caller is allowed to simulate against.
export interface SimShortcode {
  id: number;
  operator_name: string;
  code: string;
  label: string | null;
  environment: string;      // 'sandbox' | 'production'
  handler_url: string;
  auth_mode: string;        // 'none' | 'bearer'
  status: string;           // 'active' | 'maintenance' | 'deactivated'
  timeout_secs: number;
  has_token: boolean;       // whether a bearer token is configured (never the token itself)
}

export type SimEvent = "start" | "input";

export interface SimLegInput {
  shortcodeId: number;
  msisdn: string;
  sessionId: string;
  event: SimEvent;
  ussdString: string;       // accumulated trail ("" on start)
}

export interface SimLegResult {
  ok: boolean;                       // true when the handler returned a well-formed CON/END
  action: "CON" | "END" | null;
  message: string | null;
  verdict: "con" | "end" | "bad_action" | "non2xx" | "timeout" | "transport" | "not_allowed" | "not_found";
  detail?: string;
  httpStatus?: number;
  elapsedMs: number;
  // Echoed so the UI can show exactly what was sent + received.
  requestBody: Record<string, unknown>;
  rawReply?: string;
}

/** Shortcodes the caller may simulate. `allowedIds=null` = all (super_admin). */
export async function loadSimulatableShortcodes(
  allowedIds: number[] | null,
): Promise<SimShortcode[]> {
  if (allowedIds !== null && allowedIds.length === 0) return [];
  const where = allowedIds === null ? "" : "WHERE s.id = ANY($1::int[])";
  const params = allowedIds === null ? [] : [allowedIds];
  const r = await query<SimShortcode>(
    `SELECT s.id, o.name AS operator_name, s.code, s.label, s.environment,
            s.handler_url, s.auth_mode, s.status, s.timeout_secs,
            (s.bearer_token IS NOT NULL AND s.bearer_token <> '') AS has_token
       FROM shortcodes s
       JOIN operators o ON o.id = s.operator_id
       ${where}
      ORDER BY o.name, s.code`,
    params,
  );
  return r.rows;
}

/** Case-insensitive CON/END coercion — matches forwarder._coerce_action. */
function coerceAction(raw: unknown): "CON" | "END" | null {
  if (typeof raw !== "string") return null;
  const n = raw.trim().toUpperCase();
  return n === "CON" ? "CON" : n === "END" ? "END" : null;
}

/**
 * Parse a handler reply exactly like the gateway forwarder does:
 * JSON {action,message} first, then plain-text CON/END prefix (with or
 * without a separator). Returns action+message or null on bad_action.
 */
function parseHandlerReply(bodyText: string): { action: "CON" | "END"; message: string } | null {
  const trimmed = (bodyText ?? "").trim();
  if (!trimmed) return null;

  // JSON path.
  if (trimmed.startsWith("{")) {
    try {
      const j = JSON.parse(trimmed);
      const act = coerceAction(j.action);
      if (act) return { action: act, message: String(j.message ?? "") };
    } catch { /* fall through to plain-text */ }
  }

  // Plain-text path: first token is CON/END, rest is the message.
  const upper = trimmed.toUpperCase();
  for (const prefix of ["CON", "END"] as const) {
    if (upper.startsWith(prefix)) {
      let msg = trimmed.slice(prefix.length);
      if (msg.startsWith(" ") || msg.startsWith("\n") || msg.startsWith("\r")) {
        msg = msg.replace(/^[\s]+/, "");
      }
      return { action: prefix, message: msg.replace(/\s+$/, "") };
    }
  }
  return null;
}

/**
 * Run one simulated USSD leg against the shortcode's handler. Verifies
 * ownership, loads the handler URL + (server-only) bearer token, POSTs
 * the unified request, and parses the reply.
 */
export async function runSimulatedLeg(
  input: SimLegInput,
  allowedIds: number[] | null,
): Promise<SimLegResult> {
  const { shortcodeId, msisdn, sessionId, event, ussdString } = input;

  // Ownership scope: reject a shortcode outside the caller's allowlist
  // BEFORE touching the handler URL / token.
  if (allowedIds !== null && !allowedIds.includes(shortcodeId)) {
    return blankResult(event, "not_allowed", "You can only simulate handlers for your own shortcodes.");
  }

  const r = await query<{
    code: string; operator_name: string; handler_url: string;
    auth_mode: string; bearer_token: string | null; timeout_secs: number;
  }>(
    `SELECT s.code, o.name AS operator_name, s.handler_url, s.auth_mode,
            s.bearer_token, s.timeout_secs
       FROM shortcodes s JOIN operators o ON o.id = s.operator_id
      WHERE s.id = $1`,
    [shortcodeId],
  );
  const sc = r.rows[0];
  if (!sc) return blankResult(event, "not_found", "Shortcode not found.");

  const requestBody: Record<string, unknown> = {
    operator:     sc.operator_name,
    msisdn,
    session_id:   sessionId,
    service_code: sc.code,
    ussd_string:  ussdString,
    event,
    raw_payload:  { simulated: true, source: "portal-simulator" },
  };

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (sc.auth_mode === "bearer" && sc.bearer_token) {
    headers["Authorization"] = `Bearer ${sc.bearer_token}`;
  }

  const timeoutMs = Math.max(1, Math.min(sc.timeout_secs || 5, 15)) * 1000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = Date.now();
  let resp: Response;
  try {
    resp = await fetch(sc.handler_url, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      signal: ctrl.signal,
      cache: "no-store",
    });
  } catch (e) {
    const elapsedMs = Date.now() - started;
    const aborted = e instanceof Error && e.name === "AbortError";
    return {
      ok: false, action: null, message: null,
      verdict: aborted ? "timeout" : "transport",
      detail: aborted ? `No reply within ${timeoutMs / 1000}s` : String((e as Error)?.message ?? e).slice(0, 300),
      elapsedMs, requestBody,
    };
  } finally {
    clearTimeout(timer);
  }

  const elapsedMs = Date.now() - started;
  const rawReply = (await resp.text().catch(() => "")).slice(0, 4000);

  if (resp.status >= 400) {
    return { ok: false, action: null, message: null, verdict: "non2xx",
             detail: `Handler returned HTTP ${resp.status}`, httpStatus: resp.status,
             elapsedMs, requestBody, rawReply };
  }

  const parsed = parseHandlerReply(rawReply);
  if (!parsed) {
    return { ok: false, action: null, message: null, verdict: "bad_action",
             detail: "Reply was not valid CON/END JSON or plain text.",
             httpStatus: resp.status, elapsedMs, requestBody, rawReply };
  }

  return {
    ok: true,
    action: parsed.action,
    message: parsed.message,
    verdict: parsed.action === "CON" ? "con" : "end",
    httpStatus: resp.status,
    elapsedMs, requestBody, rawReply,
  };
}

function blankResult(_event: SimEvent, verdict: SimLegResult["verdict"], detail: string): SimLegResult {
  return { ok: false, action: null, message: null, verdict, detail, elapsedMs: 0, requestBody: {} };
}
