"""Airtel Tanzania USSD adapter — GET-only, multi-partner.

Wire shape observed in production
---------------------------------

Airtel's USSD aggregator pushes per-partner, like Tigo, but with a
much leaner parameter set. Live URL examples:

    /ussd/glpair/         (GLP — Game Lottery Partner)

Each partner gets a dedicated URL path ending in `air` (Airtel's
naming convention). Future partners are expected to follow the
`<partner>air` slug pattern.

Parameters (GET only):

    input      — user-typed string OR (on the first leg) the dialed
                 code WITHOUT the leading '*' and trailing '#'
                 (e.g. '147*03' for *147*03#).
    sessionid  — Airtel-issued session id.
    msisdn     — international, no leading '+' (e.g. '255780995191').

NOTHING else. Specifically: no NEW_REQUEST flag, no SHORT_CODE, no
IMSI. So distinguishing the START leg from subsequent INPUT legs
cannot be done from the wire alone — we use session-cache presence
as the discriminator:

    cache MISS for (session_id, operator_id)  →  START
                   (input is treated as the dialed code)
    cache HIT                                 →  INPUT
                   (input is treated as the user's typed text)

Cache-miss-during-session caveats (deliberate trade-offs):

  * Sweeper / restart mid-session: a genuine INPUT leg may be
    misclassified as START. The URL partner slug is still the
    routing key, so the request still reaches the right handler
    — just with event='start' and a fresh ussd_string. The
    handler will likely refuse and END gracefully.
  * Retransmits of the START leg (aggregator-side retry of an
    unacknowledged leg): the second arrival is a cache HIT and
    therefore classified as INPUT, with the dialed code echoed
    into ussd_string ('147*03*147*03'). Cosmetic glitch in the
    trail; handler logic is unaffected.

If either becomes a real problem, gate START detection on an
input-shape heuristic (`'*' in input` ⇒ likely-dialed-code) as
a secondary signal.

Routing model
-------------

Same as Tigo: the URL partner slug (e.g. `glpair`) is the
`service_code` used for `shortcodes` lookup. One row per partner:

    code='glpair', handler_url='https://glp.example/ussd', ...

The actual dialed USSD (e.g. `*147*03#`) is carried in
`raw_payload["dialed_code"]` on the START leg only — subsequent
legs don't carry it on the wire and we don't cache it as a
separate field (handlers correlate by session_id and remember
their own context).

Lifecycle
---------

No terminal events have been observed (cancel / timeout /
charge-failed). Extend `parse()` if the aggregator starts sending
them.

Suffix routing collision
------------------------

The wildcard route in main.py dispatches `*air` → airtel. This
risks misroute if a future MNO partner has a slug that
incidentally ends in "air" (e.g. "pair", "stair"). Current
live traffic uses only `glpair`; reassess if more partners
onboard with non-`air-suffix` slugs that still belong to Airtel,
or if a non-Airtel slug starts ending in `air`.
"""
from __future__ import annotations

from fastapi import HTTPException, Request, Response

from .. import db
from ..unified import SessionEvent, UnifiedReply, UnifiedRequest
from . import register
from ._common import (
    accumulate_ussd_string, normalise_dialed, normalise_msisdn,
    plain_text_reply, read_query_or_form,
)


def _partner_slug_from_path(req: Request) -> str:
    """The URL path segment after /ussd/. The wildcard route in
    main.py captures this as 'partner_slug'. Fall back to 'airtel'
    when the canonical /ussd/airtel entry was hit (test / manual)."""
    slug = (req.path_params.get("partner_slug") or "").strip().lower()
    return slug or "airtel"


@register
class Airtel:
    operator = "airtel"
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

        msisdn_raw = d.get("msisdn")
        sessionid  = d.get("sessionid")
        input_str  = (d.get("input") or "").strip()

        if not msisdn_raw:
            raise HTTPException(400, "airtel: missing msisdn")
        if not sessionid:
            raise HTTPException(400, "airtel: missing sessionid")
        # `input` may legitimately be empty on a rare aggregator-side
        # quirk; we accept it (becomes a no-op accumulate). Don't
        # raise — keep the customer's session alive.

        msisdn  = normalise_msisdn(msisdn_raw)
        slug    = _partner_slug_from_path(req)
        op_id   = self._resolve_operator_id()
        prior   = db.get_active_session(sessionid, op_id)

        if prior is None:
            # START — first time we see this session id.
            event   = SessionEvent.START
            dialed  = normalise_dialed(input_str)
            d["dialed_code"] = dialed

            # Shortcut-in-initial-dial support: if a shortcode is
            # registered for a PREFIX of the canonical dial, route to
            # it and treat the suffix as the initial ussd_string.
            # E.g. subscriber dials *148*69*0666743790# but only
            # *148*69# is registered → route to *148*69#, ussd_string
            # starts as '0666743790' on the very first leg.
            #
            # Precedence: dial-code match wins over the URL slug.
            # Falls back to slug-based routing (existing behaviour for
            # partner-slug registrations like 'airfun') when no
            # canonical match exists.
            ussd_string = ""
            prefix_match = db.lookup_shortcode_by_dial_prefix(op_id, dialed)
            if prefix_match is not None:
                slug = prefix_match.code
                ussd_string = prefix_match.remainder

            db.upsert_active_session(
                session_id=sessionid, operator_id=op_id,
                service_code=slug, shortcode_id=None,
                msisdn=msisdn, ussd_string=ussd_string,
            )
        else:
            # INPUT — accumulate the user's input onto the running
            # menu trail. Routing slug stays anchored to whatever was
            # cached at START so a partial-URL anomaly mid-session
            # can't drift our handler choice.
            event = SessionEvent.INPUT
            ussd_string = accumulate_ussd_string(prior.ussd_string, input_str)
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
        # Airtel aggregator accepts plain text. Exact wire format
        # (FREETEXT marker, max bytes, charset) pending — confirm
        # against Airtel's USSD MO spec when it lands. 'CON …' /
        # 'END …' is the canonical fallback.
        return plain_text_reply(reply)
