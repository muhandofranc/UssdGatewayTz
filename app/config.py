"""Env-driven config — every knob in one place.

Every value lands here through `os.environ.get(...)` with a documented
default; no .env loader is wired into the app process (docker compose
populates the env at container start time). The `.env.example` file
documents what each key does for operators copying it to `.env`.
"""
from __future__ import annotations

import os
from dataclasses import dataclass


def _env_bool(name: str, default: bool) -> bool:
    v = os.environ.get(name)
    if v is None:
        return default
    return v.strip().lower() in ("1", "true", "yes", "on")


def _env_int(name: str, default: int) -> int:
    v = os.environ.get(name, "").strip()
    return int(v) if v else default


def _env_float(name: str, default: float) -> float:
    v = os.environ.get(name, "").strip()
    return float(v) if v else default


@dataclass(frozen=True)
class PgConfig:
    host: str
    port: int
    user: str
    password: str
    db: str
    sslmode: str

    @property
    def dsn(self) -> str:
        return (
            f"host={self.host} port={self.port} user={self.user} "
            f"password={self.password} dbname={self.db} sslmode={self.sslmode}"
        )


@dataclass(frozen=True)
class HalotelConfig:
    """Halotel is the one MNO that doesn't fit the synchronous request/
    response model — its USSDGW expects an immediate SOAP ack on the
    inbound, then we POST the menu back on a separate outbound HTTP
    call to their callback URL. So we need their callback URL +
    credentials in BOTH directions:

      * inbound_user / inbound_pass — what Halotel sends us in the
        SOAP body; we verify against these. Halotel provisions a
        unique pair per WASP integration.
      * outbound_user / outbound_pass — what WE send to Halotel on
        outbound pushes; provisioned BY Halotel for us.
      * outbound_url — Halotel USSDGW SOAP endpoint we push to.
      * ussdgw_id_default — echoed in our outbound payload; in
        practice Halotel ignores it on inbound (we cache from their
        inbound payload anyway), but a default is required for the
        rare case where we initiate an outbound without a matching
        inbound.
      * outbound_timeout_secs — how long to wait for Halotel's ack
        on our outbound push before giving up.

    When unset (empty strings, missing URL), the Halotel adapter
    refuses to start the outbound push — logs + returns gracefully —
    so the gateway can still ack inbound traffic while Halotel
    onboarding completes.
    """
    inbound_user: str
    inbound_pass: str
    outbound_url: str
    outbound_user: str
    outbound_pass: str
    ussdgw_id_default: str
    outbound_timeout_secs: float


@dataclass(frozen=True)
class Settings:
    pg: PgConfig
    # Default per-handler outbound timeout when the shortcode row's
    # timeout_secs isn't set or is invalid. MNO USSD timeouts are
    # typically 5-10s, so a handler reply must arrive well inside
    # that — 5s default leaves headroom for our own latency.
    handler_default_timeout_secs: float
    # Application port the FastAPI app listens on inside the container.
    listen_host: str
    listen_port: int
    log_level: str
    halotel: HalotelConfig


def load() -> Settings:
    """Read env once. Call at app startup and pass the result around;
    do NOT re-read env per request (cost + makes hot-swap unsafe)."""
    return Settings(
        pg=PgConfig(
            host=os.environ.get("USSD_PG_HOST", "127.0.0.1"),
            port=_env_int("USSD_PG_PORT", 5432),
            user=os.environ.get("USSD_PG_USER", "ussd_gw"),
            password=os.environ.get("USSD_PG_PASSWORD", ""),
            db=os.environ.get("USSD_PG_DB", "ussd_gateway_tz"),
            sslmode=os.environ.get("USSD_PG_SSLMODE", "prefer"),
        ),
        handler_default_timeout_secs=_env_float(
            "USSD_HANDLER_DEFAULT_TIMEOUT_SECS", 5.0
        ),
        listen_host=os.environ.get("USSD_LISTEN_HOST", "0.0.0.0"),
        listen_port=_env_int("USSD_LISTEN_PORT", 8080),
        log_level=os.environ.get("USSD_LOG_LEVEL", "INFO"),
        halotel=HalotelConfig(
            inbound_user=os.environ.get("HALOTEL_INBOUND_USER", ""),
            inbound_pass=os.environ.get("HALOTEL_INBOUND_PASS", ""),
            outbound_url=os.environ.get("HALOTEL_OUTBOUND_URL", ""),
            outbound_user=os.environ.get("HALOTEL_OUTBOUND_USER", ""),
            outbound_pass=os.environ.get("HALOTEL_OUTBOUND_PASS", ""),
            ussdgw_id_default=os.environ.get("HALOTEL_USSDGW_ID", "1"),
            outbound_timeout_secs=_env_float("HALOTEL_OUTBOUND_TIMEOUT_SECS", 4.0),
        ),
    )
