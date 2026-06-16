# UssdGatewayTz — unified Tanzania USSD reseller gateway

Single HTTP entry point for every Tanzania MNO (Vodacom, Airtel, Tigo,
Halotel). The MNO POSTs/GETs a USSD request to a per-MNO route on this
gateway; the gateway looks up the dialed `service_code` (e.g. `*123#`)
in a DB-config table, forwards a **unified JSON request** to the
owning handler URL (internal app OR external client), parses the
handler's `CON|END` reply, translates back to the MNO's native
response shape, and answers the MNO synchronously. Every HTTP leg is
logged with timestamps + operator name to Postgres for the dashboard
reports.

## Phase status

| Phase | Status | Scope |
|---|---|---|
| **1. Gateway foundation** | done | FastAPI app, DB schema, per-MNO route placeholders, handler forwarder, docker-compose |
| **2. MNO adapters** | pending docs | One adapter per MNO once you share the spec. The Phase 1 stubs accept the canonical request shape but the request/response translation is a placeholder. |
| **3. Dashboard** | pending | Next.js + custom JWT cookie session (same shape as the jubileeTzUssd dashboard), portal-user login, per-shortcode RBAC. |
| **4. Hardening** | pending | Rate limits, HMAC-option for handlers that want it, log retention partitioning, healthchecks. |

## Architecture (1-page)

```
MNO (Vodacom GET/POST, Airtel GET, Tigo GET, Halotel POST)
  │
  ▼  POST/GET /ussd/<operator>
┌─────────────────────────────────────────┐
│  FastAPI gateway (app/main.py)          │
│   ┌─ per-operator adapter ──────────┐   │
│   │ parses native MNO payload       │   │
│   │ → UnifiedRequest                │   │
│   └────────────────────────────────┘   │
│   ┌─ shortcode resolver ─────────────┐  │
│   │ DB lookup (operator, service_code)│  │
│   │ → handler_url + auth (none|bearer)│  │
│   └────────────────────────────────┘   │
│   ┌─ handler forwarder ──────────────┐  │
│   │ POST unified JSON to handler_url  │  │
│   │ parses reply: JSON or plain text  │  │
│   │ → action (CON|END) + message      │  │
│   └────────────────────────────────┘   │
│   ┌─ per-operator adapter ──────────┐   │
│   │ UnifiedReply → native MNO shape │   │
│   └────────────────────────────────┘   │
│   ┌─ logger ─────────────────────────┐  │
│   │ INSERT ussd_session_logs (ts,   │  │
│   │   operator, session_id, msisdn, │  │
│   │   ussd_string, raw_payload,     │  │
│   │   handler_status/elapsed/reply) │  │
│   └────────────────────────────────┘   │
└─────────────────────────────────────────┘
  │
  ▼  native MNO response (synchronous)
MNO
```

**Sessions log** is one row per HTTP leg — every MNO callback during a
live USSD interaction is its own row. The dashboard computes
Vodacom-style 20s billable windows in SQL with a window function on
read (no write-time roll-up; keeps the gateway path simple).

## DB

External Postgres (recommended over MySQL — see `docs/db-choice.md`).
Connection via env vars `USSD_PG_*`. Schema in `db/001_init.sql`.

## Run locally

```bash
cp .env.example .env
# edit .env: set USSD_PG_HOST + creds for your dev Postgres
docker compose --env-file .env up -d --build
# Apply the schema (one-shot, idempotent):
docker compose exec -T gateway python -m app.db_init
# Smoke-test (echo handler bundled in tests/echo_handler.py):
curl -s 'http://localhost:8080/ussd/vodacom?msisdn=255712345678&sessionid=ABC123&serviceCode=*123%23&text=' | head
```

See `docs/onboarding-a-shortcode.md` for the SQL to register a new
shortcode + handler URL.

## Adding a new MNO adapter

1. Drop a module under `app/adapters/<mno>.py` matching the
   `Adapter` protocol in `app/adapters/__init__.py`.
2. Wire it into `app/routes.py` (one new route per MNO).
3. Add the MNO row to `operators` table (or use the seed migration).

## Adding a new external handler

A row in `shortcodes`:

```sql
INSERT INTO shortcodes
    (operator_id, code, owner_user_id, handler_url, auth_mode, bearer_token, active)
VALUES
    ((SELECT id FROM operators WHERE name='vodacom'),
     '*123*45#',
     <portal_user_id>,
     'https://client.example.com/ussd',
     'bearer',                                  -- or 'none' for internal/VPN
     'TOKEN_THE_HANDLER_WILL_VERIFY_IN_AUTH_HEADER',
     true);
```

Next call to `*123*45#` on Vodacom will hit the new handler with a
bearer Authorization header.
