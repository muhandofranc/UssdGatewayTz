"""The unified data shapes the gateway speaks internally.

Every per-MNO adapter parses the native MNO wire format into a
`UnifiedRequest` and (for the response leg) translates a
`UnifiedReply` back into the MNO's native shape. Handlers (internal
apps + external clients) only ever see / produce the unified
shapes — adding a new MNO is one new adapter, zero handler changes.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


class Action(str, Enum):
    """USSD reply action — does the session continue or end?"""
    CON = "CON"
    END = "END"


class SessionEvent(str, Enum):
    """Lifecycle event on the inbound leg — every adapter maps the
    MNO-native request type into one of these so the pipeline can
    branch on a canonical value.

    * START          first leg, msg carries the service_code (Vodacom
                     TruRoute type=1; Airtel/Tigo/Halotel equivalents
                     map here).
    * INPUT          subsequent leg, msg carries the user's input
                     (Vodacom TruRoute type=2).
    * USER_CANCELLED user pressed cancel / hung up (Vodacom type=3).
                     Terminal — gateway does NOT call the handler;
                     just logs + expires session state + ACKs MNO.
    * TIMEOUT        MNO closed the session (Vodacom type=4). Terminal.
    * CHARGE_FAILED  premium-rate charge attempt failed (Vodacom
                     type=10). Terminal — handler is notified but
                     gateway does not wait on a reply (the customer
                     has already moved on).
    * DELIVERY_ACK   informational delivery receipt from the MNO
                     (Halotel type=103 — "menu reached the user").
                     NOT terminal — the session is still alive.
                     Pipeline: no handler forward, no session
                     expire, just inbound ack + log.

    The TERMINAL subset is { USER_CANCELLED, TIMEOUT, CHARGE_FAILED }.
    The pipeline short-circuits forwarder.forward() for those and
    returns a no-content ack to the MNO, expiring the session.

    The NO_FORWARD subset is TERMINAL_EVENTS ∪ { DELIVERY_ACK } —
    these never reach the handler, but DELIVERY_ACK keeps the
    session cache row alive.
    """
    START          = "start"
    INPUT          = "input"
    USER_CANCELLED = "user_cancelled"
    TIMEOUT        = "timeout"
    CHARGE_FAILED  = "charge_failed"
    DELIVERY_ACK   = "delivery_ack"


TERMINAL_EVENTS = frozenset({
    SessionEvent.USER_CANCELLED,
    SessionEvent.TIMEOUT,
    SessionEvent.CHARGE_FAILED,
})

NO_FORWARD_EVENTS = TERMINAL_EVENTS | frozenset({SessionEvent.DELIVERY_ACK})


@dataclass(frozen=True)
class UnifiedRequest:
    """Canonical inbound shape — every MNO adapter normalises into this.

    The fields here are the LCD across Vodacom / Airtel / Tigo / Halotel.
    Per-MNO oddities (originating-IP, network type, RAN cell, etc.)
    travel separately in `raw_payload` for handlers that want them.
    """
    operator: str          # 'vodacom' | 'airtel' | 'tigo' | 'halotel'
    msisdn: str            # subscriber phone, no leading '+' (per most TZ MNO docs)
    session_id: str        # MNO-issued session id
    service_code: str      # e.g. '*123#'  — what the user dialed (resolved from session cache on INPUT legs)
    ussd_string: str       # accumulated menu trail (gateway appends every user input separated by '*')
    event: SessionEvent    # canonical lifecycle event for this leg
    raw_payload: dict      # the original MNO payload (debug + handler access)
    # Shortcode id lifted from the session-cache row, when known. Set on
    # legs the adapter reads from prior session state but that the
    # pipeline short-circuits BEFORE resolve_shortcode() — terminal
    # events (cancel/timeout/charge-fail), delivery-ack, and auth-failed
    # — so those log rows stay attributable to their shortcode. None on
    # the opening leg (nothing resolved yet) and on legs where the
    # pipeline resolves the shortcode fresh (it uses that id there).
    shortcode_id: Optional[int] = None
    # Phase 2 may add: gateway_session_id (our own UUID for the leg),
    # cell_id, network_type. Adapters can stuff these into raw_payload
    # for now.


@dataclass(frozen=True)
class UnifiedReply:
    """Canonical outbound shape — the handler returns one of these
    (as JSON or first-line plain text); we translate per-MNO."""
    action: Action          # CON → keep session open; END → terminate
    message: str            # display text (USSD-line-wrapped)


@dataclass
class HandlerOutcome:
    """The full result of a handler invocation — used for logging.

    `reply` is None when the handler failed (timeout / non-2xx / bad
    body). In that case the caller renders a generic END message to
    the MNO so the customer isn't left hanging on a black screen.
    """
    reply: Optional[UnifiedReply]
    status_code: Optional[int]   # HTTP status from handler, None on transport failure
    elapsed_ms: int
    error_class: Optional[str] = None   # 'timeout' | 'badbody' | 'non2xx' | ...
    error_detail: Optional[str] = None
    raw_response_payload: Optional[dict] = field(default=None)
