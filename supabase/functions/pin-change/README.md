# pin-change (Edge Function)

A signed-in **PIN staff member** changes their own PIN. It is the only way out of `profile_secrets.must_change_pin = true` (set when a correct PIN was used
while another session was active; the database then denies every permission-checked RPC and RLS read for that user, see `docs/architecture/auth-flows.md`).
`tenant_admin` / `platform_super_admin` never have a PIN and get the same generic 401 as a wrong current PIN.

`POST /functions/v1/pin-change`, header `Authorization: Bearer <user access token>` (`verify_jwt = true`; the function also calls `auth.getUser(jwt)`), JSON body (max 256 bytes, exactly these keys):
```json
{ "current_pin": "4829", "new_pin": "7391" }
```
The user is identified from the JWT only; the body has no id. PINs are 4 digits (6 for the documented Cashier exception, decided by `pinLengthForRole` in `_shared/pin.ts` from the role name looked up server-side).

| result | status | body |
|---|---|---|
| changed | 200 | `{ "changed": true, "pending_approval": true \| false, "other_sessions_revoked": true \| false }` |
| wrong current PIN, locked, admin / inactive / unknown profile | 401 | `{ "error": "invalid_credentials" }` (identical; shares the pin-login lockout 3/6/9) |
| missing / invalid JWT | 401 | `{ "error": "unauthorized" }` |
| new PIN is weak (repeated / sequential / common, also for 6 digits) | 400 | `{ "error": "weak_pin" }` |
| new PIN equals the current PIN | 400 | `{ "error": "same_pin" }` |
| new PIN has the wrong length for the caller's role | 400 | `{ "error": "invalid_pin_length" }` |
| bad shape / 413 | 400 / 413 | `{ "error": "invalid_request" }` |
| throttled (per IP and per user, best effort) | 429 | `{ "error": "try_later" }` + `Retry-After` |
| infrastructure failure | 503 | `{ "error": "server_error" }` |

**Maker-checker (migration 0024):** if the account was flagged (`must_change_pin`), the change does NOT restore access: the account becomes `pending_approval`
(`pending_approval: true`), every active tenant_admin is notified (`security.pin_change_pending_approval`) and the user stays without permissions until
a tenant_admin calls `fn_approve_pin_change` (or `fn_reject_pin_change`, which forces another change). A voluntary change (no flag) is applied at once
(`pending_approval: false`). The function always calls `fn_complete_forced_pin_change`, which decides "flagged / pending / voluntary" atomically under the row
lock (a second change while pending stays pending; `fn_set_user_pin` is never called from here, so approval cannot be skipped).

Steps: parse and policy checks (no DB), profile + role lookup (service role), `fn_verify_pin(current)`, `fn_complete_forced_pin_change(new)`, then
`auth.admin.signOut(jwt, 'others')` so every OTHER session of the user ends while the calling session survives. `other_sessions_revoked: false` means the
revocation call failed (the PIN did change); the SPA should tell the user to sign out of other devices. Every response is `no-store`, with the pin-login timing floor and CORS rules.

Env: same as `pin-login` (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `PIN_PEPPER`, `ALLOWED_ORIGINS`).
Status: **not executed** (no Deno here); pure logic covered by `tests/unit/pin-change-logic.test.ts`, SQL by `supabase/tests/database/27_single_session_forced_pin_change.test.sql`.
`signOut(jwt, 'others')` against a real GoTrue is untested here.
