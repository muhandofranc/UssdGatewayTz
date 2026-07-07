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
import os
import time
from typing import Optional

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
from .metrics import (
    FORWARDER_HTTP_CONNECTIONS_INUSE,
    FORWARDER_HTTP_CONNECTIONS_KEEPALIVE,
    USSD_HANDLER_ERRORS_TOTAL,
    USSD_HOP_LATENCY_SECONDS,
    USSD_HOP_TOTAL,
)
from .unified import Action, HandlerOutcome, UnifiedReply, UnifiedRequest

LOGGER = logging.getLogger(__name__)


# ------------------------------------------------------------------
# Shared httpx client
# ------------------------------------------------------------------
# The forwarder was previously creating a fresh AsyncClient per hop:
#     async with httpx.AsyncClient(timeout=timeout) as client:
#         await client.post(...)
# That works, but every hop then does its own TCP connect (and TLS
# handshake, when the handler isn't 127.0.0.1). At production peaks
# (hundreds of hops/second) the churn shows up as ~200-300 ms of extra
# latency on every leg, saturates the ephemeral-port pool, and defeats
# HTTP keep-alive against the PHP handlers entirely.
#
# A single module-level client, created at startup, keeps a warm
# connection pool per handler URL and lets keep-alive do its job.
# Timeouts stay per-request (the per-shortcode timeout still wins over
# the client's default).
_CLIENT: Optional[httpx.AsyncClient] = None


def _int_env(name: str, default: int) -> int:
    """Best-effort env lookup for connection-pool sizing knobs."""
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        n = int(raw)
        return n if n > 0 else default
    except ValueError:
        return default


def _float_env(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        v = float(raw)
        return v if v > 0 else default
    except ValueError:
        return default


def init_forwarder() -> None:
    """Create the shared AsyncClient at app startup. Idempotent so
    the FastAPI lifespan hook can call this on reload without leaking
    a client."""
    global _CLIENT
    if _CLIENT is not None:
        return

    # Pool caps — tuned for the "single host, 4 MNOs × N shortcodes"
    # deployment. Env overrides let ops widen these without a rebuild
    # on a bigger box.
    max_conn      = _int_env("USSD_HTTPX_MAX_CONNECTIONS",           200)
    max_keepalive = _int_env("USSD_HTTPX_MAX_KEEPALIVE_CONNECTIONS", 100)
    keepalive_ttl = _float_env("USSD_HTTPX_KEEPALIVE_EXPIRY_SECS",    30.0)

    _CLIENT = httpx.AsyncClient(
        limits=httpx.Limits(
            max_connections=max_conn,
            max_keepalive_connections=max_keepalive,
            keepalive_expiry=keepalive_ttl,
        ),
        # Default timeout is a safety net — the per-shortcode timeout
        # in forward() overrides at call time. Keep it generous here so
        # ops can override upward via env without editing code.
        timeout=httpx.Timeout(connect=3.0, read=15.0, write=5.0, pool=5.0),
        # Explicit HTTP/1.1 — PHP handlers don't speak h2 and enabling
        # it here would force httpx to do ALPN on every new connection
        # for nothing.
        http2=False,
        # No transport retries: we count each attempt in metrics and
        # decide our own retry policy in the caller (which today is
        # "just fail the leg" — that's fine).
        transport=httpx.AsyncHTTPTransport(retries=0),
    )
    LOGGER.info(
        "forwarder httpx client ready max_conn=%d max_keepalive=%d expiry=%.1fs",
        max_conn, max_keepalive, keepalive_ttl,
    )


async def close_forwarder() -> None:
    """Drain and close the shared client at shutdown."""
    global _CLIENT
    if _CLIENT is None:
        return
    try:
        await _CLIENT.aclose()
    except Exception:
        LOGGER.exception("forwarder client close failed")
    finally:
        _CLIENT = None
        LOGGER.info("forwarder httpx client closed")


def sample_pool_gauges() -> None:
    """Poll the shared httpx pool and publish its live state to
    Prometheus gauges. Called from the /metrics endpoint so scrapes
    reflect the current pool without a background poller.

    httpx doesn't expose a public pool-inspection API, so we probe
    the underlying httpcore pool defensively — any AttributeError just
    yields zero (better than crashing the scrape).
    """
    inuse = 0
    keepalive = 0
    try:
        if _CLIENT is not None:
            transport = getattr(_CLIENT, "_transport", None)
            pool = getattr(transport, "_pool", None) if transport is not None else None
            connections = getattr(pool, "_connections", None) if pool is not None else None
            if connections is not None:
                for c in connections:
                    # httpcore's AsyncHTTPConnection exposes _has_expired
                    # and is_idle(); we treat "idle & alive" as keepalive
                    # and "not idle" as in-use.
                    try:
                        is_idle = c.is_idle()
                    except Exception:
                        is_idle = False
                    if is_idle:
                        keepalive += 1
                    else:
                        inuse += 1
    except Exception:
        # SWALLOW: pool internals are unofficial. If they change shape,
        # the scrape returns zero — visible in Grafana but doesn't
        # break the /metrics endpoint.
        LOGGER.debug("httpx pool sampling failed", exc_info=True)
    FORWARDER_HTTP_CONNECTIONS_INUSE.set(inuse)
    FORWARDER_HTTP_CONNECTIONS_KEEPALIVE.set(keepalive)


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
    if _CLIENT is None:
        # Shouldn't happen — lifespan wires init_forwarder() at startup.
        # Fall back to a one-shot client so a mis-wired test doesn't
        # crash, but log loudly so it's noticed.
        LOGGER.warning("forwarder client uninitialised; using one-shot fallback")
        init_forwarder()
    assert _CLIENT is not None  # narrow for type-checkers

    # Metric labels — bounded cardinality by construction (shortcode
    # values are enumerated in the DB, event has three values). We
    # increment the hop counter unconditionally so error paths also
    # register in the arrivals rate.
    _lbl_op = ur.operator or "unknown"
    _lbl_sc = sc.code or "unknown"
    _lbl_ev = ur.event.value
    USSD_HOP_TOTAL.labels(_lbl_op, _lbl_sc, _lbl_ev).inc()

    try:
        resp = await _CLIENT.post(
            sc.handler_url, json=payload, headers=headers,
            timeout=timeout,   # per-shortcode override
        )
    except httpx.TimeoutException as exc:
        elapsed_ms = int((time.monotonic() - t0) * 1000)
        USSD_HOP_LATENCY_SECONDS.labels(_lbl_op, _lbl_sc, _lbl_ev).observe(elapsed_ms / 1000.0)
        USSD_HANDLER_ERRORS_TOTAL.labels(_lbl_op, _lbl_sc, "timeout").inc()
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
        USSD_HOP_LATENCY_SECONDS.labels(_lbl_op, _lbl_sc, _lbl_ev).observe(elapsed_ms / 1000.0)
        USSD_HANDLER_ERRORS_TOTAL.labels(_lbl_op, _lbl_sc, "transport").inc()
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
    USSD_HOP_LATENCY_SECONDS.labels(_lbl_op, _lbl_sc, _lbl_ev).observe(elapsed_ms / 1000.0)
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
        USSD_HANDLER_ERRORS_TOTAL.labels(_lbl_op, _lbl_sc, "non2xx").inc()
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
        USSD_HANDLER_ERRORS_TOTAL.labels(_lbl_op, _lbl_sc, err or "unparseable").inc()
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
