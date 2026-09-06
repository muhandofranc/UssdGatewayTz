"""Terminal-event handler notification.

A terminal event (user cancelled / MNO timeout / charge failed) used to be
short-circuited: the gateway acked the MNO and the handler was never told,
so a handler holding state for that session -- reserved stock, a pending
charge, a half-written record -- only found out via its own timeout.

Terminal events are now forwarded fire-and-forget AFTER the MNO ack. These
tests pin the three cases where that notification must NOT happen, and the
`event` field that makes it safe when it does.
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


def test_legacy_payload_format_is_skipped():
    assert _terminal_notify_skip_reason(
        _sc(payload_format="legacy")) == "legacy_payload_format"


def test_legacy_body_could_not_express_a_terminal_event():
    """The reason for the skip above, pinned: on the legacy shape a
    cancel is indistinguishable from real user input."""
    cancelled = build_handler_payload(_sc(payload_format="legacy"),
                                      _ur(SessionEvent.USER_CANCELLED))
    real_input = build_handler_payload(_sc(payload_format="legacy"),
                                       _ur(SessionEvent.INPUT))
    assert "event" not in cancelled
    assert cancelled == real_input


def test_inactive_is_checked_before_payload_format():
    """A legacy shortcode that is also paused reports the stronger
    reason, so the log says why it really was not called."""
    assert _terminal_notify_skip_reason(
        _sc(status="maintenance", payload_format="legacy")) == "shortcode_inactive"


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
