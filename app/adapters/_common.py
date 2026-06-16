"""Shared helpers used by per-MNO adapters.

Most adapters do the same three things:
  * read a small set of fields from query params (GET) and/or form
    body (POST), tolerating either source on Vodacom which speaks
    both;
  * normalise the MSISDN to bare-digits-with-leading-country-code
    ('+255...' → '255...');
  * render a plain-text "CON …"/"END …" response (or per-MNO XML).

Per-MNO modules override only the bits that differ (header names,
response Content-Type, JSON envelope, XML schema, etc.).
"""
from __future__ import annotations

import xml.etree.ElementTree as ET

from fastapi import HTTPException, Request, Response

from ..unified import Action, UnifiedReply


def normalise_msisdn(raw: str | None) -> str:
    """Strip leading '+' and whitespace. Empty -> empty (the caller
    decides whether absence is fatal)."""
    return (raw or "").lstrip("+").strip()


async def read_query_or_form(req: Request) -> dict:
    """Merge query string + form body into one dict (form wins on
    collision since it's the explicit payload). Falls back to JSON
    body when Content-Type is application/json. Lower-case keys for
    case-insensitive lookup downstream."""
    merged: dict[str, str] = {}
    for k, v in req.query_params.multi_items():
        merged[k.lower()] = v
    ctype = (req.headers.get("content-type") or "").lower()
    if "application/json" in ctype:
        try:
            j = await req.json()
            if isinstance(j, dict):
                for k, v in j.items():
                    if v is not None:
                        merged[str(k).lower()] = str(v)
        except Exception:
            pass
    elif "application/x-www-form-urlencoded" in ctype or "multipart/form-data" in ctype:
        form = await req.form()
        for k, v in form.multi_items():
            merged[str(k).lower()] = str(v)
    return merged


def require(d: dict, *keys: str) -> str:
    """First-non-empty lookup with HTTP 400 on miss. Adapters use
    this to declare 'one of these param names is required' tolerantly
    (Vodacom has historically renamed fields between versions)."""
    for k in keys:
        v = d.get(k.lower())
        if v not in (None, ""):
            return str(v)
    raise HTTPException(
        status_code=400,
        detail=f"missing required field; expected one of: {', '.join(keys)}",
    )


def optional(d: dict, *keys: str, default: str = "") -> str:
    for k in keys:
        v = d.get(k.lower())
        if v not in (None, ""):
            return str(v)
    return default


def plain_text_reply(reply: UnifiedReply) -> Response:
    """Standard MNO USSD response format: first line `CON <message>`
    or `END <message>`. Most TZ MNOs accept this; per-MNO override
    if a spec demands JSON/XML."""
    body = f"{reply.action.value} {reply.message}"
    return Response(content=body, media_type="text/plain; charset=utf-8")


def end_reply(message: str) -> Response:
    """Convenience for the gateway's own error paths (shortcode not
    configured, handler timed out, etc.)."""
    return plain_text_reply(UnifiedReply(action=Action.END, message=message))


# ---------- XML helpers (Vodacom TruRoute + similar MNOs) ----------

async def read_xml_body(req: Request) -> ET.Element:
    """Parse the request body as XML and return the root element.
    Raises 400 if the body is missing or malformed.

    Notes:
      * uses stdlib xml.etree.ElementTree (no extra deps).
      * XML is parsed as bytes to honour any declared encoding.
      * MNO XML is small (<2KB typically) — no streaming needed.

    XXE: stdlib ElementTree does NOT resolve external entities by
    default (since Python 3.7+), so we don't need defusedxml for the
    minimal `<ussd>…</ussd>` shape MNOs send. If a future MNO sends
    XML with DTDs / external entities, switch to defusedxml.
    """
    body = await req.body()
    if not body:
        raise HTTPException(400, "empty XML body")
    try:
        return ET.fromstring(body)
    except ET.ParseError as exc:
        raise HTTPException(400, f"malformed XML: {exc}")


def xtext(root: ET.Element, tag: str, default: str = "") -> str:
    """First-child-by-tag text, or default. Used to pull <msisdn>,
    <sessionid>, <type>, <msg> out of <ussd>…</ussd>."""
    el = root.find(tag)
    if el is None or el.text is None:
        return default
    return el.text.strip()


def xml_reply_truroute(reply: UnifiedReply, *, premium: dict | None = None) -> Response:
    """Render the TruRoute USSD XML response envelope:

        <ussd>
          <type>2|3|5</type>
          <msg>...</msg>
          [<premium><cost>C</cost><ref>R</ref></premium>]
        </ussd>

    Maps:
      reply.action == CON  →  <type>2</type>  (RESPONSE — keep open)
      reply.action == END  →  <type>3</type>  (RELEASE — close)

    REDIRECT (type 5) is not exposed in UnifiedReply yet — when a
    handler needs it, extend UnifiedReply with a `redirect_code` and
    branch here.

    `premium` is optional: pass {"cost": "10", "ref": "REF-123"} to
    add the <premium><cost>…</cost><ref>…</ref></premium> block per
    the TruRoute spec.
    """
    type_value = "2" if reply.action == Action.CON else "3"
    root = ET.Element("ussd")
    ET.SubElement(root, "type").text = type_value
    ET.SubElement(root, "msg").text  = reply.message or ""
    if premium:
        prem = ET.SubElement(root, "premium")
        ET.SubElement(prem, "cost").text = str(premium.get("cost", ""))
        ET.SubElement(prem, "ref").text  = str(premium.get("ref",  ""))
    body = ET.tostring(root, encoding="utf-8", xml_declaration=False)
    return Response(content=body, media_type="text/xml; charset=utf-8")


def accumulate_ussd_string(prior: str, new_input: str) -> str:
    """Append a new user input to the running menu trail.
    Empty new_input is a no-op (e.g. session-start has only the
    service_code, not a typed input). '*' is the conventional menu-
    level separator across TZ MNOs."""
    new_input = (new_input or "").strip()
    if not new_input:
        return prior or ""
    if not prior:
        return new_input
    return prior + "*" + new_input
