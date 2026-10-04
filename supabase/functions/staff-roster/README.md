# staff-roster (Edge Function)

The PIN-staff tiles for a **registered kiosk device** (shared floor terminal). Tenant = `<slug>.cafeos.et` (the SPA sends the slug it
derives from the hostname) AND the kiosk token; both must agree. See `docs/architecture/kiosk-terminals.md` and `tenant-routing.md`.

`POST /functions/v1/staff-roster`, JSON body (max 512 bytes, exactly these keys):
```json
{ "restaurant_slug": "central-cafe", "kiosk_token": "<64 hex chars issued once by fn_register_kiosk>" }
```
| result | status | body |
|---|---|---|
| ok | 200 | `{ "staff": [ { "id", "name", "role", "color", "icon" } ], "pin_pad_idle_seconds": 60 }` |
| unknown / revoked kiosk, wrong tenant, suspended or cancelled tenant, Origin of another tenant's subdomain | 401 | `{ "error": "invalid_kiosk" }` (identical) |
| bad shape | 400 / 413 | `{ "error": "invalid_request" }` |
| throttled (per IP, per IP+slug; best effort) | 429 | `{ "error": "try_later" }` + `Retry-After` |
| infrastructure failure | 503 | `{ "error": "server_error" }` |

Every response: `Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow`.

`pin_pad_idle_seconds` (migration 0025) is the tenant's PIN-pad idle timer: seconds without activity on the pad before the kiosk drops the
PIN and returns to the tiles. Tenant = the kiosk token's tenant (never a request field). It is always an integer in **15..300**; the DB
CHECK enforces that range and the function re-validates it (`normalizePinPadIdleSeconds`): a missing, non-integer or out-of-range value
becomes the default **60**, so a malformed answer can never disable the timer. The DB call is the service-only
`fn_kiosk_terminal_bootstrap(token_hash, slug)` (NULL for every invalid kiosk, else `{staff: <fn_kiosk_roster>, pin_pad_idle_seconds}`).
**Deploy order:** apply migration 0025 before deploying this function version (the old version keeps working against the new DB, since
`fn_kiosk_roster` is unchanged). The field is additive: a client that ignores it keeps working.

Who appears: active staff of that tenant with `auth_method = 'pin'`, a non-admin active role, a PIN on record of exactly **4 digits**.
The 6-digit Cashier and every admin never appear (no role-name literal: the DB decides by `profile_secrets.pin_length`). A tile carries
`id`, short name (first + middle), role label, colour, icon: never username, email, secrets or permissions. The tile `id` is what the
kiosk then sends to `pin-login` (tile path); the Cashier signs in with username + 6-digit PIN on any device.

Env: same as `pin-login` (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `PIN_PEPPER` for the shared fail-closed env,
`ALLOWED_ORIGINS` incl. `https://*.cafeos.et`). Status: **not executed** (no Deno here); logic covered by `tests/unit/kiosk-logic.test.ts`,
SQL by `supabase/tests/database/26_kiosk_devices.test.sql` and `29_session_timer_settings.test.sql` (bootstrap).
