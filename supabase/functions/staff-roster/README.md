# staff-roster (Edge Function)

The PIN-staff tiles for a **registered kiosk device** (shared floor terminal). Tenant = `<slug>.cafeos.et` (the SPA sends the slug it
derives from the hostname) AND the kiosk token; both must agree. See `docs/architecture/kiosk-terminals.md` and `tenant-routing.md`.

`POST /functions/v1/staff-roster`, JSON body (max 512 bytes, exactly these keys):
```json
{ "restaurant_slug": "central-cafe", "kiosk_token": "<64 hex chars issued once by fn_register_kiosk>" }
```
| result | status | body |
|---|---|---|
| ok | 200 | `{ "staff": [ { "id", "name", "role", "color", "icon" } ] }` |
| unknown / revoked kiosk, wrong tenant, suspended or cancelled tenant, Origin of another tenant's subdomain | 401 | `{ "error": "invalid_kiosk" }` (identical) |
| bad shape | 400 / 413 | `{ "error": "invalid_request" }` |
| throttled (per IP, per IP+slug; best effort) | 429 | `{ "error": "try_later" }` + `Retry-After` |
| infrastructure failure | 503 | `{ "error": "server_error" }` |

Every response: `Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow`.

Who appears: active staff of that tenant with `auth_method = 'pin'`, a non-admin active role, a PIN on record of exactly **4 digits**.
The 6-digit Cashier and every admin never appear (no role-name literal: the DB decides by `profile_secrets.pin_length`). A tile carries
`id`, short name (first + middle), role label, colour, icon: never username, email, secrets or permissions. The tile `id` is what the
kiosk then sends to `pin-login` (tile path); the Cashier signs in with username + 6-digit PIN on any device.

Env: same as `pin-login` (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `PIN_PEPPER` for the shared fail-closed env,
`ALLOWED_ORIGINS` incl. `https://*.cafeos.et`). Status: **not executed** (no Deno here); logic covered by `tests/unit/kiosk-logic.test.ts`,
SQL by `supabase/tests/database/26_kiosk_devices.test.sql`.
