"""Vodacom Tanzania USSD adapter — TruRoute (TruTeq) XML interface.

Spec: TruRoute USSD XML Interface, TruTeq Wireless (Pty) Ltd, v1.3
(2010). Vodacom TZ rides on TruRoute infrastructure.

Wire shapes
-----------

INBOUND (MNO → us):

  HTTP POST  Content-Type: text/xml
  Body:
      <ussd>
        <msisdn>27829991234</msisdn>          (international, no '+')
        <sessionid>S</sessionid>
        <type>T</type>                          (1|2|3|4|10)
        <msg>MSG</msg>
      </ussd>

  HTTP GET (alternative — Vodacom supports both):
      /ussd/vodacom?msisdn=M&sessionid=S&type=T&msg=MSG

  `type` values (TruRoute spec):
      1  REQUEST   — first leg, msg IS the dialed service code (e.g. '*123#')
      2  RESPONSE  — subsequent leg, msg is the user's input text
      3  RELEASE   — user cancelled the session
      4  TIMEOUT   — MNO timed the session out
     10  CHARGE    — premium-rate charge attempt failed; msg is the reason

OUTBOUND (us → MNO):

  HTTP 200  Content-Type: text/xml
  Body:
      <ussd>
        <type>2|3|5</type>      (RESPONSE / RELEASE / REDIRECT)
        <msg>MSG</msg>
        [<premium><cost>C</cost><ref>R</ref></premium>]
      </ussd>

  Response types:
      2  RESPONSE  — keep session open  (UnifiedReply action=CON)
      3  RELEASE   — close session       (UnifiedReply action=END)
      5  REDIRECT  — re-route to another WASP (NOT YET exposed in
                     UnifiedReply; add `redirect_service_code` and
                     branch in xml_reply_truroute when a handler
                     needs it)

Session-state contract
----------------------

TruRoute only sends the service_code on type=1. Subsequent legs
(type=2) carry just the user's latest input. To route every leg by
service_code AND to give handlers the menu-trail context they need,
the adapter uses the `ussd_active_sessions` table:

  type=1 (START)  →  INSERT (session_id, op, service_code, msisdn,
                              ussd_string="")
  type=2 (INPUT)  →  SELECT for service_code + accumulated ussd_string;
                     append msg to ussd_string; UPSERT (refresh
                     last_seen_at)
  type=3 (CANCEL) →  DELETE row; no handler call; ack with empty
                     <type>3</type><msg></msg>
  type=4 (TIMEOUT) → same as type=3
  type=10 (CHARGE) → same as type=3 (premium-charge failure;
                     informational — handler can be notified later
                     via the dashboard if it cares)

Side note on log atomicity: the upsert happens BEFORE the handler
call. If the handler dies mid-flight, the active-session row is
still there for the next leg / for the sweeper to clean. The
ussd_session_logs row is written AFTER the handler reply so it
carries the handler outcome.
"""
from __future__ import annotations

from fastapi import HTTPException, Request, Response

from .. import db
from ..unified import SessionEvent, UnifiedReply, UnifiedRequest
from . import register
from ._common import (
    accumulate_ussd_string, normalise_dialed, normalise_msisdn,
    read_query_or_form,
    read_xml_body, xml_reply_truroute, xtext,
)

# TruRoute type → SessionEvent map
_TYPE_EVENT_MAP: dict[str, SessionEvent] = {
    "1":  SessionEvent.START,
    "2":  SessionEvent.INPUT,
    "3":  SessionEvent.USER_CANCELLED,
    "4":  SessionEvent.TIMEOUT,
    "10": SessionEvent.CHARGE_FAILED,
}


async def _parse_fields(req: Request) -> tuple[str, str, str, str, dict]:
    """Pull (msisdn, sessionid, type, msg, raw_payload) from the
    request — XML POST or query GET. The XML branch fires when the
    Content-Type is text/xml or application/xml (TruRoute uses
    text/xml per spec); everything else falls through to the
    query/form parser."""
    ctype = (req.headers.get("content-type") or "").lower()
    if "xml" in ctype:
        root = await read_xml_body(req)
        if root.tag != "ussd":
            raise HTTPException(400, f"expected <ussd> root, got <{root.tag}>")
        d_raw = {
            "msisdn":    xtext(root, "msisdn"),
            "sessionid": xtext(root, "sessionid"),
            "type":      xtext(root, "type"),
            "msg":       xtext(root, "msg"),
        }
        msisdn    = d_raw["msisdn"]
        sessionid = d_raw["sessionid"]
        truroute_type = d_raw["type"]
        msg       = d_raw["msg"]
    else:
        d_raw = await read_query_or_form(req)
        msisdn    = d_raw.get("msisdn", "")
        sessionid = d_raw.get("sessionid", "")
        truroute_type = d_raw.get("type", "")
        msg       = d_raw.get("msg", "")

    # Mandatory-field validation. TruRoute spec lists all four as
    # required on every request; missing one is an MNO-side bug or
    # spoofed traffic and we reject with 400.
    missing = [k for k, v in
               (("msisdn", msisdn), ("sessionid", sessionid), ("type", truroute_type))
               if not v]
    if missing:
        raise HTTPException(400, f"missing required TruRoute field(s): {', '.join(missing)}")
    return msisdn, sessionid, truroute_type, msg, d_raw


@register
class Vodacom:
    operator = "vodacom"
    is_async_outbound = False    # synchronous — XML reply rides the inbound response
    # Vodacom-TZ operator_id in the DB. Cached on first lookup (saves
    # one query per leg). 0 = uncached; resolved lazily.
    _operator_id: int = 0

    def _resolve_operator_id(self) -> int:
        if self._operator_id:
            return self._operator_id
        # The operators table is small (4 rows) and stable, so a
        # single SELECT here is fine. Could be moved to startup
        # cache (Phase 4). For now: lazy, one-shot.
        with db._conn() as c, c.cursor() as cur:                       # noqa: SLF001 — small adapter, OK to use the private helper
            cur.execute("SELECT id FROM operators WHERE name = %s",
                        (self.operator,))
            row = cur.fetchone()
            self._operator_id = int(row[0]) if row else 0
        return self._operator_id

    async def parse(self, req: Request) -> UnifiedRequest:
        msisdn_raw, sessionid, truroute_type, msg, raw = await _parse_fields(req)
        event = _TYPE_EVENT_MAP.get(truroute_type)
        if event is None:
            raise HTTPException(400, f"unknown TruRoute type={truroute_type!r}")

        msisdn = normalise_msisdn(msisdn_raw)
        op_id  = self._resolve_operator_id()
        # Only set on terminal legs (see below) — the pipeline resolves
        # the shortcode itself on START/INPUT legs and uses that id.
        shortcode_id = None

        if event is SessionEvent.START:
            # First leg: msg IS the dialed service code. Open a
            # session-state row so subsequent legs can resolve it.
            # Normalise to canonical `*<digits>#` so a TruRoute spec
            # deviation (missing '*' / '#', URL-encoded '%23') doesn't
            # break shortcode matching downstream. No-op for spec-
            # conformant traffic.
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
                session_id=sessionid, operator_id=op_id,
                service_code=service_code, shortcode_id=None,
                msisdn=msisdn, ussd_string=ussd_string,
            )
        elif event is SessionEvent.INPUT:
            # Subsequent leg: look up service_code + the prior trail,
            # append this leg's msg to it, and refresh the row.
            prior = db.get_active_session(sessionid, op_id)
            if prior is None:
                # Lost session state (sweeper ran, cache miss, MNO
                # delivered type=2 before type=1 due to retransmit,
                # etc). Best effort: treat msg as the menu trail but
                # we have no service_code so the pipeline will END
                # with "Service not configured" — log that condition.
                service_code = ""
                ussd_string  = (msg or "").strip()
            else:
                service_code = prior.service_code
                ussd_string  = accumulate_ussd_string(prior.ussd_string, msg)
                db.upsert_active_session(
                    session_id=sessionid, operator_id=op_id,
                    service_code=service_code, shortcode_id=prior.shortcode_id,
                    msisdn=msisdn or prior.msisdn, ussd_string=ussd_string,
                )
        else:
            # Terminal event (USER_CANCELLED / TIMEOUT / CHARGE_FAILED).
            # Look up the prior session for service_code so the log row
            # is attributable; then the pipeline will expire it.
            prior = db.get_active_session(sessionid, op_id)
            service_code = (prior.service_code if prior else "")
            ussd_string  = (prior.ussd_string  if prior else (msg or ""))
            # Carry the cached shortcode id so the terminal log row is
            # attributable — the pipeline short-circuits terminal events
            # before it would otherwise resolve the shortcode.
            shortcode_id = prior.shortcode_id if prior else None

        return UnifiedRequest(
            operator=self.operator,
            msisdn=msisdn,
            session_id=sessionid,
            service_code=service_code,
            ussd_string=ussd_string,
            event=event,
            raw_payload=raw,
            shortcode_id=shortcode_id,
        )

    def render(self, reply: UnifiedReply) -> Response:
        # TruRoute spec mandates XML. Premium-charge support is the
        # one extension point not yet wired into UnifiedReply — add
        # `premium={"cost":..., "ref":...}` here when the handler
        # contract grows to carry it.
        return xml_reply_truroute(reply)
