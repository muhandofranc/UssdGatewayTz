"""FastAPI entrypoint — one route per MNO, shared pipeline.

Wire (synchronous MNOs — Vodacom / Airtel / Tigo):
  MNO HTTP  → /ussd/<operator>
            → adapter.parse()           (native MNO shape → UnifiedRequest)
            → db.resolve_shortcode()    (operator + service_code → handler URL)
            → forwarder.forward()       (POST handler, parse reply)
            → adapter.render(reply)     (UnifiedReply → native MNO response)
            → db.log_leg()              (best-effort row insert)
            → returned to MNO synchronously

Wire (async-outbound MNOs — Halotel SOAP):
  MNO HTTP  → /ussd/halotel
            → adapter.parse()
            → adapter.render() (ACK envelope, no menu yet)  -- returned immediately
            (in background)
            → resolve_shortcode + forward + adapter.push_outbound()
            → db.log_leg()

Failure paths all return a graceful `END Service unavailable` (or
service-specific message) to the MNO so the customer never sees a
blank screen — and every leg is logged with an `error_class` for
post-hoc triage.
"""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, HTTPException, Request, Response

from . import adapters as _adapters_pkg  # noqa: F401 — registers adapters
from .adapters import REGISTRY
from .adapters._common import end_reply
from .config import load as load_settings
from .db import (
    close_log_writer, close_pool, expire_active_session, init_log_writer,
    init_pool, log_leg, resolve_shortcode, status_message_for,
)
from .forwarder import close_forwarder, forward, init_forwarder, sample_pool_gauges
from .metrics import (
    HTTP_REQUEST_LATENCY_SECONDS, HTTP_REQUESTS_TOTAL,
    normalise_route, render as render_metrics,
)
from .unified import (
    Action, SessionEvent, TERMINAL_EVENTS, UnifiedReply, UnifiedRequest,
)

# Force per-MNO adapter modules to import (and self-register).
# Explicit imports — keeps the dependency graph greppable.
from .adapters import vodacom, airtel, tigo, halotel  # noqa: F401

LOGGER = logging.getLogger("ussd_gateway")
_SETTINGS = load_settings()


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    logging.basicConfig(
        level=_SETTINGS.log_level,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    # Order matters:
    #   1. PG pool up first — the async log writer needs it borrowable.
    #   2. Log-writer thread up — subsequent code paths can enqueue.
    #   3. Shared httpx client up — forwarder needs it warm before
    #      the first request lands.
    init_pool(_SETTINGS.pg)
    init_log_writer()
    init_forwarder()
    LOGGER.info("ussd-gateway-tz started — adapters loaded: %s",
                sorted(REGISTRY.keys()))
    try:
        yield
    finally:
        # Shut down in reverse: stop taking new work, then drain the
        # log writer (its remaining rows), then release the PG pool.
        await close_forwarder()
        close_log_writer()
        close_pool()
        LOGGER.info("ussd-gateway-tz stopped")


app = FastAPI(
    title="UssdGatewayTz",
    description="Unified Tanzania USSD reseller gateway",
    version="0.1.0",
    lifespan=_lifespan,
)


# ---------- Prometheus HTTP request metrics ----------
# Middleware runs on EVERY request (including /metrics and /healthz)
# so scrape budgets and probe latency stay visible in Grafana. Route
# labels are normalised (see metrics.normalise_route) to guarantee
# bounded cardinality — random-path scanners can't create a new time
# series per URL.
@app.middleware("http")
async def _metrics_middleware(request: Request, call_next):
    import time as _time
    start = _time.monotonic()
    try:
        response: Response = await call_next(request)
        status_class = f"{response.status_code // 100}xx"
    except Exception:
        # Server crashed the handler. Still record it so the scrape
        # accounts for the failure, then re-raise to FastAPI's
        # default 500 machinery.
        elapsed = _time.monotonic() - start
        route = normalise_route(request.url.path)
        HTTP_REQUESTS_TOTAL.labels(request.method, route, "5xx").inc()
        HTTP_REQUEST_LATENCY_SECONDS.labels(request.method, route).observe(elapsed)
        raise
    elapsed = _time.monotonic() - start
    route = normalise_route(request.url.path)
    HTTP_REQUESTS_TOTAL.labels(request.method, route, status_class).inc()
    HTTP_REQUEST_LATENCY_SECONDS.labels(request.method, route).observe(elapsed)
    return response


@app.get("/metrics", include_in_schema=False)
async def _metrics() -> Response:
    """Prometheus scrape endpoint.

    Serves counters/histograms/gauges from `app.metrics`. In
    multi-process mode (which is the default under uvicorn --workers > 1),
    aggregates across all worker processes via the shared
    PROMETHEUS_MULTIPROC_DIR — see app/metrics.py for the mechanics.
    """
    # Sample live pool state each scrape so operators see it fresh
    # without needing a background poller.
    try:
        sample_pool_gauges()
    except Exception:
        LOGGER.exception("pool gauge sampling failed (metrics still served)")
    payload, content_type = render_metrics()
    return Response(content=payload, media_type=content_type)


# ---------- OpenAPI spec override ----------
# Our routes use raw Request/Response (not typed Pydantic models) so
# FastAPI's auto-generated /openapi.json is mostly empty. We override
# with the hand-written docs/openapi.yaml that documents the MNO wire
# shapes (XML / SOAP / per-MNO query schemes) properly. Swagger UI at
# /docs and ReDoc at /redoc both read from this overridden spec, so
# the "Try it out" buttons post against the live gateway.
def _load_openapi_spec() -> dict:
    import os, yaml  # local import — only needed when /openapi.json is hit
    # docs/openapi.yaml is copied into the container alongside app/
    # (see Dockerfile). Fall back to repo-root path during host runs.
    here = os.path.dirname(os.path.abspath(__file__))
    for cand in (
        os.path.normpath(os.path.join(here, "..", "docs", "openapi.yaml")),
        "/app/docs/openapi.yaml",
    ):
        if os.path.isfile(cand):
            with open(cand, encoding="utf-8") as f:
                return yaml.safe_load(f)
    # Last-resort: minimal stub so /docs still loads if the file is
    # missing in some deploy.
    return {
        "openapi": "3.1.0",
        "info": {"title": app.title, "version": app.version},
        "paths": {},
    }


_OPENAPI_CACHE: dict | None = None


def _merge_paths(auto: dict, override: dict) -> dict:
    """Deep-merge auto-generated paths with the YAML's. YAML wins per
    operation when it sets a field (detailed wire spec stays
    authoritative); FastAPI's auto-generated summary/description from
    the route docstrings fill the gaps for paths the YAML hasn't
    documented yet."""
    out = dict(auto)
    for path, ops in (override or {}).items():
        if path not in out:
            out[path] = ops
            continue
        merged = dict(out[path])
        for method, spec in ops.items():
            if method in merged and isinstance(merged[method], dict) and isinstance(spec, dict):
                # YAML keys override the auto-generated ones; keys it
                # doesn't set (e.g. inline `summary`) survive.
                merged[method] = {**merged[method], **spec}
            else:
                merged[method] = spec
        out[path] = merged
    return out


def _custom_openapi() -> dict:
    global _OPENAPI_CACHE
    if _OPENAPI_CACHE is None:
        # Build FastAPI's auto-generated spec from the route summaries +
        # docstrings, then layer the static YAML on top. Route-level
        # inline docs (the @app.get(..., summary="...") docstrings) now
        # surface in /docs even when the YAML hasn't been updated yet,
        # which keeps the source of truth next to the code for fast
        # iteration.
        from fastapi.openapi.utils import get_openapi
        auto = get_openapi(
            title=app.title, version=app.version, routes=app.routes,
            description=app.description or "",
        )
        yaml_spec = _load_openapi_spec()
        merged = dict(auto)
        merged["paths"] = _merge_paths(auto.get("paths", {}),
                                       yaml_spec.get("paths", {}))
        # Top-level info / servers / components from the YAML win — they
        # carry the hand-written contact info, security schemes, etc.
        for key in ("info", "servers", "components", "tags"):
            if key in yaml_spec:
                merged[key] = yaml_spec[key]
        _OPENAPI_CACHE = merged
    return _OPENAPI_CACHE


app.openapi = _custom_openapi   # type: ignore[method-assign]


@app.get("/healthz", tags=["health"], summary="Liveness probe")
def healthz() -> dict:
    """**Request:** no body, no params.

    **Response 200:** `{"ok": true}`. Returned as soon as the process is up;
    no DB touch. Use `/readyz` when you need DB-touching readiness."""
    return {"ok": True}


@app.get("/readyz", tags=["health"], summary="Readiness probe")
def readyz() -> dict:
    """**Request:** no body, no params.

    **Response 200:** `{"ok": true}`. TODO (Phase 4): cheap `SELECT 1`
    against the pool so 200 actually implies the DB is reachable."""
    return {"ok": True}


async def _handle_ussd(req: Request, operator_key: str) -> Response:
    """The one pipeline every MNO route runs through."""
    adapter = REGISTRY.get(operator_key)
    if adapter is None:
        # Unknown MNO in the URL — surface a 404 BEFORE we touch
        # anything else; this signals a routing/deployment bug rather
        # than a USSD-flow problem.
        raise HTTPException(404, f"unknown operator: {operator_key}")

    # 1. parse — convert the MNO's native HTTP request into our shape.
    ur = await adapter.parse(req)

    # 2a. inbound-auth failed (Halotel: bad user/pass in SOAP body).
    # The adapter sets `_auth_ok='0'` in raw_payload and implements
    # render_auth_failed(); we surface the MNO-specific reject
    # envelope (e.g. SOAP errorCode=1) without 401-ing the HTTP layer.
    auth_failed = (
        (ur.raw_payload or {}).get("_auth_ok") == "0"
        and hasattr(adapter, "render_auth_failed")
    )
    if auth_failed:
        op_id = _operator_id_or_zero(operator_key)
        log_leg(
            operator_id=op_id, operator_name=operator_key,
            shortcode_id=None, service_code=ur.service_code,
            session_id=ur.session_id, msisdn=ur.msisdn,
            ussd_string=ur.ussd_string,
            direction="inbound",
            raw_request_payload=ur.raw_payload,
            raw_response_payload=None,
            handler_url=None, handler_status_code=None,
            handler_response_action=None, handler_response_text=None,
            handler_elapsed_ms=None,
            error_class="auth_failed",
            error_detail=f"inbound creds rejected for operator={operator_key}",
        )
        return adapter.render_auth_failed()

    # 2b. DELIVERY_ACK (Halotel type=103) — informational only.
    # The session is still alive; we just ack the inbound and log.
    # No handler call, no outbound push, no session-cache mutation.
    if ur.event is SessionEvent.DELIVERY_ACK:
        op_id = _operator_id_or_zero(operator_key)
        resp = adapter.render(UnifiedReply(action=Action.CON, message=""))
        log_leg(
            operator_id=op_id, operator_name=operator_key,
            shortcode_id=None, service_code=ur.service_code,
            session_id=ur.session_id, msisdn=ur.msisdn,
            ussd_string=ur.ussd_string,
            direction="inbound",
            raw_request_payload=ur.raw_payload,
            raw_response_payload=None,
            handler_url=None, handler_status_code=None,
            handler_response_action=None,
            handler_response_text=ur.event.value,
            handler_elapsed_ms=None,
            error_class=None, error_detail=None,
        )
        return resp

    # 2c. terminal events (user cancelled / timeout / charge failed) —
    # short-circuit: no handler call, expire session state, ACK MNO.
    # The MNO has already torn down the session client-side; sending
    # the handler a no-op reply call would just add latency the
    # customer never sees.
    if ur.event in TERMINAL_EVENTS:
        # Best-effort: lift operator_id from session-cache lookup
        # (adapter already did this in parse(); the row we want here
        # is the same one we're about to expire). For now we use the
        # adapter-cached id via the operator name lookup helper below.
        op_id = _operator_id_or_zero(operator_key)
        expire_active_session(ur.session_id, op_id)
        # Acknowledge to the MNO with an END (no message — the user
        # is gone). The MNO accepts an empty <msg></msg>.
        reply = UnifiedReply(action=Action.END, message="")
        resp = adapter.render(reply)
        log_leg(
            operator_id=op_id, operator_name=operator_key,
            shortcode_id=None,
            service_code=ur.service_code,
            session_id=ur.session_id, msisdn=ur.msisdn,
            ussd_string=ur.ussd_string,
            direction="inbound",
            raw_request_payload=ur.raw_payload,
            raw_response_payload=None,
            handler_url=None, handler_status_code=None,
            handler_response_action=reply.action.value,
            handler_response_text=ur.event.value,   # logs which terminal
            handler_elapsed_ms=None,
            error_class=None, error_detail=None,
        )
        return resp

    # 3. resolve — look up the handler URL + auth for (operator, code).
    sc = resolve_shortcode(operator_key, ur.service_code)

    # 3a. maintenance / deactivated short-circuit. Shortcode exists but is
    # flagged off: never call the handler, just render the owner / SA's
    # custom message and log a row with error_class = the status. Works
    # identically on sync and async MNOs because every per-MNO adapter
    # renders UnifiedReply(END, message) to "END <message>" in its native
    # response shape.
    if sc is not None and sc.status != "active":
        canned = UnifiedReply(action=Action.END, message=status_message_for(sc))
        if getattr(adapter, "is_async_outbound", False):
            ack_resp = adapter.render(UnifiedReply(action=Action.CON, message=""))
            asyncio.create_task(_async_canned_push(
                adapter, ur, operator_key, canned,
                error_class=sc.status,
                shortcode_id=sc.id, operator_id=sc.operator_id,
                operator_name=sc.operator_name,
            ))
            return ack_resp
        resp = adapter.render(canned)
        expire_active_session(ur.session_id, sc.operator_id)
        log_leg(
            operator_id=sc.operator_id, operator_name=sc.operator_name,
            shortcode_id=sc.id, service_code=ur.service_code,
            session_id=ur.session_id, msisdn=ur.msisdn,
            ussd_string=ur.ussd_string, direction="response",
            raw_request_payload=ur.raw_payload,
            raw_response_payload={"text": resp.body.decode("utf-8", "replace")},
            handler_url=None, handler_status_code=None,
            handler_response_action=canned.action.value,
            handler_response_text=canned.message,
            handler_elapsed_ms=None,
            error_class=sc.status,
            error_detail=f"shortcode in {sc.status} state",
        )
        return resp

    # 4. branch on adapter capability:
    #    sync MNOs  — render handler reply on the inbound HTTP response.
    #    async MNOs — ack inbound NOW, run handler + push outbound
    #                 in background.
    if getattr(adapter, "is_async_outbound", False):
        # Inbound ACK envelope (e.g. Halotel SOAP errorCode=0).
        ack_resp = adapter.render(UnifiedReply(action=Action.CON, message=""))

        if sc is None:
            # No shortcode configured for this dialed code. We can't
            # forward; push a "service not configured" END outbound
            # so the customer sees a clean termination instead of a
            # timeout-blank-screen.
            canned = UnifiedReply(
                action=Action.END,
                message="Service not configured. Please try later.",
            )
            asyncio.create_task(_async_canned_push(
                adapter, ur, operator_key, canned,
                error_class="shortcode_not_found",
            ))
        else:
            asyncio.create_task(_async_forward_then_push(adapter, ur, sc))
        return ack_resp

    # ----- synchronous-MNO path (existing) -----
    if sc is None:
        reply = UnifiedReply(
            action=Action.END,
            message="Service not configured. Please try later.",
        )
        resp = adapter.render(reply)
        # Also expire any session-cache row so we don't get a stuck
        # session pointing at a no-longer-configured shortcode.
        expire_active_session(ur.session_id, _operator_id_or_zero(operator_key))
        eff_code = _log_service_code(ur)
        log_leg(
            operator_id=_operator_id_or_zero(operator_key),
            operator_name=operator_key,
            shortcode_id=None,
            service_code=eff_code,
            session_id=ur.session_id,
            msisdn=ur.msisdn,
            ussd_string=ur.ussd_string,
            direction="response",
            raw_request_payload=ur.raw_payload,
            raw_response_payload={"text": resp.body.decode("utf-8", "replace")},
            handler_url=None,
            handler_status_code=None,
            handler_response_action=reply.action.value,
            handler_response_text=reply.message,
            handler_elapsed_ms=None,
            error_class="shortcode_not_found",
            error_detail=f"no active shortcode for operator={operator_key} code={eff_code}",
        )
        return resp

    # 5. forward — call the configured handler with unified JSON.
    outcome = await forward(
        sc, ur, default_timeout_secs=_SETTINGS.handler_default_timeout_secs,
    )

    # 6. render — translate the handler's reply back to MNO-native.
    reply = outcome.reply or UnifiedReply(
        action=Action.END,
        message="Service unavailable. Please try later.",
    )
    resp = adapter.render(reply)

    # 7. session-state — if the handler said END, the session is over;
    # expire the cache row so a stray re-delivery doesn't reuse it.
    if reply.action == Action.END:
        expire_active_session(ur.session_id, sc.operator_id)

    # 8. log — best-effort, doesn't block the MNO response.
    log_leg(
        operator_id=sc.operator_id,
        operator_name=sc.operator_name,
        shortcode_id=sc.id,
        service_code=ur.service_code,
        session_id=ur.session_id,
        msisdn=ur.msisdn,
        ussd_string=ur.ussd_string,
        direction="response",
        raw_request_payload=ur.raw_payload,
        raw_response_payload=outcome.raw_response_payload,
        handler_url=sc.handler_url,
        handler_status_code=outcome.status_code,
        handler_response_action=reply.action.value,
        handler_response_text=reply.message,
        handler_elapsed_ms=outcome.elapsed_ms,
        error_class=outcome.error_class,
        error_detail=outcome.error_detail,
    )
    return resp


# ---------- async-outbound helpers (Halotel) -----------------------

async def _async_forward_then_push(adapter, ur: UnifiedRequest, sc) -> None:
    """Background coroutine: forward to handler, push reply outbound,
    expire on END, log. Exceptions are caught and logged — a failure
    here cannot reach the inbound HTTP response (already returned).
    """
    try:
        outcome = await forward(
            sc, ur,
            default_timeout_secs=_SETTINGS.handler_default_timeout_secs,
        )
    except Exception:
        LOGGER.exception(
            "async forward() raised op=%s session=%s",
            adapter.operator, ur.session_id,
        )
        return

    reply = outcome.reply or UnifiedReply(
        action=Action.END,
        message="Service unavailable. Please try later.",
    )
    try:
        push_result = await adapter.push_outbound(ur, reply)
    except Exception:
        LOGGER.exception(
            "async push_outbound() raised op=%s session=%s",
            adapter.operator, ur.session_id,
        )
        push_result = {"error": "push_exception"}

    if reply.action == Action.END:
        try:
            expire_active_session(ur.session_id, sc.operator_id)
        except Exception:
            LOGGER.exception("expire_active_session failed")

    log_leg(
        operator_id=sc.operator_id, operator_name=sc.operator_name,
        shortcode_id=sc.id, service_code=ur.service_code,
        session_id=ur.session_id, msisdn=ur.msisdn,
        ussd_string=ur.ussd_string,
        direction="async_outbound",
        raw_request_payload=ur.raw_payload,
        raw_response_payload=push_result,
        handler_url=sc.handler_url,
        handler_status_code=outcome.status_code,
        handler_response_action=reply.action.value,
        handler_response_text=reply.message,
        handler_elapsed_ms=outcome.elapsed_ms,
        error_class=outcome.error_class or (push_result or {}).get("error"),
        error_detail=outcome.error_detail or (push_result or {}).get("detail"),
    )


async def _async_canned_push(
    adapter, ur: UnifiedRequest, operator_key: str,
    reply: UnifiedReply, *, error_class: str,
    shortcode_id: Optional[int] = None,
    operator_id: Optional[int] = None,
    operator_name: Optional[str] = None,
) -> None:
    """Background coroutine for non-handler outbound (shortcode not
    found, in maintenance, service down, etc.). Pushes a canned reply,
    expires the session, logs.

    The optional shortcode_id / operator_id / operator_name args let
    the maintenance branch attach the log row to the actual shortcode
    instead of NULL (the "not configured" path leaves them blank)."""
    op_id = operator_id if operator_id is not None else _operator_id_or_zero(operator_key)
    op_name = operator_name or operator_key
    try:
        push_result = await adapter.push_outbound(ur, reply)
    except Exception:
        LOGGER.exception(
            "canned push_outbound() raised op=%s session=%s",
            adapter.operator, ur.session_id,
        )
        push_result = {"error": "push_exception"}

    try:
        expire_active_session(ur.session_id, op_id)
    except Exception:
        LOGGER.exception("expire_active_session failed")

    # When the canned-push path is the shortcode_not_found branch
    # (no shortcode_id supplied), prefer the customer's dialed code
    # over the URL slug fallback so the log row carries something
    # actionable for triage. For maintenance/deactivated paths the
    # shortcode_id is set and ur.service_code is the matched code, so
    # _log_service_code returns the same value either way.
    eff_code = _log_service_code(ur) if shortcode_id is None else ur.service_code
    log_leg(
        operator_id=op_id, operator_name=op_name,
        shortcode_id=shortcode_id, service_code=eff_code,
        session_id=ur.session_id, msisdn=ur.msisdn,
        ussd_string=ur.ussd_string,
        direction="async_outbound",
        raw_request_payload=ur.raw_payload,
        raw_response_payload=push_result,
        handler_url=None, handler_status_code=None,
        handler_response_action=reply.action.value,
        handler_response_text=reply.message,
        handler_elapsed_ms=None,
        error_class=error_class,
        error_detail=(push_result or {}).get("detail"),
    )


# In-process cache of operators.name -> operators.id. The operators
# table has 4 rows and never changes at runtime, so we fetch once at
# first miss and reuse forever (process-local). NOT loaded at startup
# because the DB pool may not be ready yet during module import; the
# first request through any route warms it.
_OPERATOR_ID_CACHE: dict[str, int] = {}


def _log_service_code(ur: UnifiedRequest) -> str:
    """Value to log in ussd_session_logs.service_code.

    Derives the canonical TZ short code (`*<digits>*<digits>#`) from
    the customer's dialed string when present in raw_payload — gives
    a single consistent column value across:

      * partner-slug adapters (Airtel / Tigo) where ur.service_code
        is the URL slug ('airtel', 'airfun', …) on the unmatched
        path — slug isn't actionable for triage
      * canonical-form adapters (Vodacom / Halotel) where
        ur.service_code is the FULL dialed string (e.g.
        '*148*69*255689492319#') — too long to skim in the column
      * successful routes where ur.service_code already IS the
        canonical short code — derivation returns the same value

    Falls back to ur.service_code when raw_payload has no
    'dialed_code' field (e.g. the auth_failed / terminal-event log
    sites which don't go through a dial-code parse).
    """
    from .adapters._common import canonical_shortcode
    dialed = (ur.raw_payload or {}).get("dialed_code")
    if dialed:
        derived = canonical_shortcode(dialed)
        if derived:
            return derived
    return ur.service_code


def _operator_id_or_zero(name: str) -> int:
    """Resolve operators.id by name. Cached in-process; first miss
    queries Postgres. Returns 0 only if the operator name truly
    isn't in the DB (which means a config bug — the seed migration
    populates all four)."""
    hit = _OPERATOR_ID_CACHE.get(name)
    if hit:
        return hit
    from .db import _conn  # local import; avoids touching the DB at module load
    with _conn() as c, c.cursor() as cur:
        cur.execute("SELECT id FROM operators WHERE name = %s", (name,))
        row = cur.fetchone()
        if row:
            _OPERATOR_ID_CACHE[name] = int(row[0])
            return _OPERATOR_ID_CACHE[name]
    return 0


# ---------- per-MNO routes ------------------------------------------
# Each MNO gets its own route at /ussd/<operator>. GET + POST both
# bound — the adapter's parse() handles either. (Some MNOs only use
# one method per their spec; the gateway accepting both is harmless
# and saves a config change if an MNO ever flips methods.)

@app.get("/ussd/vodacom",  tags=["MNO ingress"], summary="Vodacom (TruRoute) USSD ingress")
@app.post("/ussd/vodacom", tags=["MNO ingress"], summary="Vodacom (TruRoute) USSD ingress")
async def ussd_vodacom(req: Request) -> Response:
    """**Request** — TruRoute XML POST (`text/xml` / `application/xml`)
    *or* a query/form GET when the aggregator is in its legacy mode.
    Fields: `msisdn`, `ussd`, `optype` (`1`=START, `2`=INPUT, `3`=RELEASE),
    `sessionid`, `network`.

    **Response** — TruRoute `<response>` XML with `<type>` (`2`=CON,
    `3`=END), `<msg>` (body), `<sessionid>`. `Content-Type: text/xml`."""
    return await _handle_ussd(req, "vodacom")


@app.get("/ussd/airtel",  tags=["MNO ingress"], summary="Airtel USSD ingress")
@app.post("/ussd/airtel", tags=["MNO ingress"], summary="Airtel USSD ingress")
async def ussd_airtel(req: Request) -> Response:
    """**Request** — query GET or `application/x-www-form-urlencoded` POST.
    Fields: `sessionId`, `msisdn`, `input` (the digits the subscriber
    just typed; empty on START), `mode`/`event_type` (`START`/`CONTINUE`/
    `RELEASE`), `serviceCode`.

    **Response** — plain-text `CON <body>` (keep session open) or
    `END <body>` (terminate). `Content-Type: text/plain`."""
    return await _handle_ussd(req, "airtel")


@app.get("/ussd/tigo",  tags=["MNO ingress"], summary="Tigo USSD ingress (generic, non-WASP)")
@app.post("/ussd/tigo", tags=["MNO ingress"], summary="Tigo USSD ingress (generic, non-WASP)")
async def ussd_tigo(req: Request) -> Response:
    """**Request** — query/form. Aggregator schemes vary; case-folded
    keys are normalised. Required: `msisdn`, `sessionid` (or
    `session_id`). Useful: `ussdString` (accumulated trail),
    `dialedNumber` (shortcode), `network`.

    **Response** — plain-text `CON <body>` / `END <body>`,
    `Content-Type: text/plain`. Per-WASP partners use the `/ussd/<slug>tigo`
    routes below."""
    return await _handle_ussd(req, "tigo")


@app.get("/ussd/halotel",  tags=["MNO ingress"], summary="Halotel SOAP USSD ingress")
@app.post("/ussd/halotel", tags=["MNO ingress"], summary="Halotel SOAP USSD ingress")
async def ussd_halotel(req: Request) -> Response:
    """**Request** — SOAP 1.1 envelope (`text/xml; charset=utf-8`).
    Inbound op carries the leg type + body. Credentials in the
    `<user>`/`<pass>` SOAP elements are captured per-shortcode and
    echoed on the outbound POST rather than validated against a
    fixed env var (per-shortcode credential mode — see
    `adapters/halotel.py`). Authentication is enforced upstream by
    IP whitelist on Halotel's USSDGW source.

    **Response** — SOAP envelope acking the inbound (`errorCode=0`).
    The menu body is delivered to Halotel asynchronously via
    `HALOTEL_OUTBOUND_URL`."""
    return await _handle_ussd(req, "halotel")


# ---------- partner-slug wildcard (multi-WASP MNOs) ----------------
# Some MNOs (currently Tigo) push per-WASP — each partner has its own
# URL path. The aggregator routes by URL, we preserve that decision.
# Tigo's live URLs:  /ussd/glptigo/, /ussd/zolatigo/,
# /ussd/kopagastigo/, /ussd/tz411tigo/
#
# Routes are registered LAST so the explicit /ussd/vodacom etc.
# above win first. Both trailing-slash and no-slash forms are
# accepted because Tigo's aggregator uses the trailing-slash form
# while curl tests + future WASPs may drop it; pairing both avoids
# a 307 round-trip on the USSD hot path.

async def _dispatch_partner_slug(req: Request, partner_slug: str) -> Response:
    slug = (partner_slug or "").lower()
    if slug.endswith("tigo"):
        return await _handle_ussd(req, "tigo")
    if slug.endswith("air"):
        # 3-char suffix — short enough that an unrelated future slug
        # ending in "air" (e.g. "pair", "stair") would misroute.
        # Switch to an explicit allowlist if that becomes real.
        return await _handle_ussd(req, "airtel")
    # When Halotel grows per-WASP URLs, add a suffix branch here.
    raise HTTPException(404, f"unknown partner slug: {partner_slug}")


@app.get("/ussd/{partner_slug}/",  tags=["MNO ingress"],
         summary="Per-WASP slug ingress (trailing slash)")
@app.post("/ussd/{partner_slug}/", tags=["MNO ingress"],
          summary="Per-WASP slug ingress (trailing slash)")
async def ussd_partner_slug_slash(partner_slug: str, req: Request) -> Response:
    """**Request & response** — identical to the matched MNO's route.
    Slugs ending in `tigo` (e.g. `glptigo`, `zolatigo`, `kopagastigo`,
    `tz411tigo`) dispatch to the Tigo pipeline; slugs ending in `air`
    dispatch to Airtel. Unknown suffix → `404 unknown partner slug`."""
    return await _dispatch_partner_slug(req, partner_slug)


@app.get("/ussd/{partner_slug}",  tags=["MNO ingress"],
         summary="Per-WASP slug ingress (no trailing slash)")
@app.post("/ussd/{partner_slug}", tags=["MNO ingress"],
          summary="Per-WASP slug ingress (no trailing slash)")
async def ussd_partner_slug_noslash(partner_slug: str, req: Request) -> Response:
    """**Request & response** — same as the trailing-slash form above.
    Both are bound so curl-style tests + future WASPs that drop the
    slash skip the 307 redirect on the USSD hot path."""
    return await _dispatch_partner_slug(req, partner_slug)
