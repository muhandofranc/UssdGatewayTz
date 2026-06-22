"""Forward a unified USSD request to the configured handler URL +
parse the handler's reply into a `UnifiedReply`.

Contract for handlers (internal apps OR external clients):
  * Receive   POST {handler_url}    Content-Type: application/json
              Authorization: Bearer <token>   (only if auth_mode='bearer')
              Body:
                {
                  "operator":      "vodacom",
                  "msisdn":        "255712345678",
                  "session_id":    "ABC123",
                  "service_code":  "*123#",
                  "ussd_string":   "1*2",
                  "raw_payload":   { ... whatever the MNO sent ... }
                }
  * Reply     EITHER as JSON:
                { "action": "CON" | "END", "message": "..." }
              OR as plain text first-line:
                "CON ..."  or  "END ..."
              (matches the MNO USSD convention so existing handlers
               built against AfricasTalking-style gateways drop in).

Failure modes the forwarder distinguishes:
  * timeout         — handler didn't reply within its configured
                      per-shortcode timeout (default 5s; cap to <MNO
                      USSD timeout so we still get our own END out).
  * non-2xx         — handler responded but with 4xx/5xx.
  * unparseable     — 2xx body that isn't JSON {action,message} and
                      doesn't start with CON/END.
  * transport       — DNS / connect / TLS / network error.

In every failure case we return an `END Service unavailable` reply
to the MNO. The exact reason is logged + counted; production
operators see the breakdown via the dashboard reports + Prometheus
counters (Phase 4).
"""
from __future__ import annotations

import json
import logging
import time

import httpx

# How much of the request/response body to surface in logs. Full bodies
# go through at DEBUG (turn on with USSD_LOG_LEVEL=DEBUG); the INFO line
# also includes a truncated copy so postmortems don't need a debug
# rerun. 2000 chars is enough for the longest realistic USSD reply
# (~160 chars body × a few JSON sugar fields) while staying log-safe.
_LOG_BODY_TRUNC = 2000

# Same for the smaller INFO-line truncation — keep one line readable
# even with the body inlined.
_LOG_BODY_INLINE = 500

from .db import ShortcodeRow
from .unified import Action, HandlerOutcome, UnifiedReply, UnifiedRequest

LOGGER = logging.getLogger(__name__)


def _coerce_action(raw) -> Action | None:
    """Accept 'CON' / 'END' (case-insensitive). Anything else None."""
    if not isinstance(raw, str):
        return None
    norm = raw.strip().upper()
    if norm == "CON":
        return Action.CON
    if norm == "END":
        return Action.END
    return None


def _parse_handler_reply(status: int, body_text: str) -> tuple[UnifiedReply | None, str | None]:
    """Returns (reply, error_class). One of them is always None."""
    body_text = body_text or ""
    stripped = body_text.strip()
    if not stripped:
        return None, "empty_body"

    # JSON envelope path
    if stripped[0] in "{[":
        import json
        try:
            j = json.loads(stripped)
        except Exception:
            return None, "badjson"
        if not isinstance(j, dict):
            return None, "badjson_shape"
        act = _coerce_action(j.get("action"))
        msg = j.get("message", "")
        if act is None:
            return None, "bad_action"
        return UnifiedReply(action=act, message=str(msg)), None

    # Plain-text path: first token is CON/END, rest is the message.
    # We accept three concrete shapes seen in the wild:
    #   * "CON Chagua…"       — canonical, space-separated
    #   * "CON\nChagua…"      — newline after the action token
    #   * "CONChagua…"        — no separator at all (some legacy
    #     walkers do `menuType . "" . title` rather than
    #     `menuType . " " . title`; observed on Halotel's SunKing
    #     walker 2026-06-22, was producing bad_action across the board)
    # Falling through any of these returns bad_action.
    upper = stripped.upper()
    for prefix in ("CON", "END"):
        if upper.startswith(prefix):
            # Strip the action prefix; the message is everything after,
            # with leading whitespace (incl. a literal space, newline,
            # or nothing) trimmed.
            msg = stripped[len(prefix):].lstrip()
            return UnifiedReply(action=_coerce_action(prefix),
                                message=msg.rstrip()), None
    return None, "bad_action"


async def forward(
    sc: ShortcodeRow,
    ur: UnifiedRequest,
    *,
    default_timeout_secs: float,
) -> HandlerOutcome:
    """Single round-trip POST to the handler URL. Returns a
    `HandlerOutcome` regardless of success / failure — callers always
    have a structured result to log."""
    timeout = float(sc.timeout_secs or default_timeout_secs)
    headers = {"Content-Type": "application/json"}
    if sc.auth_mode == "bearer" and sc.bearer_token:
        headers["Authorization"] = f"Bearer {sc.bearer_token}"

    payload = {
        "operator":     ur.operator,
        "msisdn":       ur.msisdn,
        "session_id":   ur.session_id,
        "service_code": ur.service_code,
        "ussd_string":  ur.ussd_string,
        # 'start' = first leg (msg was the dialed service code);
        # 'input' = subsequent legs. Terminal events
        # (user_cancelled / timeout / charge_failed) are
        # short-circuited in main.py and never reach forward(),
        # so the handler will only ever see 'start' or 'input'.
        "event":        ur.event.value,
        "raw_payload":  ur.raw_payload,
    }

    # --- outbound log: one INFO line per call + DEBUG full payload ---
    # The INFO line has everything an oncall engineer needs to triage
    # without raising log level: shortcode, URL, session, event,
    # auth mode, and a compact view of what we're posting. Auth header
    # value is NEVER logged.
    payload_json = json.dumps(payload, default=str)
    LOGGER.info(
        "→ handler call shortcode=%s url=%s session=%s event=%s msisdn=%s "
        "ussd=%r auth=%s timeout=%ss payload=%s",
        sc.code, sc.handler_url, ur.session_id, ur.event.value,
        ur.msisdn, ur.ussd_string,
        sc.auth_mode or "none", timeout,
        payload_json[:_LOG_BODY_INLINE],
    )
    LOGGER.debug("  full request payload: %s", payload_json[:_LOG_BODY_TRUNC])

    t0 = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(sc.handler_url, json=payload, headers=headers)
    except httpx.TimeoutException as exc:
        elapsed_ms = int((time.monotonic() - t0) * 1000)
        LOGGER.error(
            "✗ handler TIMEOUT shortcode=%s url=%s session=%s elapsed=%dms "
            "limit=%ss: %s",
            sc.code, sc.handler_url, ur.session_id, elapsed_ms, timeout, exc,
        )
        return HandlerOutcome(
            reply=None, status_code=None, elapsed_ms=elapsed_ms,
            error_class="timeout", error_detail=str(exc)[:300],
        )
    except httpx.RequestError as exc:
        elapsed_ms = int((time.monotonic() - t0) * 1000)
        LOGGER.error(
            "✗ handler TRANSPORT-ERROR shortcode=%s url=%s session=%s "
            "elapsed=%dms class=%s: %s",
            sc.code, sc.handler_url, ur.session_id, elapsed_ms,
            type(exc).__name__, exc,
        )
        return HandlerOutcome(
            reply=None, status_code=None, elapsed_ms=elapsed_ms,
            error_class="transport", error_detail=str(exc)[:300],
        )

    elapsed_ms = int((time.monotonic() - t0) * 1000)
    body_text = resp.text or ""
    # Try to capture the response body in a JSON-friendly form for the
    # log table (even when we couldn't parse it as a UnifiedReply, the
    # raw text is useful for postmortem).
    raw_json: dict | None
    try:
        raw_json = {"text": body_text[:_LOG_BODY_TRUNC]} if body_text else None
    except Exception:
        raw_json = None

    # --- response log: full body at DEBUG always, INFO/ERROR routing
    # based on status. 2xx → INFO. 4xx/5xx → ERROR (was previously
    # silent — only the database log carried the failure, not stdout).
    LOGGER.debug("  full response body: %s", body_text[:_LOG_BODY_TRUNC])

    if resp.status_code >= 400:
        LOGGER.error(
            "✗ handler HTTP %d shortcode=%s url=%s session=%s elapsed=%dms "
            "body=%r",
            resp.status_code, sc.code, sc.handler_url, ur.session_id,
            elapsed_ms, body_text[:_LOG_BODY_INLINE],
        )
        return HandlerOutcome(
            reply=None, status_code=resp.status_code, elapsed_ms=elapsed_ms,
            error_class="non2xx",
            error_detail=f"HTTP {resp.status_code}: {body_text[:300]}",
            raw_response_payload=raw_json,
        )

    reply, err = _parse_handler_reply(resp.status_code, body_text)
    if reply is None:
        LOGGER.error(
            "✗ handler UNPARSEABLE shortcode=%s url=%s session=%s "
            "status=%d elapsed=%dms reason=%s body=%r",
            sc.code, sc.handler_url, ur.session_id, resp.status_code,
            elapsed_ms, err or "unparseable",
            body_text[:_LOG_BODY_INLINE],
        )
        return HandlerOutcome(
            reply=None, status_code=resp.status_code, elapsed_ms=elapsed_ms,
            error_class=err or "unparseable",
            error_detail=f"could not parse handler reply: {body_text[:300]}",
            raw_response_payload=raw_json,
        )

    # Success path — single INFO line so on-call sees every leg without
    # cranking to DEBUG. Action + message length are usually enough;
    # full body remains at DEBUG above.
    LOGGER.info(
        "← handler OK shortcode=%s session=%s status=%d elapsed=%dms "
        "action=%s msg_len=%d msg=%r",
        sc.code, ur.session_id, resp.status_code, elapsed_ms,
        reply.action.value, len(reply.message),
        reply.message[:_LOG_BODY_INLINE],
    )
    return HandlerOutcome(
        reply=reply, status_code=resp.status_code, elapsed_ms=elapsed_ms,
        raw_response_payload=raw_json,
    )
