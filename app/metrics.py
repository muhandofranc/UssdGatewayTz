"""Prometheus metrics for the USSD gateway.

Endpoint: `GET /metrics` (unauthenticated, mounted in app/main.py).

Design notes
------------
* We run uvicorn with 4 worker processes; each has its own memory
  space. `prometheus_client` handles this via `multiprocess` mode:
  every worker writes counter/histogram increments to a shared
  directory (`PROMETHEUS_MULTIPROC_DIR`), and the /metrics endpoint
  aggregates them across processes.

* `PROMETHEUS_MULTIPROC_DIR` must be set BEFORE `prometheus_client` is
  imported. That happens in `entrypoint.sh` — see the top of that
  file. When the env var is absent (running under `pytest`, say),
  we transparently fall back to single-process mode.

* Metric label cardinality is bounded to what Prometheus can cope
  with. Specifically, we deliberately do NOT put `msisdn` or
  `session_id` on any label — each unique value would create a new
  time series and blow up Prometheus's memory.

The metric taxonomy below intentionally uses the vendor-standard
naming conventions (see the Prometheus "Metric naming" style guide):
  * `_total` suffix for counters
  * `_seconds` for time-based histograms
  * Units always in the base SI unit (seconds, bytes)
"""
from __future__ import annotations

import os
from typing import Iterable, Optional

from prometheus_client import (
    CONTENT_TYPE_LATEST,
    CollectorRegistry,
    Counter,
    Gauge,
    Histogram,
    generate_latest,
    multiprocess,
)
from prometheus_client.core import REGISTRY as _DEFAULT_REGISTRY


# ------------------------------------------------------------------
# Multi-worker readiness
# ------------------------------------------------------------------
_MULTIPROC_ENABLED: bool = bool(os.environ.get("PROMETHEUS_MULTIPROC_DIR"))


def multiprocess_dir() -> Optional[str]:
    """Return the directory prometheus-client uses to share counters
    between uvicorn workers, or None when we're running single-process
    (tests, local dev, `python -m app.main`)."""
    return os.environ.get("PROMETHEUS_MULTIPROC_DIR") or None


# ------------------------------------------------------------------
# Metrics
# ------------------------------------------------------------------
#
# Counters and histograms below are declared against the default
# `REGISTRY` object. In multi-process mode, prometheus-client stores
# their values in shared memory-mapped files (one file per worker per
# metric); the /metrics handler then walks that directory and sums
# them into a fresh CollectorRegistry (see `render()` below).

# ---- USSD hop counters + latency histogram -----------------------

USSD_HOP_TOTAL = Counter(
    "ussd_hop_total",
    "Number of USSD hops processed by the gateway, by MNO / shortcode / event.",
    labelnames=("operator", "shortcode", "event"),
)

# Bucketed latency of the handler-call round-trip (the same value that
# lands in `ussd_session_logs.handler_elapsed_ms`). Buckets cover the
# realistic USSD budget: sub-100 ms up to the 5 s per-shortcode cap.
USSD_HOP_LATENCY_SECONDS = Histogram(
    "ussd_hop_latency_seconds",
    "Latency of the handler round-trip in seconds.",
    labelnames=("operator", "shortcode", "event"),
    buckets=(0.05, 0.10, 0.25, 0.50, 0.75, 1.0, 1.5, 2.0, 3.0, 5.0, 10.0),
)

# ---- Error classes reported by the forwarder ---------------------

USSD_HANDLER_ERRORS_TOTAL = Counter(
    "ussd_handler_errors_total",
    "Handler-call failures, by MNO / shortcode / error class "
    "(timeout, transport, non2xx, unparseable, bad_action, badjson, ...).",
    labelnames=("operator", "shortcode", "error_class"),
)

# ---- Session-log writer health -----------------------------------

SESSION_LOG_QUEUE_DEPTH = Gauge(
    "ussd_session_log_queue_depth",
    "Rows currently sitting in the async ussd_session_logs writer queue.",
    multiprocess_mode="livemax",
)
SESSION_LOG_ROWS_ENQUEUED_TOTAL = Counter(
    "ussd_session_log_rows_enqueued_total",
    "Rows accepted onto the async writer queue.",
)
SESSION_LOG_ROWS_DROPPED_TOTAL = Counter(
    "ussd_session_log_rows_dropped_total",
    "Rows dropped because the writer queue was full (Postgres wedged / slow).",
)
SESSION_LOG_BATCHES_FLUSHED_TOTAL = Counter(
    "ussd_session_log_batches_flushed_total",
    "Batches successfully committed to Postgres by the async writer.",
)
SESSION_LOG_BATCH_FLUSH_FAILURES_TOTAL = Counter(
    "ussd_session_log_batch_flush_failures_total",
    "Batches that failed to commit (rows are lost — the write is best-effort).",
)
SESSION_LOG_BATCH_SIZE = Histogram(
    "ussd_session_log_batch_size_rows",
    "Number of rows per flushed batch (helps tune batch/latency knobs).",
    buckets=(1, 5, 10, 25, 50, 100, 250, 500, 1000),
)

# ---- Forwarder HTTP client pool ----------------------------------

# `livesum` across worker processes so each worker contributes its
# view of "connections in use" and the /metrics scrape shows the
# aggregate for the container.
FORWARDER_HTTP_CONNECTIONS_INUSE = Gauge(
    "ussd_forwarder_http_connections_inuse",
    "Currently-in-use httpx connections (across the shared client pool).",
    multiprocess_mode="livesum",
)
FORWARDER_HTTP_CONNECTIONS_KEEPALIVE = Gauge(
    "ussd_forwarder_http_connections_keepalive",
    "Currently-idle keep-alive httpx connections.",
    multiprocess_mode="livesum",
)

# ---- Generic HTTP request counter (middleware) -------------------

HTTP_REQUESTS_TOTAL = Counter(
    "ussd_http_requests_total",
    "Total HTTP requests served by the gateway, by method / route / status class.",
    labelnames=("method", "route", "status"),
)
HTTP_REQUEST_LATENCY_SECONDS = Histogram(
    "ussd_http_request_latency_seconds",
    "Total server-side latency of HTTP requests, including handler forwards.",
    labelnames=("method", "route"),
    buckets=(0.05, 0.10, 0.25, 0.50, 0.75, 1.0, 1.5, 2.0, 3.0, 5.0, 10.0),
)


# ------------------------------------------------------------------
# Rendering
# ------------------------------------------------------------------

def render() -> tuple[bytes, str]:
    """Produce the response body for GET /metrics.

    Returns `(payload, content_type)`. In multi-process mode this
    walks `PROMETHEUS_MULTIPROC_DIR` and merges per-worker counter
    files into one output; single-process just returns the default
    registry's live values.
    """
    if _MULTIPROC_ENABLED:
        registry = CollectorRegistry()
        multiprocess.MultiProcessCollector(registry)
        return generate_latest(registry), CONTENT_TYPE_LATEST
    return generate_latest(_DEFAULT_REGISTRY), CONTENT_TYPE_LATEST


# ------------------------------------------------------------------
# Route-normalisation helper (for the HTTP middleware)
# ------------------------------------------------------------------
# FastAPI's `request.url.path` includes concrete values like
# `/ussd/airtel`. That's already low cardinality for us because MNO
# adapter routes are enumerated (airtel/vodacom/tigo/halotel/healthz)
# — the only high-card path is `/metrics` and the OpenAPI docs, which
# are dev-only.
# If we ever add a REST admin API with per-id routes, extend this to
# collapse `/foo/{id}` etc. based on request.scope['route'].path.

_ROUTE_ALLOWLIST: frozenset[str] = frozenset({
    "/ussd/vodacom", "/ussd/airtel", "/ussd/tigo", "/ussd/halotel",
    "/healthz", "/metrics",
    "/docs", "/openapi.json", "/redoc",
})


def normalise_route(path: str) -> str:
    """Collapse anything outside the enumerated set to `<other>` so a
    hostile scanner hitting `/random-path-<uuid>` can't blow up the
    label cardinality."""
    if not path:
        return "<other>"
    # Strip trailing slash for consistency
    stripped = path.rstrip("/") or "/"
    if stripped in _ROUTE_ALLOWLIST:
        return stripped
    return "<other>"
