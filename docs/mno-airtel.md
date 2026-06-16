# Airtel Tanzania — USSD MO wire

Source: live aggregator traffic captured 2026-05-29 (no formal
spec document yet). Update this file when Airtel's USSD MO spec
lands and reconcile any deltas.

## Inbound wire (MNO → gateway)

GET only. Like Tigo, Airtel's aggregator pushes **per-partner** —
each WASP/reseller gets a dedicated URL path ending in `air`:

```
/ussd/glpair/        — GLP (Game Lottery Partner)
```

Only `glpair` is in the observed wire; future partners are
expected to follow the `<partner>air` slug pattern.

### Parameters

```
input, sessionid, msisdn
```

That's the entire payload. Specifically: no `NEW_REQUEST` flag,
no `SHORT_CODE`, no `IMSI`.

| Field      | First leg                                  | Subsequent leg          |
|------------|--------------------------------------------|-------------------------|
| `input`    | dialed code, `*` + `#` stripped (e.g. `147*03` for `*147*03#`) | user's typed text       |
| `sessionid`| Airtel-issued session id                   | same, repeated          |
| `msisdn`   | international, no leading `+`              | same                    |

### Lifecycle detection

Because the wire carries no first-leg flag, START vs INPUT is
discriminated by **session-cache presence**:

| `ussd_active_sessions` row for `(sessionid, airtel)` | Event   | `input` is treated as |
|------------------------------------------------------|---------|------------------------|
| MISS (cache empty)                                   | `START` | the dialed code        |
| HIT  (cache present)                                 | `INPUT` | the user's typed text  |

#### Cache-miss caveats (deliberate trade-offs)

* **Sweeper / restart mid-session.** A genuine INPUT leg may be
  misclassified as START. The URL partner slug is still the
  routing key, so the request still reaches the right handler —
  just with `event="start"` and an empty `ussd_string`. The
  handler will likely refuse and END gracefully.
* **Aggregator retransmits of the START leg.** The second
  arrival is a cache HIT and therefore classified as INPUT, with
  the dialed code echoed into `ussd_string`
  (`"147*03*147*03"`). Cosmetic glitch only; handler logic is
  unaffected.

If either turns into a real problem, add an input-shape
heuristic (`"*" in input` ⇒ likely-dialed) as a secondary
START signal in [`app/adapters/airtel.py`](../app/adapters/airtel.py).

### Terminal events

None observed (no cancel / timeout / charge-failed). If they
appear later, add the relevant mapping in `parse()` per the
[Vodacom pattern](../app/adapters/vodacom.py).

## Outbound wire (gateway → MNO)

Plain text, `Content-Type: text/plain; charset=utf-8`:

```
CON <message>      → keep session open
END <message>      → close session
```

Exact response shape (FREETEXT marker, max bytes, charset
restrictions) **pending confirmation** against Airtel's USSD MO
spec. Replace `plain_text_reply()` in the adapter's `render()`
if the wire format differs.

## Routing model

The URL **partner slug** (e.g. `glpair`) is used as the gateway's
`service_code` for `shortcodes` lookup. Same rationale as Tigo:

* Airtel's aggregator already routed by URL; preserving that means
  no cross-leg recovery for routing.
* One `shortcodes` row per partner regardless of how many dialed
  codes the partner owns.
* The dialed USSD (e.g. `*147*03#`) travels to the handler in
  `raw_payload["dialed_code"]` **on the START leg only**.
  Subsequent legs don't carry it on the wire and we don't cache
  it separately. Handlers correlate by `session_id` and remember
  their own context.

### Wildcard route + suffix collision

[main.py](../app/main.py) dispatches `*air` → airtel. The `air`
suffix is only 3 chars; an unrelated future slug ending in `air`
(e.g. `pair`, `stair`) would misroute. Switch to an explicit
allowlist if/when that bites.

## Handler contract (Airtel-specific raw_payload)

The unified handler payload:

```json
{
  "operator":     "airtel",
  "msisdn":       "255780995191",
  "session_id":   "17800622561577020",
  "service_code": "glpair",
  "ussd_string":  "7",
  "event":        "start" | "input",
  "raw_payload":  {
    "input":      "7",
    "sessionid":  "17800622561577020",
    "msisdn":     "255780995191",
    "dialed_code": "*147*03#"
  }
}
```

`raw_payload["dialed_code"]` is present **only on the START leg**.
On INPUT legs the handler reads it from its own per-session state
if it needs it.

## Onboarding an Airtel partner

Airtel's USSD ops team configures the partner URL on their side
(e.g. `https://gateway.example/ussd/glpair/`). On our side:

```sql
INSERT INTO shortcodes (operator_id, code, owner_user_id,
                        handler_url, auth_mode, bearer_token,
                        timeout_secs, active)
SELECT o.id, 'glpair',
       (SELECT id FROM portal_users WHERE email = 'ops@glp.example'),
       'https://glp.example.com/ussd', 'bearer', 'redacted-token',
       5, TRUE
  FROM operators o WHERE o.name = 'airtel';
```

The `code` column holds the partner slug (matching what comes
after `/ussd/` in the Airtel-side URL config), NOT the dialed
USSD.

## Implementation map

| Concern                            | Location |
|------------------------------------|----------|
| Lifecycle (cache-presence) + input shape | [`app/adapters/airtel.py`](../app/adapters/airtel.py) `parse` |
| Dialed-code normalisation          | [`app/adapters/airtel.py`](../app/adapters/airtel.py) `_normalise_dialed` |
| Partner slug from URL              | [`app/adapters/airtel.py`](../app/adapters/airtel.py) `_partner_slug_from_path` |
| Wildcard route + suffix dispatch   | [`app/main.py`](../app/main.py) `_dispatch_partner_slug` |
| Session cache (slug + ussd_string) | [`app/db.py`](../app/db.py) `upsert_active_session` / `get_active_session` |
| Plain-text reply                   | [`app/adapters/_common.py`](../app/adapters/_common.py) `plain_text_reply` |

## Smoke (against the bundled echo handler)

```bash
# START leg — input carries the dialed code (147*03 = *147*03#)
curl -sS 'http://localhost:8080/ussd/glpair/?input=147*03&sessionid=SMOKE-AIR&msisdn=255780995191'

# Subsequent INPUT legs
curl -sS 'http://localhost:8080/ussd/glpair/?input=7&sessionid=SMOKE-AIR&msisdn=255780995191'
curl -sS 'http://localhost:8080/ussd/glpair/?input=144569126&sessionid=SMOKE-AIR&msisdn=255780995191'
```

Each call returns `CON …` / `END …` on the wire.

## Open questions to confirm with Airtel

1. **Terminal events.** Cancel / timeout / charge-failed — does
   the aggregator notify? If yes, what parameter signals them?
2. **Outbound shape.** Plain `CON|END <msg>` confirmed, or does
   Airtel expect a different convention (FREETEXT marker, JSON,
   XML)?
3. **Max message length.** USSD line cap.
4. **Character set.** GSM-7 only or UCS-2 supported?
5. **First-leg flag.** Is there an undocumented parameter that
   could disambiguate START vs INPUT without relying on cache
   presence?
6. **Authoritative partner-URL list.** Beyond `glpair`, are
   there other suffixes already in production or planned?
   (Confirms whether the `*air` wildcard suffix is safe.)
