# Halotel Tanzania — USSD MO wire

Source spec: *HalotelUSSD Integration Document — HTTP PROTOCOL*,
v1.0 (31-05-2016).

Halotel is the **only TZ MNO in this gateway that is not
synchronous**. Its USSDGW expects an immediate SOAP ack on the
inbound, then we POST the actual menu back on a SEPARATE outbound
HTTP call. The pipeline in [main.py](../app/main.py) handles this
via the adapter's `is_async_outbound = True` flag.

## Topology

```
                ┌── 1. REQ (SOAP InsertMO, requestType=100/101) ──>
HALOTEL USSDGW                                                       UssdGatewayTz
                <── 2. RES (SOAP ussdresponse errorCode=0) ─────────
                <── 3. REQ (SOAP InsertMO, requestType=200/201/202/203) ──
                ── 4. RES (SOAP ussdresponse errorCode=0) ─────────>
```

Exchanges 1+2 = single HTTP round trip into our `/ussd/halotel`
route. Exchanges 3+4 = single HTTP round trip we initiate against
Halotel's USSDGW callback URL (`HALOTEL_OUTBOUND_URL`).

## Inbound wire (Halotel → us)

`POST /ussd/halotel`, `Content-Type: text/xml`. SOAP body:

```xml
<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <InsertMO xmlns="http://tempuri.org/">
      <user>crdb</user>
      <pass>crdb#123</pass>
      <msisdn>255629099842</msisdn>
      <msg>*123#</msg>
      <sessionid>null</sessionid>
      <transactionid>W1-2-1395280360802</transactionid>
      <requestType>100</requestType>
      <ussdgw_id>1</ussdgw_id>
    </InsertMO>
  </soap:Body>
</soap:Envelope>
```

| Field           | Notes |
|-----------------|-------|
| `user` / `pass` | The credentials WE provisioned for Halotel — they identify themselves on the inbound. Configured via `HALOTEL_INBOUND_USER` / `HALOTEL_INBOUND_PASS`. |
| `msisdn`        | International, no leading `+`. May be `null` on subsequent legs (Halotel doesn't re-send it). |
| `msg`           | On `requestType=100`: the dialed code (e.g. `*123#`). On `101`: the user's input. On `102`/`103`/`104`: typically irrelevant. |
| `sessionid`     | ID of the HTTP request — observed as `null` in the spec examples; we don't rely on it. |
| `transactionid` | **Stable across the whole transaction** — starts with `W`. This is what we use as our `session_id`. |
| `requestType`   | See lifecycle table below. |
| `ussdgw_id`     | Which Halotel USSDGW node. Echoed verbatim on our outbound. |

### Lifecycle (inbound requestType → SessionEvent)

| Wire `requestType` | Meaning                                | Gateway `SessionEvent` | Pipeline behaviour |
|--------------------|----------------------------------------|------------------------|--------------------|
| `100`              | First USSD request (msg = dialed code) | `START`               | resolve shortcode, forward to handler, push outbound `202`/`201` |
| `101`              | User input / menu selection            | `INPUT`               | resolve shortcode, forward to handler, push outbound `200`/`203` |
| `102`              | User cancelled                         | `USER_CANCELLED`      | terminal — expire session, ack inbound, NO outbound push |
| `103`              | Menu reached the user (delivery ack)   | `DELIVERY_ACK`        | ack inbound + log only. NOT terminal — session stays alive. |
| `104`              | Transaction error, must cancel         | `TIMEOUT`             | terminal — expire session, ack inbound, NO outbound push |

### Inbound ack we return

Always exchange 2 — even when our async pipeline hasn't yet
forwarded to the handler:

```xml
<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body><ussdresponse><errorCode>0</errorCode></ussdresponse></soap:Body>
</soap:Envelope>
```

`Content-Type: text/xml; charset=utf-8`. On bad inbound creds we
return the same shape with `<errorCode>1</errorCode>` (per spec —
auth failure is reported via SOAP, not HTTP 401).

## Outbound wire (us → Halotel)

`POST {HALOTEL_OUTBOUND_URL}`, `Content-Type: text/xml`, header
`SOAPAction: "http://tempuri.org/InsertMO"`. Same `InsertMO`
envelope as inbound, but populated with OUR credentials
(`HALOTEL_OUTBOUND_USER` / `HALOTEL_OUTBOUND_PASS`) and the
`transactionid` from the inbound:

```xml
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <InsertMO xmlns="http://tempuri.org/">
      <user>halotel</user>
      <pass>halotel#123</pass>
      <msisdn>null</msisdn>
      <msg>Welcome to CRDB. 1.Register 2.Do some other things</msg>
      <sessionid>null</sessionid>
      <transactionid>W1-2-1395280360802</transactionid>
      <requestType>202</requestType>
      <ussdgw_id>1</ussdgw_id>
    </InsertMO>
  </soap:Body>
</soap:Envelope>
```

### Outbound requestType selection

The 6 outbound types (200/201/202/203/204/205/206) collapse to 4
(inbound × action) cases we currently emit:

| Inbound was   | Reply action | Outbound `requestType` | Meaning |
|---------------|--------------|------------------------|---------|
| `100` (first) | `CON`        | `202`                  | First menu, wait for input |
| `100` (first) | `END`        | `201`                  | Notify + close (first message) |
| `101` (input) | `CON`        | `200`                  | Follow-up menu, wait for input |
| `101` (input) | `END`        | `203`                  | Last menu, terminate transaction |

`204` (notify-then-close mid-tx) and `205`/`206` (system
abort/cancel) are not currently emitted. Extend
`_outbound_request_type()` in [`app/adapters/halotel.py`](../app/adapters/halotel.py)
when a handler needs them.

### Halotel's outbound ack

Same envelope shape as our inbound ack. We parse `<errorCode>` to
decide success:

| `errorCode` | Meaning                                       | Action |
|-------------|-----------------------------------------------|--------|
| `0`         | Successfully                                  | log success |
| `-1`        | System error                                  | log + count, no retry |
| `1`         | User/Pass/IP does not match                   | config bug — fix `HALOTEL_OUTBOUND_USER` / `..._PASS` |
| `2`         | TransactionId does not exist (timeout/closed) | session lapsed Halotel-side; nothing to do |

## Pipeline (what changes for async-outbound MNOs)

```
                                    Halotel inbound POST
                                            │
                                            ▼
                                     adapter.parse()
                                            │
                                            ▼
                              auth check / event branch
                                            │
                              ┌─────────────┼──────────────────┐
                              │             │                  │
                       DELIVERY_ACK    TERMINAL           normal flow
                        log+ack        log+ack+expire           │
                                                                ▼
                                                   adapter.render() → inbound ACK
                                                                │   (returned NOW)
                                                                ▼
                                                  asyncio.create_task(
                                                    forward() → push_outbound()
                                                  )
```

The inbound HTTP response goes out within ~10ms (no DB shortcode
lookup, no handler call). The handler-forward + outbound-push run
in the background.

### Failure semantics for the async branch

| Failure                       | Customer experience | Operational follow-up |
|-------------------------------|---------------------|-----------------------|
| Handler timeout               | "Service unavailable" END pushed | handler latency alert |
| Handler non-2xx               | "Service unavailable" END pushed | handler dashboard |
| Outbound push timeout         | USSD session times out Halotel-side | network / Halotel-URL alert |
| Outbound push errorCode != 0  | as above                          | config audit + Halotel ops |
| Shortcode not found           | "Service not configured" END pushed | onboarding gap |

USSD has no within-session retry semantics; once the customer is
gone, all we can do is log + count.

## Authentication

Two credential pairs, one per direction:

* **Inbound** — `HALOTEL_INBOUND_USER` / `HALOTEL_INBOUND_PASS`.
  WE provision, Halotel uses on the SOAP body when pushing TO us.
  Bad creds → SOAP `errorCode=1` ack, request logged with
  `error_class="auth_failed"`. NO handler call.
* **Outbound** — `HALOTEL_OUTBOUND_USER` / `HALOTEL_OUTBOUND_PASS`.
  Halotel provisions, WE put in the SOAP body when pushing TO them.

Plain-text in the SOAP body — same as the spec example. If Halotel
ever moves to mTLS / signed envelopes, add the certs to the
`HalotelConfig` dataclass in [`app/config.py`](../app/config.py).

## Environment knobs

| Env var                           | Purpose                                    | Default |
|-----------------------------------|--------------------------------------------|---------|
| `HALOTEL_INBOUND_USER`            | What Halotel sends in `<user>` to us      | "" (no auth) |
| `HALOTEL_INBOUND_PASS`            | What Halotel sends in `<pass>` to us      | "" (no auth) |
| `HALOTEL_OUTBOUND_URL`            | Halotel USSDGW SOAP endpoint              | "" (push disabled) |
| `HALOTEL_OUTBOUND_USER`           | What we send in `<user>` to Halotel       | "" |
| `HALOTEL_OUTBOUND_PASS`           | What we send in `<pass>` to Halotel       | "" |
| `HALOTEL_USSDGW_ID`               | `<ussdgw_id>` echoed on outbound when not in inbound payload | "1" |
| `HALOTEL_OUTBOUND_TIMEOUT_SECS`   | httpx timeout on the outbound POST        | "4.0" |

When `HALOTEL_OUTBOUND_URL` is empty, the adapter logs a warning
and skips the outbound push — useful for staging where Halotel
isn't yet pointing at us, but production MUST set all six values.

## Service-code lookup

Same model as Vodacom:

* `service_code` = the dialed USSD (e.g. `*123#`), pulled from
  `msg` on `requestType=100`, cached in `ussd_active_sessions`
  keyed by `(transactionid, halotel_operator_id)`.
* Subsequent legs (`101`/`102`/`103`/`104`) recover `service_code`
  from the cache row.
* `shortcodes.code` rows are the canonical USSD form (`*123#`),
  NOT a partner slug.

## Onboarding a Halotel shortcode

```sql
INSERT INTO shortcodes (operator_id, code, owner_user_id,
                        handler_url, auth_mode, bearer_token,
                        timeout_secs, active)
SELECT o.id, '*123#',
       (SELECT id FROM portal_users WHERE email = 'ops@crdb.example'),
       'https://crdb.example.com/ussd', 'bearer', 'redacted-token',
       4, TRUE
  FROM operators o WHERE o.name = 'halotel';
```

Important: keep `timeout_secs <= HALOTEL_OUTBOUND_TIMEOUT_SECS`.
USSD's overall budget is short — slow handlers + slow outbound +
slow Halotel-USSDGW-ack stack up against the user's screen
timeout.

## Implementation map

| Concern                              | Location |
|--------------------------------------|----------|
| SOAP parse + namespaces              | [`app/adapters/halotel.py`](../app/adapters/halotel.py) `_parse_soap`, `_xtext` |
| Type → SessionEvent mapping          | [`app/adapters/halotel.py`](../app/adapters/halotel.py) `_TYPE_EVENT_MAP` |
| Inbound auth check                   | [`app/adapters/halotel.py`](../app/adapters/halotel.py) `parse` (`_auth_ok` flag) |
| Inbound ack envelopes                | [`app/adapters/halotel.py`](../app/adapters/halotel.py) `_SOAP_ACK_OK`, `_SOAP_ACK_AUTH` |
| Outbound requestType selection       | [`app/adapters/halotel.py`](../app/adapters/halotel.py) `_outbound_request_type` |
| Outbound envelope builder            | [`app/adapters/halotel.py`](../app/adapters/halotel.py) `_build_outbound_envelope` |
| Outbound POST + errorCode parse      | [`app/adapters/halotel.py`](../app/adapters/halotel.py) `push_outbound`, `_parse_outbound_ack` |
| Auth-failed pipeline branch          | [`app/main.py`](../app/main.py) `_handle_ussd` (block `2a`) |
| DELIVERY_ACK pipeline branch         | [`app/main.py`](../app/main.py) `_handle_ussd` (block `2b`) |
| Async-outbound dispatch              | [`app/main.py`](../app/main.py) `_async_forward_then_push`, `_async_canned_push` |
| Config knobs                         | [`app/config.py`](../app/config.py) `HalotelConfig` |
| Session cache (per-MNO transactionid) | [`app/db.py`](../app/db.py) `upsert_active_session` / `get_active_session` |

## Smoke (against a mock Halotel receiver + echo handler)

Stand up a netcat receiver to capture our outbound push:

```bash
# In one shell — fake Halotel USSDGW listening on :9090
while true; do printf 'HTTP/1.1 200 OK\r\nContent-Type: text/xml\r\nContent-Length: 142\r\n\r\n<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><ussdresponse><errorCode>0</errorCode></ussdresponse></soap:Body></soap:Envelope>' | nc -l -p 9090 -q 1; done

# In another — set env + bring up the gateway
HALOTEL_INBOUND_USER=crdb HALOTEL_INBOUND_PASS='crdb#123' \
HALOTEL_OUTBOUND_URL=http://localhost:9090/ \
HALOTEL_OUTBOUND_USER=halotel HALOTEL_OUTBOUND_PASS='halotel#123' \
uvicorn app.main:app --port 8080

# In a third — simulate Halotel's inbound first leg
curl -sS -X POST http://localhost:8080/ussd/halotel \
    -H 'Content-Type: text/xml' \
    --data '<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <InsertMO xmlns="http://tempuri.org/">
      <user>crdb</user><pass>crdb#123</pass>
      <msisdn>255629099842</msisdn>
      <msg>*123#</msg>
      <sessionid>null</sessionid>
      <transactionid>W1-2-SMOKE-1</transactionid>
      <requestType>100</requestType>
      <ussdgw_id>1</ussdgw_id>
    </InsertMO>
  </soap:Body>
</soap:Envelope>'
```

The inbound `curl` returns the `<errorCode>0</errorCode>` ack
immediately. The `nc` listener captures the outbound SOAP envelope
a moment later.

## Open questions / future work

1. **Within-session retry on outbound failure.** Currently we
   log + drop. Should we retry once with a 500ms backoff inside
   the USSD budget?
2. **204 / 205 / 206 outbound types.** Not currently emitted.
   Useful for "interim notify then close" or system-side aborts.
3. **`sessionid` semantics.** Always `null` in the spec examples.
   Confirm whether Halotel ever populates it (and if so, whether
   we should round-trip it on the outbound).
4. **IP allowlist.** The spec mentions "User/Pass/IP does not
   match" — does Halotel actually enforce source-IP checks? If
   yes, our outbound must originate from a fixed IP they have
   on file. Document the gateway's egress IP in deploy notes.
