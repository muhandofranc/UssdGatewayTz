"""Per-MNO adapter protocol + registry.

An adapter is the ONLY MNO-aware code in the gateway. It does two
things:
  1. parse(request)   — convert the MNO's native HTTP request (GET
                         query params or POST body, JSON or form) into
                         a `UnifiedRequest`.
  2. render(reply)    — convert a `UnifiedReply` (action + message)
                         back into the MNO's native HTTP response
                         (typically a plain-text "CON ..."/"END ..."
                         body, OR an MNO-specific JSON/XML shape).

Adding a new MNO = one new module in this package matching the
`Adapter` protocol below + one entry in `REGISTRY`. The route handler
in `app/main.py` dispatches purely on the operator path segment.

Phase 1 stubs: every adapter currently treats requests as a generic
form/query with the most-common parameter names (msisdn, sessionid,
serviceCode, text) and renders responses as `<action> <message>`
plain text. THESE WILL CHANGE per the actual MNO spec — the parse()
/ render() bodies are the ONLY thing that needs to update per MNO,
keeping the rest of the pipeline stable.
"""
from __future__ import annotations

from typing import Protocol

from fastapi import Request, Response

from ..unified import UnifiedReply, UnifiedRequest


class Adapter(Protocol):
    """One per MNO. Stateless — every method is pure given the
    incoming Request / outgoing reply.
    """
    operator: str  # canonical lowercase key (matches operators.name in DB)

    # Async-outbound capability. False (default) = synchronous MNO:
    # the inbound HTTP response carries the menu (Vodacom, Airtel,
    # Tigo). True = bidirectional MNO: the inbound HTTP response is
    # just an ack, the menu is pushed back on a SEPARATE outbound
    # HTTP POST from us to the MNO (Halotel SOAP). When True, the
    # adapter MUST implement `push_outbound()` and `render()` must
    # produce the ack envelope only.
    is_async_outbound: bool

    async def parse(self, req: Request) -> UnifiedRequest:
        """Pull the relevant fields out of the MNO request (GET query
        string OR POST body, JSON or form-urlencoded). Adapters are
        responsible for raising `HTTPException(400)` if a mandatory
        field is missing."""
        ...

    def render(self, reply: UnifiedReply) -> Response:
        """Build the MNO-native HTTP response (plain text, JSON, or
        XML depending on the MNO spec). Content-Type set per MNO.

        For async-outbound MNOs: this produces the inbound ACK
        envelope (the menu content is irrelevant here — it goes out
        via push_outbound()). Sync MNOs ignore the distinction."""
        ...

    async def push_outbound(self, ur: UnifiedRequest, reply: UnifiedReply) -> dict:
        """Async-outbound MNOs only. POST the menu/result back to
        the MNO's USSDGW callback URL and return a dict suitable
        for logging (status, response body, errorCode). Sync MNOs
        leave this as a no-op — the pipeline never calls it for
        them (gated by `is_async_outbound`)."""
        ...


# Populated by per-MNO modules at import time (see vodacom.py etc.).
REGISTRY: dict[str, Adapter] = {}


def register(adapter_cls):
    """Decorator: instantiate the adapter class and register it under
    its `operator` attribute. Each MNO module ends with:

        @register
        class Vodacom: ...
    """
    inst = adapter_cls()
    REGISTRY[inst.operator] = inst
    return adapter_cls
