"""Halotel Tanzania USSD adapter — SOAP, bidirectional.

Spec: HalotelUSSD Integration Document — HTTP PROTOCOL v1.0
(31-05-2016).

Halotel is the only TZ MNO in this gateway that does NOT fit the
single-HTTP-exchange synchronous reseller model. Its USSDGW expects:

    1. INBOUND  — Halotel POSTs a SOAP <InsertMO> to our endpoint.
                  We respond IMMEDIATELY with a SOAP
                  <ussdresponse><errorCode>0</errorCode></ussdresponse>
                  envelope (just an ack — NOT the menu).
    2. OUTBOUND — On a SEPARATE HTTP POST, WE send the actual menu
                  (or result) back to Halotel's USSDGW callback URL,
                  also as a SOAP <InsertMO>. Halotel responds with
                  the same <ussdresponse><errorCode>...</errorCode>
                  envelope.

The two exchanges share the SAME `transactionid` (which Halotel
generates and starts with the letter `W`, e.g. `W1-2-1395280360802`).
We use `transactionid` — NOT `sessionid` — as the gateway's
`session_id` because `sessionid` is observed empty/null in the
spec examples while `transactionid` is the stable cross-leg key.

Pipeline implication
--------------------

This adapter sets `is_async_outbound = True`. The pipeline in
`main.py` then takes a different path: it acks the inbound HTTP
immediately, schedules `forward(handler) → push_outbound(...)` as
a background coroutine, and returns. The handler-forward and
outbound-POST happen AFTER Halotel has already received its ack.

If the outbound push fails (network error, non-2xx, errorCode != 0),
the customer will see their USSD session time out on Halotel's
side. We log + count but cannot recover the session because USSD
has no retry semantics. Future hardening: queue the outbound for
a brief retry budget.

Inbound requestType mapping
---------------------------

| Wire `requestType` | Meaning                       | Gateway `SessionEvent` | Pipeline behaviour |
|--------------------|-------------------------------|------------------------|--------------------|
| `100`              | First USSD request (msg = dialed code) | `START`        | forward + push     |
| `101`              | User input / menu selection            | `INPUT`        | forward + push     |
| `102`              | User cancelled transaction              | `USER_CANCELLED` | terminal — ack only, no push |
| `103`              | Display-ack (menu reached user)         | `DELIVERY_ACK` | ack only, no forward, no expire |
| `104`              | Transaction error, must cancel          | `TIMEOUT`      | terminal — ack only, no push |

Outbound requestType selection
------------------------------

The wire has 5 outbound types (200/201/202/203/204) — we collapse
to 4 cases that vary on (first-leg vs subsequent) × (CON vs END):

| Inbound was | Reply action | Outbound `requestType` | Meaning |
|-------------|--------------|------------------------|---------|
| `100` (first) | `CON`      | `202`                  | First menu, wait for input |
| `100` (first) | `END`      | `201`                  | First message, notify + close |
| `101` (input) | `CON`      | `200`                  | Follow-up menu, wait for input |
| `101` (input) | `END`      | `203`                  | Last menu, terminate transaction |

(`204` "notify mid-tx then close" and `205`/`206` system abort/cancel
are not yet emitted — extend `_outbound_request_type()` when a
handler needs them.)

Authentication
--------------

`user`/`pass` are credentials. Per-shortcode credential mode (since
2026-06-22): Halotel's USSDGW provisions different user/pass values
per shortcode, so the gateway does NOT validate inbound credentials
against a fixed env var — it just captures them and echoes them on
the outbound POST. Authentication is enforced at the NETWORK edge
(IP whitelist for Halotel's USSDGW source). The
`HALOTEL_OUTBOUND_USER` / `HALOTEL_OUTBOUND_PASS` env vars are kept
only as a defensive fallback when the inbound carried no creds;
`HALOTEL_INBOUND_USER` / `HALOTEL_INBOUND_PASS` are unused. The
`render_auth_failed()` method is retained for future per-shortcode
auth schemes (e.g. validating against a `shortcodes.expected_user`
column) but is not currently wired.

Service-code lookup
-------------------

The dialed code (e.g. `*123#`) is the `service_code` for shortcode
lookup, cached at START (type=100) and recovered on subsequent
legs from `ussd_active_sessions` — same pattern as Vodacom.
"""
from __future__ import annotations

import logging
import xml.etree.ElementTree as ET
from typing import Optional

import httpx
from fastapi import HTTPException, Request, Response

from .. import db
from ..config import HalotelConfig, load as load_settings
from ..unified import Action, SessionEvent, UnifiedReply, UnifiedRequest
from . import register

LOGGER = logging.getLogger(__name__)

_SOAP_NS  = "http://schemas.xmlsoap.org/soap/envelope/"
_TEMPURI  = "http://tempuri.org/"
_NS       = {"soap": _SOAP_NS, "t": _TEMPURI}

# requestType → SessionEvent for inbound. DELIVERY_ACK is a new
# event introduced for Halotel's type=103 ("menu displayed to user")
# — the pipeline treats it as no-forward, no-expire (the session is
# still alive, the user is just reading what we sent).
_TYPE_EVENT_MAP: dict[str, SessionEvent] = {
    "100": SessionEvent.START,
    "101": SessionEvent.INPUT,
    "102": SessionEvent.USER_CANCELLED,
    "103": SessionEvent.DELIVERY_ACK,
    "104": SessionEvent.TIMEOUT,
}

# Standard SOAP ack body — the only thing the inbound HTTP exchange
# ever returns. Content is identical regardless of inbound type
# (success, ack, or even server-side handler failure — Halotel just
# wants to know we received the inbound).
_SOAP_ACK_OK = (
    '<?xml version="1.0" encoding="utf-8"?>'
    '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">'
    '<soap:Body><ussdresponse><errorCode>0</errorCode></ussdresponse>'
    '</soap:Body></soap:Envelope>'
).encode("utf-8")

# Auth-failed ack — per spec errorCode=1 = "User/Pass/IP does not match".
_SOAP_ACK_AUTH = (
    '<?xml version="1.0" encoding="utf-8"?>'
    '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">'
    '<soap:Body><ussdresponse><errorCode>1</errorCode></ussdresponse>'
    '</soap:Body></soap:Envelope>'
).encode("utf-8")


def _xtext(parent: ET.Element, local_name: str) -> str:
    """Read text from <{tempuri}local_name> child, or empty string."""
    el = parent.find(f"t:{local_name}", _NS)
    if el is None or el.text is None:
        return ""
    return el.text.strip()


def _parse_soap(body: bytes) -> dict:
    """Pull the InsertMO fields out of a Halotel SOAP envelope.
    Raises HTTPException(400) for unparseable / wrong-root XML —
    the inbound is rejected without an ack (an aggregator-side bug,
    not a USSD-flow issue)."""
    if not body:
        raise HTTPException(400, "halotel: empty SOAP body")
    try:
        root = ET.fromstring(body)
    except ET.ParseError as exc:
        raise HTTPException(400, f"halotel: malformed XML: {exc}")

    body_el = root.find("soap:Body", _NS)
    if body_el is None:
        raise HTTPException(400, "halotel: missing soap:Body")

    insert_mo = body_el.find("t:InsertMO", _NS)
    if insert_mo is None:
        raise HTTPException(400, "halotel: missing InsertMO")

    return {
        "user":          _xtext(insert_mo, "user"),
        "pass":          _xtext(insert_mo, "pass"),
        "msisdn":        _xtext(insert_mo, "msisdn"),
        "msg":           _xtext(insert_mo, "msg"),
        "sessionid":     _xtext(insert_mo, "sessionid"),
        "transactionid": _xtext(insert_mo, "transactionid"),
        "requesttype":   _xtext(insert_mo, "requestType"),
        "ussdgw_id":     _xtext(insert_mo, "ussdgw_id"),
        # Captured for log attribution. Halotel sends this on every
        # leg; useful when troubleshooting subscriber-side issues
        # without exposing the MSISDN in cross-team logs.
        "imsi":          _xtext(insert_mo, "imsi"),
    }


def _outbound_request_type(inbound_type: str, action: Action) -> str:
    """Map (inbound requestType, handler reply action) → outbound type.
    Defaults bias toward CON=200/END=203 for unknown inbound types —
    safe degradation: subsequent menu is the more common case."""
    if inbound_type == "100":
        return "202" if action == Action.CON else "201"
    # 101 + anything else (defensive default)
    return "200" if action == Action.CON else "203"


def _build_outbound_envelope(
    *,
    out_user: str,
    out_pass: str,
    msisdn: str,
    msg: str,
    sessionid: str,
    transactionid: str,
    request_type: str,
    ussdgw_id: str,
) -> bytes:
    """Build the outbound SOAP body. ElementTree is used to handle
    XML escaping of `msg` (which can contain `<br>`, `&`, `<`, etc.
    that handlers may emit). The result is a byte string ready to
    POST.

    Per the spec example, `msisdn` and `sessionid` are sent as
    literal 'null' when absent — Halotel rejects empty elements.
    We send the actual values when we have them.

    `out_user` / `out_pass` are the credentials to echo back on the
    outbound POST. As of 2026-06-22 these are read off the inbound
    SOAP body (push_outbound pulls them from raw_payload), rather
    than from a fixed HALOTEL_OUTBOUND_USER/PASS env, so different
    shortcodes routed through the same gateway can carry different
    Halotel credentials. The env values are kept only as a defensive
    fallback when the inbound didn't include creds.
    """
    # Use ET in Clark-notation mode (`{ns}tag`) and let it auto-pick a
    # prefix; we then rewrite the prefix to `soap:` for spec-faithful
    # output. Do NOT also pre-declare `xmlns:soap` as an attribute —
    # that produces a duplicate-attribute XML (ET emits its own
    # xmlns:ns0=... which the replace step renames to xmlns:soap=...).
    env = ET.Element(f"{{{_SOAP_NS}}}Envelope")
    body = ET.SubElement(env, f"{{{_SOAP_NS}}}Body")
    insert_mo = ET.SubElement(body, "InsertMO", {"xmlns": _TEMPURI})

    def _add(tag: str, value: str) -> None:
        el = ET.SubElement(insert_mo, tag)
        el.text = value if value else "null"

    _add("user",          out_user)
    _add("pass",          out_pass)
    _add("msisdn",        msisdn)
    _add("msg",           msg or "")
    _add("sessionid",     sessionid)
    _add("transactionid", transactionid)
    _add("requestType",   request_type)
    _add("ussdgw_id",     ussdgw_id)

    # Rewrite ET's auto-prefix (`ns0`) → `soap` for spec faithfulness.
    raw = ET.tostring(env, encoding="utf-8", xml_declaration=True)
    raw = raw.replace(b"ns0:", b"soap:").replace(b"xmlns:ns0=", b"xmlns:soap=")
    # Halotel's USSDGW returns errorCode=1 ("User/Pass/IP does not
    # match") when our outbound envelope is missing the xsi + xsd
    # xmlns declarations the spec's example shows on <soap:Envelope>.
    # Observed 2026-06-22 — our menus reached the gateway pipeline,
    # the walker rendered correctly, but Halotel rejected delivery
    # back. The legacy walker (Utilities/Utilities.php createXMLSchema)
    # declares all three and consistently gets errorCode=0; mirror
    # that exactly.
    raw = raw.replace(
        b'<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">',
        b'<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"'
        b' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"'
        b' xmlns:xsd="http://www.w3.org/2001/XMLSchema">',
    )
    return raw


def _parse_outbound_ack(body_text: str) -> tuple[Optional[str], Optional[str]]:
    """Extract <errorCode> from Halotel's outbound ack. Returns
    (error_code_str, error_detail) — error_code is None if we
    couldn't find it (malformed response)."""
    if not body_text:
        return None, "empty body"
    try:
        root = ET.fromstring(body_text)
    except ET.ParseError as exc:
        return None, f"malformed XML: {exc}"
    # Halotel's response uses default namespace (no prefix on
    # ussdresponse / errorCode in the spec example). Try both
    # namespaced and unnamespaced lookup.
    for path in ("./soap:Body/ussdresponse/errorCode",
                 ".//{http://schemas.xmlsoap.org/soap/envelope/}Body/ussdresponse/errorCode",
                 ".//errorCode"):
        el = root.find(path, _NS)
        if el is not None and el.text is not None:
            return el.text.strip(), None
    return None, "errorCode element not found"


@register
class Halotel:
    operator = "halotel"
    is_async_outbound = True    # Halotel pushes menu on a separate HTTP call
    _operator_id: int = 0
    _settings = None            # cached HalotelConfig on first use

    def _cfg(self) -> HalotelConfig:
        if self._settings is None:
            self._settings = load_settings().halotel
        return self._settings

    def _resolve_operator_id(self) -> int:
        if self._operator_id:
            return self._operator_id
        with db._conn() as c, c.cursor() as cur:                       # noqa: SLF001
            cur.execute("SELECT id FROM operators WHERE name = %s",
                        (self.operator,))
            row = cur.fetchone()
            self._operator_id = int(row[0]) if row else 0
        return self._operator_id

    async def parse(self, req: Request) -> UnifiedRequest:
        body = await req.body()
        fields = _parse_soap(body)

        request_type = fields["requesttype"]
        event = _TYPE_EVENT_MAP.get(request_type)
        if event is None:
            raise HTTPException(400, f"halotel: unknown requestType={request_type!r}")

        # Per-shortcode credentials: Halotel sends the user/pass that
        # the SUBSCRIBER's destination expects, and the gateway must
        # echo those same credentials on the outbound POST back to
        # Halotel's USSDGW. Different shortcodes routed through the
        # same gateway can carry different creds, so we do NOT
        # validate against a single HALOTEL_INBOUND_USER/PASS env
        # var any more. Authentication is enforced at the network
        # edge instead (IP whitelist for Halotel's USSDGW source).
        #
        # The user/pass remain in raw_payload so push_outbound() can
        # pull them when building the outbound envelope. The pass is
        # redacted in the audit-row copy so it doesn't get persisted
        # in cleartext via log_leg.
        cfg = self._cfg()
        raw_for_log = dict(fields)
        raw_for_log["pass"] = "***" if fields["pass"] else ""

        sessionid = fields["sessionid"]
        transactionid = fields["transactionid"]
        if not transactionid:
            raise HTTPException(400, "halotel: missing transactionid")

        msisdn = fields["msisdn"]
        msg    = fields["msg"]
        op_id  = self._resolve_operator_id()

        # Build service_code + ussd_string per lifecycle.
        if event is SessionEvent.START:
            # msg IS the dialed code on type=100 (e.g. '*123#').
            # Normalise to canonical `*<digits>#` so a Halotel spec
            # deviation (missing '*' / '#', URL-encoded '%23') doesn't
            # break shortcode matching downstream. No-op for spec-
            # conformant traffic.
            from ._common import normalise_dialed
            service_code = normalise_dialed(msg)
            ussd_string = ""

            # Shortcut-in-initial-dial support: if a shortcode is
            # registered for a PREFIX of the canonical dial, route to
            # it and treat the suffix as the initial ussd_string.
            # E.g. *148*69*0666743790# dialed but only *148*69#
            # registered → route to *148*69#, ussd_string starts as
            # '0666743790'. No-op when no shorter prefix matches.
            prefix_match = db.lookup_shortcode_by_dial_prefix(
                op_id, service_code)
            if prefix_match is not None:
                service_code = prefix_match.code
                ussd_string  = prefix_match.remainder

            db.upsert_active_session(
                session_id=transactionid, operator_id=op_id,
                service_code=service_code, shortcode_id=None,
                msisdn=msisdn, ussd_string=ussd_string,
            )
        elif event is SessionEvent.INPUT:
            prior = db.get_active_session(transactionid, op_id)
            if prior is None:
                # Session lookup failed (cache evicted / never opened).
                # We can't recover service_code or msisdn here — both
                # default to empty and the handler / downstream logs
                # will surface the gap. Spec compliance still requires
                # we ack the inbound so Halotel doesn't keep retrying.
                service_code = ""
                ussd_string  = (msg or "").strip()
            else:
                service_code = prior.service_code
                # Halotel doesn't have a TZ-aggregator '*' menu trail
                # convention documented; handlers correlate by
                # transactionid + remember per-step state. We still
                # accumulate for log-line consistency.
                from ._common import accumulate_ussd_string
                ussd_string = accumulate_ussd_string(prior.ussd_string, msg)
                # Halotel ships an EMPTY <msisdn></msisdn> on every
                # leg after the opening 100. Recover from the cached
                # session BEFORE building UnifiedRequest so the
                # handler + outbound push see the real subscriber
                # number rather than an empty string.
                if not msisdn:
                    msisdn = prior.msisdn
                db.upsert_active_session(
                    session_id=transactionid, operator_id=op_id,
                    service_code=service_code,
                    shortcode_id=prior.shortcode_id,
                    msisdn=msisdn,
                    ussd_string=ussd_string,
                )
        else:
            # USER_CANCELLED / DELIVERY_ACK / TIMEOUT — read cached
            # service_code + msisdn for log attribution, no state
            # mutation. Halotel also omits msisdn on these legs.
            prior = db.get_active_session(transactionid, op_id)
            service_code = prior.service_code if prior else ""
            ussd_string  = prior.ussd_string  if prior else ""
            if prior is not None and not msisdn:
                msisdn = prior.msisdn

        return UnifiedRequest(
            operator=self.operator,
            msisdn=msisdn,
            session_id=transactionid,   # transactionid is our cross-leg key
            service_code=service_code,
            ussd_string=ussd_string,
            event=event,
            raw_payload=raw_for_log,
        )

    def render(self, reply: UnifiedReply) -> Response:
        # Inbound ack only — the menu content goes via push_outbound.
        # Auth-failed branch reads from a flag the pipeline carries
        # (we can't see ur here without changing the protocol);
        # render-with-auth-failed is wired up in main.py instead by
        # checking ur.raw_payload['_auth_ok'].
        return Response(content=_SOAP_ACK_OK,
                        media_type="text/xml; charset=utf-8")

    def render_auth_failed(self) -> Response:
        """Halotel-specific: ack with errorCode=1 when inbound creds
        don't match. Surfaced via the pipeline so it doesn't have
        to special-case adapter classes."""
        return Response(content=_SOAP_ACK_AUTH,
                        media_type="text/xml; charset=utf-8")

    async def push_outbound(self, ur: UnifiedRequest, reply: UnifiedReply) -> dict:
        """POST the menu/result back to Halotel's USSDGW. Returns a
        dict for logging (status, errorCode, elapsed_ms, body). On
        failure returns the dict with an `error` key — the caller
        (pipeline) logs but doesn't retry (USSD has no retry semantics
        within a session)."""
        cfg = self._cfg()
        if not cfg.outbound_url:
            LOGGER.warning(
                "halotel outbound disabled (HALOTEL_OUTBOUND_URL "
                "unset) — dropping push for transactionid=%s",
                ur.session_id,
            )
            return {"error": "outbound_unconfigured"}

        raw          = ur.raw_payload or {}
        inbound_type = raw.get("requesttype", "")
        out_type     = _outbound_request_type(inbound_type, reply.action)
        sessionid    = raw.get("sessionid", "")
        ussdgw_id    = raw.get("ussdgw_id", "") or cfg.ussdgw_id_default

        # Echo the inbound credentials on the outbound POST. Halotel's
        # USSDGW provisions per-shortcode user/pass, so we mirror
        # whatever it sent us rather than relying on a single env-var
        # pair. Fall back to HALOTEL_OUTBOUND_USER/PASS only when the
        # inbound carried nothing (defensive — shouldn't happen for
        # spec-conformant traffic).
        out_user = raw.get("user", "") or cfg.outbound_user
        out_pass = raw.get("pass", "") or cfg.outbound_pass
        if not out_user:
            LOGGER.warning(
                "halotel outbound has no user (inbound user empty + "
                "no HALOTEL_OUTBOUND_USER fallback) for "
                "transactionid=%s — pushing anyway; Halotel will "
                "likely reject with errorCode=1",
                ur.session_id,
            )

        envelope = _build_outbound_envelope(
            out_user=out_user,
            out_pass=out_pass,
            msisdn=ur.msisdn,
            msg=reply.message,
            sessionid=sessionid,
            transactionid=ur.session_id,
            request_type=out_type,
            ussdgw_id=ussdgw_id,
        )

        # Headers mirror the legacy Utilities.php sendUssdMenuResponse()
        # exactly: just Content-Type, no SOAPAction. Halotel's spec
        # doesn't require SOAPAction; legacy never sent it and got
        # errorCode=0 reliably, so we keep parity with that.
        headers = {
            "Content-Type": "text/xml; charset=utf-8",
        }
        try:
            async with httpx.AsyncClient(timeout=cfg.outbound_timeout_secs) as client:
                resp = await client.post(cfg.outbound_url, content=envelope, headers=headers)
        except httpx.TimeoutException as exc:
            LOGGER.warning("halotel outbound timeout transactionid=%s: %s",
                           ur.session_id, exc)
            return {"error": "timeout", "detail": str(exc)[:300]}
        except httpx.RequestError as exc:
            LOGGER.warning("halotel outbound transport error transactionid=%s: %s",
                           ur.session_id, exc)
            return {"error": "transport", "detail": str(exc)[:300]}

        body_text = resp.text or ""
        error_code, parse_err = _parse_outbound_ack(body_text)
        out: dict = {
            "status":         resp.status_code,
            "error_code":     error_code,
            "body":           body_text[:500],
            "requestType":    out_type,
        }
        if resp.status_code >= 400:
            out["error"] = "non2xx"
        elif error_code not in (None, "0"):
            out["error"] = f"halotel_errorcode_{error_code}"
        elif parse_err:
            out["error"] = "unparseable"
            out["detail"] = parse_err
        return out
