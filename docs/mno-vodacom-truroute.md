# Vodacom Tanzania — TruRoute (TruTeq) USSD XML interface

Source spec: *TruRoute USSD XML Interface*, TruTeq Wireless (Pty) Ltd,
v1.3 (14 June 2010). Vodacom TZ rides on TruRoute infrastructure.

## Wire shapes

### Inbound (MNO → gateway)

Both HTTP POST (XML body) and HTTP GET (query string) are supported
by the gateway. The MNO is free to use either; the
`adapters/vodacom.py` `_parse_fields` helper sniffs `Content-Type`.

**POST** — `Content-Type: text/xml`

```xml
<ussd>
  <msisdn>27829991234</msisdn>     <!-- international, NO leading '+' -->
  <sessionid>S</sessionid>
  <type>T</type>                     <!-- 1 | 2 | 3 | 4 | 10 -->
  <msg>MSG</msg>
</ussd>
```

**GET**

```
/ussd/vodacom?msisdn=M&sessionid=S&type=T&msg=MSG
```

### Outbound (gateway → MNO) — XML only

```xml
<ussd>
  <type>2|3|5</type>
  <msg>MSG</msg>
  <premium>                         <!-- optional, premium charging -->
    <cost>C</cost>
    <ref>R</ref>
  </premium>
</ussd>
```

`Content-Type: text/xml; charset=utf-8`. Phase 2 ships the `<msg>` +
`<type>` envelope only; `<premium>` is plumbed in
`xml_reply_truroute(reply, premium={...})` but not yet wired into
`UnifiedReply` — extend that dataclass when a handler needs
premium charging.

## Type-code mapping

| Wire `type` | Direction | TruRoute name | Gateway `SessionEvent` | Notes |
|---:|---|---|---|---|
| `1`  | inbound  | REQUEST  | `START`           | `msg` carries the dialed service code (e.g. `*123#`). |
| `2`  | inbound  | RESPONSE | `INPUT`           | `msg` is the user's input text for this leg. |
| `3`  | inbound  | RELEASE  | `USER_CANCELLED`  | Terminal — gateway expires session, ACKs with empty `<type>3</type>`. |
| `4`  | inbound  | TIMEOUT  | `TIMEOUT`         | Terminal — same handling as RELEASE. |
| `10` | inbound  | CHARGE   | `CHARGE_FAILED`   | Premium-charge failure notification. Terminal. |
| `2`  | outbound | RESPONSE | `Action.CON`      | Keep session open. |
| `3`  | outbound | RELEASE  | `Action.END`      | Close session. |
| `5`  | outbound | REDIRECT | _not yet exposed_ | Reroute to another service code. Extend `UnifiedReply` with `redirect_service_code` when a handler needs it. |

## Session state

TruRoute only sends the dialed service code on `type=1`. Subsequent
legs (`type=2`) carry only the user's input. The gateway maintains
the missing context in `ussd_active_sessions`:

| Event | Session-state action |
|---|---|
| `START`          | INSERT row keyed by `(session_id, operator_id)`. Stores `service_code` from the type=1 `msg`. `ussd_string` initialised empty. |
| `INPUT`          | SELECT row → grab cached `service_code` + prior `ussd_string`; append this leg's `msg` (with `*` separator); UPSERT to refresh `last_seen_at`. |
| `USER_CANCELLED` / `TIMEOUT` / `CHARGE_FAILED` | DELETE row. Pipeline short-circuits — no handler call. |
| Handler returns `END` | DELETE row (session is over). |

The sweeper (Phase 4 cron) removes rows whose `last_seen_at` is
older than 10 minutes, defending against stuck sessions if a type=3
or `END` is ever dropped.

## Handler contract (what an external client sees)

The gateway forwards a unified JSON POST to the configured
`handler_url`:

```json
{
  "operator":     "vodacom",
  "msisdn":       "27829991234",
  "session_id":   "S123",
  "service_code": "*123#",
  "ussd_string":  "1*2",
  "event":        "start" | "input",
  "raw_payload":  { "msisdn": "...", "sessionid": "...", "type": "1", "msg": "*123#" }
}
```

Handler replies with either JSON

```json
{ "action": "CON" | "END", "message": "..." }
```

or plain text first-line

```
CON Choose option:
1. Foo
2. Bar
```

The adapter translates either into `<ussd><type>2|3</type><msg>...</msg></ussd>`.

## Implementation map

| Concern | Location |
|---|---|
| XML parse + GET-or-POST sniffing | [`app/adapters/vodacom.py`](../app/adapters/vodacom.py) `_parse_fields` |
| Type → SessionEvent mapping | [`app/adapters/vodacom.py`](../app/adapters/vodacom.py) `_TYPE_EVENT_MAP` |
| XML response render (incl. premium hook) | [`app/adapters/_common.py`](../app/adapters/_common.py) `xml_reply_truroute` |
| Session-state UPSERT/SELECT/DELETE | [`app/db.py`](../app/db.py) `upsert_active_session` / `get_active_session` / `expire_active_session` |
| Terminal-event short-circuit | [`app/main.py`](../app/main.py) `_handle_ussd` (first branch on `ur.event in TERMINAL_EVENTS`) |
| Sessions cache table | [`db/002_active_sessions.sql`](../db/002_active_sessions.sql) |

## Not yet handled

* **REDIRECT (outbound type=5)** — needs a new `UnifiedReply` variant. Spec leaves it open; add when a handler asks for it.
* **Premium charging (outbound `<premium>`)** — render path exists; `UnifiedReply` extension + JSON contract addition pending.
* **`type=10` CHARGE forwarding** — currently treated as terminal-ack. If the games-handler needs to be told a charge failed, change the lifecycle map to forward it as INPUT (or add a new non-terminal event).

## Quick smoke (against the bundled echo handler)

```bash
# XML POST (the canonical TruRoute shape):
curl -sS -X POST http://localhost:8080/ussd/vodacom \
    -H "Content-Type: text/xml" \
    --data '<ussd><msisdn>255712345678</msisdn><sessionid>SMOKE1</sessionid><type>1</type><msg>*123#</msg></ussd>'

# Subsequent input on the same session:
curl -sS -X POST http://localhost:8080/ussd/vodacom \
    -H "Content-Type: text/xml" \
    --data '<ussd><msisdn>255712345678</msisdn><sessionid>SMOKE1</sessionid><type>2</type><msg>1</msg></ussd>'

# Session cancel:
curl -sS -X POST http://localhost:8080/ussd/vodacom \
    -H "Content-Type: text/xml" \
    --data '<ussd><msisdn>255712345678</msisdn><sessionid>SMOKE1</sessionid><type>3</type><msg></msg></ussd>'

# Or via GET:
curl -sS 'http://localhost:8080/ussd/vodacom?msisdn=255712345678&sessionid=SMOKE2&type=1&msg=*123%23'
```

Each call returns the XML envelope (`<ussd><type>2</type><msg>…</msg></ussd>` etc.).
