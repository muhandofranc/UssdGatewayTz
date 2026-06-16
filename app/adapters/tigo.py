"""Tigo (Yas) Tanzania USSD adapter — GET-only, multi-partner.

Wire shape observed in production
---------------------------------

Tigo's USSD aggregator pushes per-partner — each WASP/reseller has
a dedicated URL path, all sharing the trailing fragment "tigo" so
we can route them through one adapter:

    /ussd/glptigo/        (Game Lottery Partner)
    /ussd/zolatigo/       (Zola)
    /ussd/kopagastigo/    (Kopagas)
    /ussd/tz411tigo/      (Tz 411)

Two parameter schemes are in concurrent use depending on the partner
(introduced at different times by Tigo's aggregator team; both are
in active production):

  Scheme A (used by glptigo, zolatigo):
      MSISDN, Session_id, NEW_REQUEST, Ussd_string, Service_cod

        NEW_REQUEST=1  →  first leg.
                          Ussd_string = the dialed code (e.g. '*148*43').
                          Service_cod absent.
        NEW_REQUEST=0  →  subsequent leg.
                          Ussd_string = the user's input on this leg.
                          Service_cod = Tigo-internal partner service
                          ID (191 for glptigo, 1500 for zolatigo) —
                          stable per partner, NOT the dialed code.

  Scheme B (used by kopagastigo, tz411tigo):
      input, sessionid, msisdn, IMSI, newrequest, SHORT_CODE

        newrequest=1  →  first leg.
                         input echoes the dialed-code tail.
                         SHORT_CODE = the dialed code.
        newrequest=0  →  subsequent leg.
                         input = user's input.
                         SHORT_CODE = the dialed code (every leg).

`read_query_or_form()` lowercases keys so case differences between
the two schemes ("MSISDN" vs "msisdn", "NEW_REQUEST" vs "newrequest")
don't matter to lookups.

No terminal events (cancel / timeout / charge-failed) have been seen
in the observed wire. If they appear later, extend the lifecycle
mapping below.

Routing model
-------------

The URL partner slug is what disambiguates handlers — Tigo's
aggregator already routed on it, and we preserve the decision.
The slug is used as the gateway's `service_code` for the shortcodes
table lookup, one row per partner:

    code='glptigo',     handler_url='https://glp.example/ussd',  ...
    code='zolatigo',    handler_url='https://zola.example/ussd', ...
    code='kopagastigo', handler_url='https://kopagas.example/ussd', ...

The user-dialed USSD (e.g. `*148*43`) is preserved in
`raw_payload["dialed_code"]` and cached on the session row, so any
handler that needs it on subsequent legs can read either.
"""
from __future__ import annotations

from fastapi import HTTPException, Request, Response

from .. import db
from ..unified import SessionEvent, UnifiedReply, UnifiedRequest
from . import register
from ._common import (
    accumulate_ussd_string, normalise_msisdn, plain_text_reply,
    read_query_or_form,
)


def _is_new_request(d: dict) -> bool:
    """True for the START leg. Both schemes use a 1/0 flag; the
    parameter name differs only in case + underscore placement,
    which read_query_or_form has already normalised."""
    raw = (d.get("new_request") or d.get("newrequest") or "").strip()
    return raw in ("1", "true", "yes", "y")


def _partner_slug_from_path(req: Request) -> str:
    """The URL path segment after /ussd/. The wildcard route in
    main.py captures this as path-param 'partner_slug'. If the
    request reached the canonical /ussd/tigo entry instead (test /
    manual), we return the literal 'tigo' (caller falls back to the
    in-payload SHORT_CODE)."""
    slug = (req.path_params.get("partner_slug") or "").strip().lower()
    return slug or "tigo"


def _dialed_code(d: dict, is_new: bool) -> str:
    """Pull the dialed USSD code from whichever scheme is in play.
    Scheme B always carries it in SHORT_CODE; Scheme A only on the
    first leg (in Ussd_string). Subsequent Scheme A legs have no
    dialed-code on the wire — caller recovers from session cache."""
    sc = (d.get("short_code") or "").strip()
    if sc:
        return sc
    if is_new:
        return (d.get("ussd_string") or "").strip()
    return ""


def _user_input(d: dict, is_new: bool) -> str:
    """The user's input on THIS leg. On START there's no real user
    input yet (both schemes echo the dialed code in input/Ussd_string)
    so we return empty; handlers see ussd_string='' on START."""
    if is_new:
        return ""
    return (d.get("input") or d.get("ussd_string") or "").strip()


@register
class Tigo:
    operator = "tigo"
    is_async_outbound = False    # synchronous — plain text reply rides the inbound response
    _operator_id: int = 0

    def _resolve_operator_id(self) -> int:
        if self._operator_id:
            return self._operator_id
        with db._conn() as c, c.cursor() as cur:                       # noqa: SLF001 — adapter-local helper use
            cur.execute("SELECT id FROM operators WHERE name = %s",
                        (self.operator,))
            row = cur.fetchone()
            self._operator_id = int(row[0]) if row else 0
        return self._operator_id

    async def parse(self, req: Request) -> UnifiedRequest:
        d = await read_query_or_form(req)

        # Both schemes carry msisdn + session id under variants that
        # lowercase to the same keys: 'msisdn' and 'sessionid' OR
        # 'session_id'. Reject early if either is missing — that's
        # an aggregator-side bug, not a USSD-flow concern.
        msisdn_raw = d.get("msisdn")
        sessionid  = d.get("sessionid") or d.get("session_id")
        if not msisdn_raw:
            raise HTTPException(400, "tigo: missing msisdn")
        if not sessionid:
            raise HTTPException(400, "tigo: missing sessionid / Session_id")

        is_new  = _is_new_request(d)
        event   = SessionEvent.START if is_new else SessionEvent.INPUT
        msisdn  = normalise_msisdn(msisdn_raw)
        slug    = _partner_slug_from_path(req)
        op_id   = self._resolve_operator_id()
        dialed  = _dialed_code(d, is_new)
        user_in = _user_input(d, is_new)

        # Expose the dialed code via raw_payload so handlers always
        # have it — independent of which leg / scheme we received.
        if dialed:
            d["dialed_code"] = dialed

        if event is SessionEvent.START:
            # First leg: open the session cache row so subsequent
            # legs can recover both the partner slug (in case the
            # wildcard route ever serves a stale URL) and the dialed
            # code. We cache the SLUG in service_code (because slug
            # is what we look up in shortcodes), and stash the dialed
            # form on msisdn-shaped fields... actually we keep dialed
            # in ussd_string=''+session-row-extra: no, the
            # ussd_active_sessions table only has one cached
            # service_code column. Store the slug there. Dialed lives
            # in raw_payload on every leg.
            db.upsert_active_session(
                session_id=sessionid, operator_id=op_id,
                service_code=slug, shortcode_id=None,
                msisdn=msisdn, ussd_string="",
            )
            ussd_string = ""
        else:
            prior = db.get_active_session(sessionid, op_id)
            if prior is None:
                # Lost session state (sweeper ran, retry races first
                # leg, etc). Fall back to the URL slug for routing;
                # this leg's input is the start of the menu trail.
                ussd_string = user_in
            else:
                # Subsequent leg: accumulate inputs with '*' separator
                # and refresh last_seen_at. Prefer the cached slug
                # (set at START) so a partial-URL anomaly mid-session
                # can't drift our routing.
                ussd_string = accumulate_ussd_string(prior.ussd_string, user_in)
                db.upsert_active_session(
                    session_id=sessionid, operator_id=op_id,
                    service_code=prior.service_code or slug,
                    shortcode_id=prior.shortcode_id,
                    msisdn=msisdn or prior.msisdn,
                    ussd_string=ussd_string,
                )
                slug = prior.service_code or slug

        return UnifiedRequest(
            operator=self.operator,
            msisdn=msisdn,
            session_id=sessionid,
            service_code=slug,         # partner slug → shortcodes lookup key
            ussd_string=ussd_string,
            event=event,
            raw_payload=d,
        )

    def render(self, reply: UnifiedReply) -> Response:
        # Tigo aggregator accepts plain text. Full response-shape
        # spec (FREETEXT marker, CON/END convention, max-msg bytes)
        # pending — confirm against Tigo's USSD doc when it lands.
        return plain_text_reply(reply)
