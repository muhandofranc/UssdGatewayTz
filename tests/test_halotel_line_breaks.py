"""Halotel menus: newlines become the literal <br> the handset renders."""
from app.adapters.halotel import _build_outbound_envelope, halotel_line_breaks


def test_every_kind_of_newline_becomes_br():
    assert halotel_line_breaks("Karibu\n1. Cheza\r\n2. Salio\r3. Toka") == \
        "Karibu<br>1. Cheza<br>2. Salio<br>3. Toka"
    assert halotel_line_breaks("") == ""
    assert halotel_line_breaks(None) == ""


def test_envelope_carries_literal_br_not_escaped_or_newline():
    env = _build_outbound_envelope(
        out_user="u", out_pass="p", msisdn="255620000001",
        msg=halotel_line_breaks("Karibu\n1. Cheza & Shinda\n2. Toka"),
        sessionid="s1", transactionid="t1", request_type="201", ussdgw_id="1")
    body = env.decode()
    assert "<msg>Karibu<br>1. Cheza &amp; Shinda<br>2. Toka</msg>" in body
    assert "\n" not in body.split("<msg>")[1].split("</msg>")[0]
    assert "&lt;br&gt;" not in body
