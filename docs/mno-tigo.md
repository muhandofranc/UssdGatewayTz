# Tigo (Yas) Tanzania — USSD MO wire

Source: live aggregator traffic captured 2026-05-29 (no formal
spec document yet). Update this file when Tigo's USSD MO spec
lands and reconcile any deltas.

## Inbound wire (MNO → gateway)

GET only. Tigo's aggregator pushes to a **per-partner URL**, all
sharing the trailing fragment `tigo`:

```
/ussd/glptigo/        — GLP (Game Lottery Partner)
/ussd/zolatigo/       — Zola
/ussd/kopagastigo/    — Kopagas
/ussd/tz411tigo/      — Tz411
```

Two parameter schemes are in concurrent use. Tigo's aggregator
team introduced them at different times and both are live; the
adapter sniffs by parameter presence (the param names lower-case
to the same keys via [`read_query_or_form`](../app/adapters/_common.py)).

### Scheme A — used by glptigo, zolatigo

```
MSISDN, Session_id, NEW_REQUEST, Ussd_string, Service_cod
```

| Leg | `NEW_REQUEST` | `Ussd_string`                     | `Service_cod`                  |
|-----|---------------|-----------------------------------|--------------------------------|
| 1st | `1`           | the dialed code (e.g. `*148*43`)  | _absent_                       |
| nth | `0`           | the user's input on this leg      | Tigo-internal partner ID       |

`Service_cod` is **not** the dialed code — it's a stable per-partner
identifier (`191` for glptigo, `1500` for zolatigo) used by Tigo's
aggregator internally. The gateway logs it via `raw_payload` but
does not route on it.

### Scheme B — used by kopagastigo, tz411tigo

```
input, sessionid, msisdn, IMSI, newrequest, SHORT_CODE
```

| Leg | `newrequest` | `input`                       | `SHORT_CODE`              |
|-----|--------------|-------------------------------|---------------------------|
| 1st | `1`          | echo of the dialed-code tail  | the dialed code (e.g. `*148*33`) |
| nth | `0`          | the user's input              | the dialed code (every leg)      |

`IMSI` is informational only — captured in `raw_payload` for the
log row, not used by the routing pipeline.

### Lifecycle mapping

The live wire shows **only START and INPUT**. No cancel / timeout /
charge-failed events have been observed.

| Wire value           | Gateway `SessionEvent` |
|----------------------|------------------------|
| `NEW_REQUEST=1` / `newrequest=1` | `START` |
| `NEW_REQUEST=0` / `newrequest=0` | `INPUT` |

If Tigo grows terminal events later, extend `_is_new_request()` and
add the new types to the lifecycle map in
[`app/adapters/tigo.py`](../app/adapters/tigo.py).

## Outbound wire (gateway → MNO)

Plain text, `Content-Type: text/plain; charset=utf-8`. Format
matches the canonical USSD aggregator convention:

```
CON <message>      → keep session open
END <message>      → close session
```

Tigo's response-shape spec (FREETEXT/CONTINUE markers, max
message bytes, character set restrictions) is **not yet
confirmed** — verify against the formal Tigo USSD doc when it
lands. Replace `plain_text_reply()` in `render()` with a Tigo-
specific renderer if the wire format differs.

## Routing model

The URL **partner slug** (e.g. `glptigo`, `kopagastigo`) is used
as the gateway's `service_code` for the `shortcodes` table lookup.
This is what Tigo's aggregator already routed on — preserving it
means:

* no cross-leg recovery needed for routing (Scheme A subsequent
  legs don't carry the dialed code; the partner slug is in the URL
  on every leg);
* one `shortcodes` row per partner, regardless of how many dialed
  codes the partner owns;
* the dialed USSD (e.g. `*148*43`) travels to the handler in
  `raw_payload["dialed_code"]`, so handlers that route internally
  by dialed code can still do so.

## Handler contract (per-partner JSON)

The unified handler payload — identical shape to the other MNOs:

```json
{
  "operator":     "tigo",
  "msisdn":       "255710223275",
  "session_id":   "4039606112113368",
  "service_code": "glptigo",
  "ussd_string":  "1*7",
  "event":        "start" | "input",
  "raw_payload":  {
    "msisdn":      "255710223275",
    "session_id":  "4039606112113368",
    "new_request": "1",
    "ussd_string": "*148*43",
    "dialed_code": "*148*43"
  }
}
```

For Scheme B requests, `raw_payload` additionally carries `imsi`,
`short_code`, and the lowercased `input` key.

## Onboarding a Tigo partner

Tigo's USSD ops team configures the partner URL on their side
(e.g. `https://gateway.example/ussd/glptigo/`). On our side, one
row per partner in `shortcodes`:

```sql
INSERT INTO shortcodes (operator_id, code, owner_user_id,
                        handler_url, auth_mode, bearer_token,
                        timeout_secs, active)
SELECT o.id, 'glptigo',
       (SELECT id FROM portal_users WHERE email = 'ops@glp.example'),
       'https://glp.example.com/ussd', 'bearer', 'redacted-token',
       5, TRUE
  FROM operators o WHERE o.name = 'tigo';
```

The `code` column holds the partner slug (matching what comes after
`/ussd/` in the Tigo-side URL config), NOT the dialed USSD.

## Implementation map

| Concern                         | Location |
|---------------------------------|----------|
| Scheme sniff + lifecycle map    | [`app/adapters/tigo.py`](../app/adapters/tigo.py) `_is_new_request`, `_dialed_code`, `_user_input` |
| Partner slug from URL           | [`app/adapters/tigo.py`](../app/adapters/tigo.py) `_partner_slug_from_path` |
| Wildcard route + suffix dispatch | [`app/main.py`](../app/main.py) `_dispatch_partner_slug`, `ussd_partner_slug_slash`, `ussd_partner_slug_noslash` |
| Session cache (slug + ussd_string) | [`app/db.py`](../app/db.py) `upsert_active_session` / `get_active_session` |
| Plain-text reply                | [`app/adapters/_common.py`](../app/adapters/_common.py) `plain_text_reply` |

## Smoke (against the bundled echo handler)

```bash
# Scheme A — first leg + input + further input
curl -sS 'http://localhost:8080/ussd/glptigo/?MSISDN=255710223275&Session_id=SMOKE-A&NEW_REQUEST=1&Ussd_string=*148*43'
curl -sS 'http://localhost:8080/ussd/glptigo/?MSISDN=255710223275&Session_id=SMOKE-A&NEW_REQUEST=0&Ussd_string=1&Service_cod=191'
curl -sS 'http://localhost:8080/ussd/glptigo/?MSISDN=255710223275&Session_id=SMOKE-A&NEW_REQUEST=0&Ussd_string=7&Service_cod=191'

# Scheme B — first leg + input
curl -sS 'http://localhost:8080/ussd/kopagastigo/?input=148*33&sessionid=SMOKE-B&msisdn=255656560679&IMSI=640021174819835&newrequest=1&SHORT_CODE=*148*33'
curl -sS 'http://localhost:8080/ussd/kopagastigo/?input=2&sessionid=SMOKE-B&msisdn=255656560679&IMSI=640021174819835&newrequest=0&SHORT_CODE=*148*33'
```

Each call returns `CON …` / `END …` on the wire.

## Open questions to confirm with Tigo

1. **Terminal events.** Does the aggregator notify on user
   cancel / session timeout / charge failure? If yes, what
   parameter signals them?
2. **Outbound shape.** Plain `CON|END <msg>` confirmed, or does
   Tigo expect a different convention (FREETEXT marker, JSON,
   XML)?
3. **Max message length.** USSD line cap (160? 182? per-handset?)
4. **Character set.** GSM-7 only, or UCS-2 supported for special
   characters?
5. **Authoritative partner-URL list.** Beyond glptigo / zolatigo /
   kopagastigo / tz411tigo, are there other suffixes already in
   production or planned?
