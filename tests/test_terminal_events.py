"""Terminal-event handler notification.

A terminal event (user cancelled / provider ended the session) used to be
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
from app.unified import (                                   # noqa: E402
    SESSION_ENDED_EVENTS, SessionEvent, TERMINAL_EVENTS, UnifiedRequest,
)


def _sc(**kw):
    base = dict(
        id=1, operator_id=1, operator_name="vodacom", code="*149*76#",
        owner_user_id=1, handler_url="https://h.example/ussd",
        auth_mode="none", bearer_token=None, timeout_secs=5,
        active=True, status="active", status_message=None,
    )
    base.update(kw)
    return ShortcodeRow(**base)


def _ur(event=SessionEvent.USER_CANCELLED_SESSION):
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
    build for every one."""
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
        (SessionEvent.USER_CANCELLED_SESSION,       "__USER_CANCELLED__"),
        (SessionEvent.PROVIDER_SESSION_TERMINATION, "__TIMEOUT__"),
        (SessionEvent.SYSTEM_SESSION_TERMINATION,   "__SESSION_EXPIRED__"),
    ):
        p = build_handler_payload(_sc(payload_format="legacy"), _ur(ev))
        assert p["UssdString"] == expected


def test_sentinel_replaces_the_trail_rather_than_extending_it():
    """'1*2*cancel' would be read as a menu selection by any handler
    that splits the trail on '*'. The sentinel must be the whole value
    and must contain no separator."""
    p = build_handler_payload(_sc(payload_format="legacy"),
                              _ur(SessionEvent.USER_CANCELLED_SESSION))
    assert "*" not in p["UssdString"]
    assert p["UssdString"].split("*") == ["__USER_CANCELLED__"]
    assert "1*2" not in p["UssdString"]


def test_sentinel_makes_a_cancel_distinguishable_from_real_input():
    cancelled = build_handler_payload(_sc(payload_format="legacy"),
                                      _ur(SessionEvent.USER_CANCELLED_SESSION))
    real_input = build_handler_payload(_sc(payload_format="legacy"),
                                       _ur(SessionEvent.INPUT))
    assert cancelled != real_input
    assert cancelled["UssdString"] != real_input["UssdString"]


def test_sentinel_adds_no_key_to_the_legacy_contract():
    """The whole point of routing through UssdString: the key set the
    legacy handlers parse is untouched."""
    p = build_handler_payload(_sc(payload_format="legacy"),
                              _ur(SessionEvent.USER_CANCELLED_SESSION))
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
    p = build_handler_payload(_sc(), _ur(SessionEvent.USER_CANCELLED_SESSION))
    assert p["ussd_string"] == "1*2"
    assert p["event"] == "user_cancelled_session"


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

      vodacom  TruRoute type 3 / 4 / 10   -> cancel + provider termination
      halotel  requestType 102 / 104      -> cancel + provider termination
      airtel   wire is input/sessionid/msisdn and NOTHING else
      tigo     no terminal events in the observed wire
    """
    from app.adapters.vodacom import _TYPE_EVENT_MAP as VODA
    from app.adapters.halotel import _TYPE_EVENT_MAP as HALO

    P = SessionEvent.PROVIDER_SESSION_TERMINATION
    assert VODA["3"]  is SessionEvent.USER_CANCELLED_SESSION
    assert VODA["4"]  is P
    assert VODA["10"] is P
    assert TERMINAL_EVENTS <= set(VODA.values())

    assert HALO["102"] is SessionEvent.USER_CANCELLED_SESSION
    assert HALO["104"] is P
    assert TERMINAL_EVENTS <= set(HALO.values())

    # airtel + tigo derive event from cache presence / NEW_REQUEST only.
    import app.adapters.airtel as airtel, app.adapters.tigo as tigo
    for mod in (airtel, tigo):
        assert not hasattr(mod, "_TYPE_EVENT_MAP")
        src = open(mod.__file__).read()
        for ev in ("USER_CANCELLED_SESSION", "PROVIDER_SESSION_TERMINATION"):
            assert f"SessionEvent.{ev}" not in src, f"{mod.__name__} now maps {ev}"


# ---- gateway-declared expiry (SYSTEM_SESSION_TERMINATION) ----------------

def test_session_expired_is_ended_but_not_wire_terminal():
    """SYSTEM_SESSION_TERMINATION means the session is over, so it must reach the
    legacy sentinel. It must NOT be in TERMINAL_EVENTS: that set drives
    the inbound branch in main.py, which answers an actual MNO leg, and
    expiry has no leg to answer."""
    assert SessionEvent.SYSTEM_SESSION_TERMINATION in SESSION_ENDED_EVENTS
    assert SessionEvent.SYSTEM_SESSION_TERMINATION not in TERMINAL_EVENTS
    assert TERMINAL_EVENTS < SESSION_ENDED_EVENTS


def test_expiry_gateway_body_names_the_event_and_keeps_the_trail():
    p = build_handler_payload(_sc(), _ur(SessionEvent.SYSTEM_SESSION_TERMINATION))
    assert p["event"] == "system_session_termination"
    assert p["ussd_string"] == "1*2"


def test_expiry_legacy_body_carries_the_sentinel():
    p = build_handler_payload(_sc(payload_format="legacy"),
                              _ur(SessionEvent.SYSTEM_SESSION_TERMINATION))
    assert p["UssdString"] == "__SESSION_EXPIRED__"
    assert set(p) == {"sessionId", "msisdn", "networkProvider",
                      "serviceCode", "UssdString"}


def test_expiry_backlog_guard_defaults_are_sane():
    """notify_max_age must sit ABOVE idle, or the notify window is empty
    and nothing is ever notified; and it must stay finite, or the first
    run notifies handlers about the entire accumulated backlog."""
    from app.config import load
    cfg = load().expiry
    assert cfg.idle_secs > 0
    assert cfg.notify_max_age_secs > cfg.idle_secs
    assert cfg.batch > 0
    assert cfg.sweep_interval_secs > 0


def test_wire_event_names():
    """Handlers match on these strings; renaming one is a contract break."""
    assert {e.value for e in SESSION_ENDED_EVENTS} == {
        "user_cancelled_session",
        "provider_session_termination",
        "system_session_termination",
    }


# ---- Vodacom type=3: subscriber cancel vs Vodacom's own 60s cut-off ------

def _vodacom_type3(monkeypatch, prior):
    from fastapi import Request
    from app import db
    from app.adapters import vodacom

    monkeypatch.setattr(db, "get_active_session", lambda sid, op: prior)
    monkeypatch.setattr(vodacom.Vodacom, "_operator_id", 1)
    body = (b"<ussd><msisdn>255712345678</msisdn><sessionid>S1</sessionid>"
            b"<type>3</type><msg></msg></ussd>")

    async def receive():
        return {"type": "http.request", "body": body, "more_body": False}

    req = Request({"type": "http", "method": "POST", "path": "/",
                   "headers": [(b"content-type", b"text/xml")],
                   "query_string": b""}, receive)
    return asyncio.run(vodacom.Vodacom().parse(req)).event


def _prior(idle_secs):
    from app.db import ActiveSession
    return ActiveSession(session_id="S1", operator_id=1, service_code="*149*76#",
                         shortcode_id=7, msisdn="255712345678",
                         ussd_string="1*2", idle_secs=idle_secs)


def test_vodacom_type3_soon_after_a_leg_is_a_user_cancel(monkeypatch):
    assert (_vodacom_type3(monkeypatch, _prior(12.0))
            is SessionEvent.USER_CANCELLED_SESSION)


def test_vodacom_type3_after_its_idle_cutoff_is_a_provider_termination(monkeypatch):
    for idle in (55.0, 60.4, 300.0):
        assert (_vodacom_type3(monkeypatch, _prior(idle))
                is SessionEvent.PROVIDER_SESSION_TERMINATION), idle


def test_vodacom_type3_with_no_cached_session_stays_a_user_cancel(monkeypatch):
    """Nothing to measure idle against, so trust the wire code."""
    assert (_vodacom_type3(monkeypatch, None)
            is SessionEvent.USER_CANCELLED_SESSION)
