"""Terminal-event handler notification.

A terminal event (user cancelled / MNO timeout / charge failed) used to be
short-circuited: the gateway acked the MNO and the handler was never told,
so a handler holding state for that session -- reserved stock, a pending
charge, a half-written record -- only found out via its own timeout.

Terminal events are now forwarded fire-and-forget AFTER the MNO ack, on both
payload formats. The gateway body says which event it was in `event`; the
legacy body has no such key, so `UssdString` carries a sentinel instead.

These tests pin the two cases where notification must NOT happen, the `event`
field on the gateway shape, and the sentinel on the legacy shape -- including
that it never looks like a menu selection and never leaks into a normal leg.
"""
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.db import ShortcodeRow                             # noqa: E402
from app.forwarder import build_handler_payload             # noqa: E402
from app.main import (                                      # noqa: E402
    _BACKGROUND_TASKS, _spawn_background, _terminal_notify_skip_reason,
)
from app.unified import SessionEvent, TERMINAL_EVENTS, UnifiedRequest  # noqa: E402


def _sc(**kw):
    base = dict(
        id=1, operator_id=1, operator_name="vodacom", code="*149*76#",
        owner_user_id=1, handler_url="https://h.example/ussd",
        auth_mode="none", bearer_token=None, timeout_secs=5,
        active=True, status="active", status_message=None,
    )
    base.update(kw)
    return ShortcodeRow(**base)


def _ur(event=SessionEvent.USER_CANCELLED):
    return UnifiedRequest(
        operator="vodacom", msisdn="255712345678", session_id="ABC123",
        service_code="*149*76#", ussd_string="1*2", event=event,
        raw_payload={"native": "x"},
    )


# ---- when the handler IS notified ---------------------------------------

def test_active_gateway_shortcode_is_notified():
    assert _terminal_notify_skip_reason(_sc()) is None


def test_every_terminal_event_carries_its_own_event_value():
    """The `event` field is the only thing distinguishing a terminal
    notification from a real input leg, so it must survive the payload
    build for all three."""
    for ev in TERMINAL_EVENTS:
        p = build_handler_payload(_sc(), _ur(ev))
        assert p["event"] == ev.value
        assert p["session_id"] == "ABC123"
        assert p["ussd_string"] == "1*2"


# ---- when it is NOT, and why --------------------------------------------

def test_unresolved_shortcode_is_skipped():
    """No cache row -> no service_code -> nothing to resolve against."""
    assert _terminal_notify_skip_reason(None) == "unresolved"


def test_maintenance_and_deactivated_are_skipped():
    """The handler was never called for this session, so it holds no
    state to release."""
    for status in ("maintenance", "deactivated"):
        assert _terminal_notify_skip_reason(_sc(status=status)) == "shortcode_inactive"


def test_legacy_shortcodes_are_notified_too():
    """Legacy handlers get terminal events via the UssdString sentinel,
    so payload_format is no longer a reason to skip."""
    assert _terminal_notify_skip_reason(_sc(payload_format="legacy")) is None


# ---- the legacy sentinel -------------------------------------------------

def test_legacy_terminal_leg_carries_the_sentinel():
    for ev, expected in (
        (SessionEvent.USER_CANCELLED, "__USER_CANCELLED__"),
        (SessionEvent.TIMEOUT,        "__TIMEOUT__"),
        (SessionEvent.CHARGE_FAILED,  "__CHARGE_FAILED__"),
    ):
        p = build_handler_payload(_sc(payload_format="legacy"), _ur(ev))
        assert p["UssdString"] == expected


def test_sentinel_replaces_the_trail_rather_than_extending_it():
    """'1*2*cancel' would be read as a menu selection by any handler
    that splits the trail on '*'. The sentinel must be the whole value
    and must contain no separator."""
    p = build_handler_payload(_sc(payload_format="legacy"),
                              _ur(SessionEvent.USER_CANCELLED))
    assert "*" not in p["UssdString"]
    assert p["UssdString"].split("*") == ["__USER_CANCELLED__"]
    assert "1*2" not in p["UssdString"]


def test_sentinel_makes_a_cancel_distinguishable_from_real_input():
    cancelled = build_handler_payload(_sc(payload_format="legacy"),
                                      _ur(SessionEvent.USER_CANCELLED))
    real_input = build_handler_payload(_sc(payload_format="legacy"),
                                       _ur(SessionEvent.INPUT))
    assert cancelled != real_input
    assert cancelled["UssdString"] != real_input["UssdString"]


def test_sentinel_adds_no_key_to_the_legacy_contract():
    """The whole point of routing through UssdString: the key set the
    legacy handlers parse is untouched."""
    p = build_handler_payload(_sc(payload_format="legacy"),
                              _ur(SessionEvent.USER_CANCELLED))
    assert set(p) == {"sessionId", "msisdn", "networkProvider",
                      "serviceCode", "UssdString"}
    assert "event" not in p


def test_normal_legacy_legs_keep_the_real_trail():
    """Regression guard: the sentinel must never touch start/input."""
    for ev in (SessionEvent.START, SessionEvent.INPUT):
        p = build_handler_payload(_sc(payload_format="legacy"), _ur(ev))
        assert p["UssdString"] == "1*2"


def test_gateway_trail_is_never_replaced():
    """The sentinel is a legacy-only workaround; the gateway shape has
    `event`, so its trail stays intact and usable."""
    p = build_handler_payload(_sc(), _ur(SessionEvent.USER_CANCELLED))
    assert p["ussd_string"] == "1*2"
    assert p["event"] == "user_cancelled"


# ---- the fire-and-forget dispatch itself --------------------------------

def test_spawn_background_holds_a_reference_until_done():
    """asyncio keeps only a weak reference to a running task; without a
    strong one held here a fire-and-forget notification can be collected
    mid-flight and vanish silently."""
    seen = []

    async def scenario():
        started = asyncio.Event()

        async def work():
            started.set()
            await asyncio.sleep(0)
            seen.append("ran")

        _spawn_background(work())
        await started.wait()
        assert len(_BACKGROUND_TASKS) == 1, "task not retained while running"
        await asyncio.sleep(0.05)

    asyncio.run(scenario())
    assert seen == ["ran"]
    assert len(_BACKGROUND_TASKS) == 0, "completed task not released"


# ---- which operators can raise one at all --------------------------------

def test_operator_terminal_event_coverage():
    """Only two of the four MNOs signal terminal events on the wire, so
    only those two can ever notify a handler. Pinned because it is the
    first question asked when a handler sees no cancel for a partner.

      vodacom  TruRoute type 3 / 4 / 10   -> all three
      halotel  requestType 102 / 104      -> cancel + timeout only
                                             (no charge-failed in spec)
      airtel   wire is input/sessionid/msisdn and NOTHING else
      tigo     no terminal events in the observed wire
    """
    from app.adapters.vodacom import _TYPE_EVENT_MAP as VODA
    from app.adapters.halotel import _TYPE_EVENT_MAP as HALO

    assert VODA["3"]  is SessionEvent.USER_CANCELLED
    assert VODA["4"]  is SessionEvent.TIMEOUT
    assert VODA["10"] is SessionEvent.CHARGE_FAILED
    assert TERMINAL_EVENTS <= set(VODA.values())

    assert HALO["102"] is SessionEvent.USER_CANCELLED
    assert HALO["104"] is SessionEvent.TIMEOUT
    assert SessionEvent.CHARGE_FAILED not in HALO.values()

    # airtel + tigo derive event from cache presence / NEW_REQUEST only.
    import app.adapters.airtel as airtel, app.adapters.tigo as tigo
    for mod in (airtel, tigo):
        assert not hasattr(mod, "_TYPE_EVENT_MAP")
        src = open(mod.__file__).read()
        for ev in ("USER_CANCELLED", "CHARGE_FAILED"):
            assert f"SessionEvent.{ev}" not in src, f"{mod.__name__} now maps {ev}"
