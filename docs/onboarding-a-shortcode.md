# Onboarding a new shortcode

Two things to do per shortcode you want the gateway to route:

1. Create (or find) a `portal_users` row for the OWNER (the person /
   org allowed to view the reports in the dashboard).
2. Insert a `shortcodes` row that maps `(operator, code)` to the
   owner's handler URL and chosen auth mode.

## SQL recipe

```sql
-- 1. Owner (only needed once per org; reuse existing portal_users.id
--    after the first onboarding).
INSERT INTO portal_users (email, name, password_hash, role_id, active)
VALUES (
    'ops@acme.example',
    'Acme Ops',
    '$2a$10$REPLACEME_WITH_BCRYPT_HASH',
    (SELECT id FROM roles WHERE key = 'client'),
    TRUE
)
RETURNING id;
-- → record the returned id, call it <owner_id> below.

-- 2. Shortcode routing.
INSERT INTO shortcodes
    (operator_id, code, label, owner_user_id,
     handler_url, auth_mode, bearer_token, timeout_secs, active)
VALUES (
    (SELECT id FROM operators WHERE name = 'vodacom'),
    '*123*45#',
    'Acme order menu',
    <owner_id>,
    'https://orders.acme.example/ussd',
    'bearer',
    'BEARER_TOKEN_THE_HANDLER_VALIDATES',
    5,
    TRUE
);
```

## Verify

```bash
# Inside the gateway container (or any psql session against the same DB):
psql "$USSD_PG_DSN" -c "
  SELECT s.code, o.name AS operator, s.handler_url, s.auth_mode, s.active
    FROM shortcodes s JOIN operators o ON o.id = s.operator_id
   WHERE s.code = '*123*45#';
"
```

A live USSD call to `*123*45#` on Vodacom will now route to the
handler. First leg's log row appears in `ussd_session_logs`:

```sql
SELECT ts, operator_name, msisdn, ussd_string,
       handler_status_code, handler_response_action, handler_elapsed_ms,
       error_class
  FROM ussd_session_logs
 WHERE shortcode_id = (SELECT id FROM shortcodes WHERE code = '*123*45#')
 ORDER BY ts DESC
 LIMIT 5;
```

## Auth mode choices

| `auth_mode` | What the gateway sends | When to use |
|---|---|---|
| `none`   | No `Authorization` header. | Handler is on the same VPN / private network as the gateway; the network IS the trust boundary. Default for internal-app handlers. |
| `bearer` | `Authorization: Bearer <bearer_token>`, value from the shortcode row. | Handler is external. Token is your shared secret; rotate by updating the row + the handler in lockstep. |

## Rotating a bearer token

```sql
UPDATE shortcodes
   SET bearer_token = 'NEW_TOKEN_VALUE',
       updated_at = now()
 WHERE id = <shortcode_id>;
```

Next call uses the new token. There's no gateway-side restart needed
— `resolve_shortcode` reads the value per request. (The handler
service obviously needs to flip to the new token at the same time;
keep both sides in sync or build a rolling-window verifier on the
handler.)
