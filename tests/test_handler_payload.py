"""Handler payload shapes (migration 030).

The legacy shape reproduces a wire contract that live PHP handlers already
parse -- key names, key CASING and the spliced `serviceCode` are all part of
it. These tests pin it against the senders in
/var/www/html/{jubileetigo,jubileeair,karata3voda}/index_patch.php.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.db import ShortcodeRow                        # noqa: E402
from app.forwarder import build_handler_payload, _legacy_service_code  # noqa: E402
from app.unified import SessionEvent, UnifiedRequest   # noqa: E402


def _sc(**kw):
    base = dict(
        id=1, operator_id=1, operator_name="vodacom", code="*149*76#",
        owner_user_id=1, handler_url="https://h.example/ussd",
        auth_mode="none", bearer_token=None, timeout_secs=5,
        active=True, status="active", status_message=None,
    )
    base.update(kw)
    return ShortcodeRow(**base)


def _ur(ussd_string="", operator="vodacom", event=SessionEvent.START):
    return UnifiedRequest(
        operator=operator, msisdn="255712345678", session_id="ABC123",
        service_code="*149*76#", ussd_string=ussd_string, event=event,
        raw_payload={"native": "x"},
    )


# ---- default: nothing changes for existing shortcodes --------------------

def test_default_is_the_gateway_shape():
    """A row with no explicit payload_format must keep the unified body."""
    p = build_handler_payload(_sc(), _ur("1*2"))
    assert set(p) == {"operator", "msisdn", "session_id", "service_code",
                      "ussd_string", "event", "raw_payload"}
    assert p["service_code"] == "*149*76#"     # bare shortcode, NOT spliced
    assert p["ussd_string"] == "1*2"


def test_explicit_gateway_matches_default():
    assert build_handler_payload(_sc(payload_format="gateway"), _ur("1")) == \
           build_handler_payload(_sc(), _ur("1"))


# ---- legacy shape --------------------------------------------------------

def test_legacy_keys_and_casing_are_exact():
    p = build_handler_payload(_sc(payload_format="legacy"), _ur("1*2"))
    assert list(p) == ["sessionId", "msisdn", "networkProvider",
                       "serviceCode", "UssdString"]
    assert "UssdString" in p and "ussdString" not in p   # capital U is the contract
    assert p["sessionId"] == "ABC123"
    assert p["msisdn"] == "255712345678"
    assert p["UssdString"] == "1*2"


def test_legacy_omits_gateway_only_fields():
    """Legacy handlers never received these and may choke on extras."""
    p = build_handler_payload(_sc(payload_format="legacy"), _ur("1"))
    for k in ("event", "raw_payload", "operator", "session_id",
              "service_code", "ussd_string"):
        assert k not in p


def test_legacy_service_code_splices_the_input_trail():
    """serviceCode carries the WHOLE dialled string, not the shortcode."""
    assert _legacy_service_code("*149*76#", "") == "*149*76#"
    assert _legacy_service_code("*149*76#", "1") == "*149*76*1#"
    assert _legacy_service_code("*149*76#", "1*2") == "*149*76*1*2#"
    # a code stored without the trailing '#' still produces one
    assert _legacy_service_code("*149*76", "1") == "*149*76*1#"


def test_legacy_opening_leg_keeps_the_dialled_code_untouched():
    p = build_handler_payload(_sc(payload_format="legacy"), _ur(""))
    assert p["serviceCode"] == "*149*76#"
    assert p["UssdString"] == ""


def test_network_provider_defaults_to_uppercase_operator():
    for op, expected in (("vodacom", "VODACOM"), ("airtel", "AIRTEL"),
                         ("halotel", "HALOTEL")):
        p = build_handler_payload(_sc(payload_format="legacy"),
                                  _ur("1", operator=op))
        assert p["networkProvider"] == expected


def test_tigo_keeps_the_canonical_gateway_name():
    """Yas is Tigo renamed, not a second operator, so it stays under the
    gateway's canonical `tigo` and goes out as TIGO. Changing that is an
    operator rename in db/001_init.sql, not a per-shortcode setting."""
    p = build_handler_payload(_sc(payload_format="legacy"),
                              _ur("1", operator="tigo"))
    assert p["networkProvider"] == "TIGO"


def test_unknown_payload_format_falls_back_to_gateway():
    """A bad value must not silently send a half-built legacy body; the
    CHECK constraint makes this unreachable via SQL, but the forwarder
    should not depend on that."""
    p = build_handler_payload(_sc(payload_format="nonsense"), _ur("1"))
    assert "operator" in p and "sessionId" not in p
