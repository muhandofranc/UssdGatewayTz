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
class SessionExpiryConfig:
    """Global inactive-USSD-session expiry, and the notification the
    gateway sends the handler when it fires.

    Only Vodacom (TruRoute 3/4/10) and Halotel (102/104) signal a
    terminal event on the wire. Airtel and Tigo signal nothing, so a
    subscriber who walks away mid-menu leaves the handler holding state
    it will never be told to release. This closes that gap for every
    operator by treating inactivity itself as the terminal signal.

    idle_secs
        How long with no leg before a session is considered dead. This
        is USER THINK TIME -- the gap between the gateway answering and
        the subscriber's next keypress arriving -- so it is not a
        latency budget, it is how long a person is allowed to read a
        menu and type.

        Set BELOW the MNO's own session TTL and the gateway starts
        killing sessions the network still considers live. The next leg
        then finds no cache row, and for Vodacom and Halotel that means
        service_code = '' (vodacom.py:206, halotel.py:411), no shortcode
        resolves, and the subscriber gets "Service not configured"
        mid-flow. On Airtel it is worse: cache presence IS the
        START/INPUT discriminator (airtel.py:136-138), so a genuine
        INPUT leg is reclassified as START. db/002 records observed MNO
        gateway TTLs of 30-120s.

        Airtel and Tigo are the exposed pair: they send no terminal
        event at all, so this is the only thing that ends their
        sessions, and it will cut a real subscriber off mid-menu if it
        fires while they are still typing.

    notify_max_age_secs
        The BACKLOG GUARD, and the reason this is safe to switch on
        against a live table. A row idle longer than this is not
        notified AND not deleted by this sweeper -- it is left entirely
        alone for the manual drain in db/032. Without it, first run
        against the ~2.9M row backlog would fire millions of HTTP calls
        at handlers for sessions weeks or months dead. Keep it well
        above idle_secs and far below the age of the backlog.

    sweep_interval_secs
        How often each gateway worker looks for expired sessions. Keep
        it well under idle_secs or it becomes the real resolution: a
        session idle for idle_secs is only noticed on the next tick, so
        effective expiry is idle_secs .. idle_secs + sweep_interval_secs.

    batch
        Maximum sessions one worker claims per tick. Bounds both the
        notification burst and the size of a single DELETE.

    enabled
        Kill switch. False stops the sweep and the notifications without
        needing a rollback; expiry then falls back to the scheduler's
        SQL sweeper alone (silent, no notification).
    """
    enabled: bool
    idle_secs: int
    notify_max_age_secs: int
    sweep_interval_secs: int
    batch: int


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
    expiry: SessionExpiryConfig


def load() -> Settings:
    """Read env once. Call at app startup and pass the result around;
    do NOT re-read env per request (cost + makes hot-swap unsafe)."""
    return Settings(
        pg=PgConfig(
            host=os.environ.get("USSD_PG_HOST", "172.16.0.164"),
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
        listen_port=_env_int("USSD_LISTEN_PORT", 8280),
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
        expiry=SessionExpiryConfig(
            enabled=_env_bool("USSD_SESSION_EXPIRY_NOTIFY", True),
            idle_secs=_env_int("USSD_SESSION_IDLE_EXPIRY_SECS", 30),
            notify_max_age_secs=_env_int(
                "USSD_SESSION_EXPIRY_NOTIFY_MAX_AGE_SECS", 3600
            ),
            sweep_interval_secs=_env_int("USSD_SESSION_EXPIRY_SWEEP_SECS", 5),
            batch=_env_int("USSD_SESSION_EXPIRY_BATCH", 200),
        ),
    )
