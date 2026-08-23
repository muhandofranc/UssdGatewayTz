# Working notes — the Gateway and the Dashboard

_What the two halves of UssdGatewayTz are, how a request flows through
them, and why each one matters (and what breaks if it fails)._

UssdGatewayTz is **two cooperating programs that share one Postgres**:

| | Gateway (`app/`) | Dashboard (`dashboard/`) |
|---|---|---|
| Stack | FastAPI (Python) | Next.js (App Router, TS) |
| Job | Carry **live** USSD traffic to/from the MNOs | **Configure, observe, bill, and test** that traffic |
| In the live call path? | **Yes** — every dial | No |
| Talks to | MNOs ⇄ client handler URLs | Operators (people) ⇄ Postgres |
| Tier | **Tier-0 (revenue path)** | Tier-1 (control plane + system of record) |

The Postgres in the middle is the **contract** between them: the
`shortcodes` table is routing config the dashboard writes and the
gateway reads; `ussd_session_logs` is traffic the gateway writes and the
dashboard reads.

---

## 1. The Gateway — the live path

### What it does
A single HTTP entry point for **every Tanzania MNO** (Vodacom, Airtel,
Tigo, Halotel). Each MNO POSTs/GETs to a per-operator route; the gateway
turns that native payload into one canonical shape, finds where it
should go, forwards it, and translates the answer back — **synchronously,
inside the MNO's ~10-second USSD session budget**.

### The request lifecycle (`app/main.py::_handle_ussd`)
```
MNO dial  →  /ussd/<operator>
  1. adapter.parse()        native MNO wire (Vodacom XML / Airtel·Tigo text /
                            Halotel SOAP)  →  UnifiedRequest         app/adapters/*
  2. resolve_shortcode()    (operator, service_code) → handler_url,  app/db.py
                            auth, status, environment='production'
  3. status gate            active → forward · maintenance/deactivated
                            → render owner message, skip handler
  4. forward()              POST unified JSON → handler_url,          app/forwarder.py
                            parse reply "CON|END"
  5. adapter → native       translate CON/END back to the MNO's shape
  6. log_leg()              one row per HTTP leg → ussd_session_logs  app/db.py
```
Sync MNOs get the answer on the same HTTP response; async ones (Halotel)
are ACK'd immediately and the reply is pushed out of band. Two helper
processes (`scheduler`, `scheduler-intraday`) roll session logs up into
the daily/intraday summaries the dashboard reads.

### Why it matters
- **Blast radius is total.** It is the *single* synchronous path for
  every shortcode, every client, across all four MNOs. If it is down or
  slow, **every USSD service fails at once** — not one client, all of
  them — and the MNO times the session out in front of the subscriber.
- **It is the billing source of truth.** Every leg is logged with
  timestamps + operator; those rows are what the dashboard bills on. Lose
  or corrupt the log and you lose the money record.
- **It handles sensitive traffic.** USSD sessions carry PINs, MSISDNs,
  menu selections. The gateway is where that flows and where the
  bearer-token auth to each handler is applied.
- **Money-safety is built in and must stay in.** Whole-second ceil
  billing; `resolve_shortcode` filters `environment='production'` so a
  sandbox shortcode can **never** take live traffic; status gates let a
  broken backend show a message instead of erroring at the subscriber.

### What to protect it with
Redundancy/HA (it's the SPOF for revenue), DB pool sizing, handler
timeouts kept **below** the MNO session budget, and alerting on latency
and `error_class` (via the Prometheus/Grafana stack in compose). Keep it
stateless so it scales horizontally; the Postgres it reads is its hard
dependency.

---

## 2. The Dashboard — the control plane & system of record

### What it does
Not in the call path — but it is the **only** way to run the gateway and
the record everyone trusts. Surfaces:

- **Shortcode CRUD = routing config** (`shortcodes/`): the `handler_url`,
  auth mode/token, `status`, and `environment` the gateway routes on.
  Editing here **re-points live traffic**.
- **Reports / sessions / summary**: per-leg, per-session, and daily
  rollups — the **billing and SLA basis** clients and finance rely on.
- **Simulator** (`simulator/`): POSTs the exact gateway request contract
  to a handler URL so a client can test a handler **without** live MNO
  traffic.
- **RBAC + audit** (`lib/rbac.ts`, `portal_audit_log`): tenancy
  (owners see only their shortcodes) and a tamper-evident change log.
- **Sandbox self-service** (`my-shortcodes/`): clients create sandbox
  shortcodes (capped 2/operator), test them, then a Super Admin promotes
  to production.
- **Exports worker**: async CSV exports of traffic.

### Why it matters
- **It is the routing brain.** A wrong `handler_url`, a mistaken
  `deactivate`, or a bad status message here **mis-routes or kills a live
  service** — even though the dashboard itself isn't in the call path. A
  config mistake has the same customer impact as a gateway outage.
- **It is the billing/reporting authority.** If the numbers here are
  wrong or unavailable, invoicing and client trust break. Postgres history
  behind it must be backed up.
- **It is the security & tenancy boundary.** A dashboard compromise means
  the ability to **redirect any client's USSD traffic** to an
  attacker-controlled URL — i.e. harvest PINs/sessions at scale. This is
  why writes are gated by RBAC and every mutation is audited.
- **It is client self-service.** The sandbox + simulator let clients
  onboard and iterate without a Super Admin provisioning live routing —
  and the isolation guarantee (sandbox never routes) is what makes that
  safe.

### What to protect it with
Keep the write gates and audit intact; treat `handler_url` / `status`
changes as sensitive operations; back up Postgres (it holds billing
history and routing config); and preserve the sandbox isolation invariant
(`environment='production'` filter in the gateway) — that single line is
what keeps self-service from touching live money.

---

## 3. The one-line takeaways

- **Gateway = availability & correctness of live money movement.** If it
  stops, every subscriber on every MNO is affected *now*. Protect uptime,
  latency, and the integrity of the session log.
- **Dashboard = correctness of configuration & the record of truth.** It
  isn't in the call path, but it *decides* the call path and *is* the
  billing record. Protect its write-access, its audit trail, and the
  database behind it.
- **Shared Postgres is the real single point of failure** — both halves
  die without it. Back it up, monitor it, keep the log partitions healthy.
