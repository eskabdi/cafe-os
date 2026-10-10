# staff-pin-reset (Edge Function)

A staff manager (`users.manage`, typically the tenant_admin) sets a **new PIN** for a PIN staff member of its own tenant (Phase 3B Tenant Portal).
Classification: **Private**. Full contract: `docs/api/portals.md`.

`POST /functions/v1/staff-pin-reset`, header `Authorization: Bearer <user access token>`, JSON body (max 256 bytes, exactly these keys):
```json
{ "profile_id": "<uuid>", "pin": "4829" }
```
No tenant id: the database derives it from the caller. PIN: 4 digits, 6 for the role named Cashier (the documented exception; the role name comes from
`fn_prepare_pin_reset`, both the SQL and the TypeScript rule must agree), no weak PINs.

| result | status | body |
|---|---|---|
| PIN set | 200 | `{ "profile_id", "pin_reset": true }` |
| bad shape | 400 | `{ "error": "invalid_request" }` |
| weak PIN / wrong length for the role | 400 | `{ "error": "weak_pin" }` / `{ "error": "invalid_pin_length" }` |
| no / invalid JWT | 401 | `{ "error": "unauthorized" }` |
| no `users.manage`, own account, target holds rights the caller lacks, suspended / read-only tenant | 403 | `{ "error": "forbidden" }` |
| enrolled caller on aal1 | 403 | `{ "error": "mfa_required" }` |
| unknown / foreign profile | 404 | `{ "error": "not_found" }` |
| target cannot have a PIN (tenant_admin, platform admin, pending identity rotation) or is inactive | 409 | `{ "error": "pin_not_allowed" }` |
| throttled | 429 | `{ "error": "try_later" }` |
| anything else | 503 | `{ "error": "server_error" }` |

Steps: `auth.getUser` -> `fn_prepare_pin_reset` AS THE CALLER (audited `auth.pin_reset_requested`) -> length check -> `fn_set_user_pin(profile, HMAC-SHA256(pin,
PIN_PEPPER), length)` with the service role (bcrypt; lockout, forced-change flag and pending approval cleared; audited `auth.pin_set`). The raw PIN never
reaches SQL or a log. Existing sessions of the staff member are not revoked by this function (open question in `docs/api/portals.md`).

Status: `deno check` passes; **not executed against a real Supabase stack**. Logic: `tests/unit/staff-pin-reset-logic.test.ts`; SQL: `33_tenant_portal`.
