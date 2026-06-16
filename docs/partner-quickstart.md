# UssdGatewayTz — Partner Quick-Start

One-page integration brief. Full spec: [partner-integration.md](./partner-integration.md).

## What this is
You host an HTTP endpoint. We POST live USSD legs to it as JSON.
You reply `CON`/`END` + message. We translate to/from the MNO.

## To onboard, send us
- **Shortcode** (Vodacom/Halotel: dialed code e.g. `*123#` · Airtel/Tigo: partner slug e.g. `glpair`)
- **MNO** (vodacom · airtel · tigo · halotel)
- **Handler URL** (HTTPS in prod)
- **Auth mode** (`none` for VPN/IP-allowlisted, or `bearer` + a token)
- **Owner email** (gets dashboard access)

## What we POST you
```
POST https://your-handler/ussd
Content-Type: application/json
Authorization: Bearer <token>     # only if auth_mode=bearer

{
  "operator":     "vodacom",
  "msisdn":       "255712345678",
  "session_id":   "ABC123",          ← stable across legs; key your state by this
  "service_code": "*123#",           ← what was onboarded (dialed code OR slug)
  "ussd_string":  "1*2",             ← accumulated menu trail, "*" between inputs
  "event":        "start" | "input", ← "start" = first leg; "input" = subsequent
  "raw_payload":  { ... }            ← original MNO-native payload (forensics)
}
```

## What you reply
Either JSON
```
HTTP/1.1 200 OK
Content-Type: application/json

{ "action": "CON", "message": "1. Balance\n2. Buy airtime" }
```
or plain text
```
HTTP/1.1 200 OK
Content-Type: text/plain

CON 1. Balance
2. Buy airtime
```
- `CON` = display message + ask for next input  (session continues)
- `END` = display message + close session       (final leg)

## Hard rules
| Rule | Why |
|---|---|
| **Reply within 5s** (per-shortcode timeout; default 5s, cap 10s) | MNO's overall budget is ~10s |
| **Keep message ≤ ~182 chars** | USSD frame limit; longer gets truncated by the MNO |
| **No retries** — USSD is at-most-once | If your handler errors / times out, the user sees `END Service unavailable` and the session is gone. There is no make-up. |
| **Be idempotent on `(session_id, ussd_string)`** | Aggregators occasionally retransmit |
| **Send side-effects (SMS, push) AFTER your `END` reply** | User is gone from the USSD screen the moment you reply |
| **Server-side state TTL ≤ 2 minutes** | USSD sessions live ~60–90s; we don't notify you when one ends without your `END` |
| **You will only ever see `event` = `start` or `input`** | Cancel / timeout / charge-failed / Halotel display-ack never reach your handler |

## Test recipe (curl)
```bash
# START leg
curl -sS -X POST https://your-handler/ussd \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer your-token' \
  -d '{"operator":"vodacom","msisdn":"255700000001",
       "session_id":"SMOKE-1","service_code":"*150*99#",
       "ussd_string":"","event":"start","raw_payload":{}}'

# INPUT leg "1"
curl -sS -X POST https://your-handler/ussd \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer your-token' \
  -d '{"operator":"vodacom","msisdn":"255700000001",
       "session_id":"SMOKE-1","service_code":"*150*99#",
       "ussd_string":"1","event":"input","raw_payload":{}}'
```
Both should return a valid `CON`/`END` reply in well under a second.

## Reports
The owner email logs into the dashboard to see:
- every leg / session for the shortcode
- per-MNO **billable session counts** (`CEIL(duration / window)`: Vodacom 20s, Airtel/Tigo 30s) for invoice reconciliation
- queued CSV exports of any filtered slice

## Contacts
- Onboarding / config:  _partner-ops@example.com_
- Production incidents: _oncall@example.com_
- Token rotation:       _security@example.com_
