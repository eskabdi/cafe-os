# staff-create (Edge Function)

Creates a PIN-login staff member. Caller: a signed-in user holding `users.manage` (checked by the database as the caller).

`POST /functions/v1/staff-create`, header `Authorization: Bearer <user access token>`, JSON body (max 2048 bytes):
```json
{ "username": "abebe", "first_name": "Abebe", "middle_name": "Worku", "last_name": "Mekonnen", "role_id": "<uuid>", "pin": "482916" }
```
`middle_name` / `last_name` optional. No tenant id, no email: the tenant comes from the caller's identity.

| result | status | body |
|---|---|---|
| created | 201 | `{ "profile_id" }` (nothing else) |
| bad shape / invalid role / escalation | 400 | `{ "error": "invalid_request" }` |
| weak PIN (repeated, sequential, < 6 digits) | 400 | `{ "error": "weak_pin" }` |
| no / invalid JWT | 401 | `{ "error": "unauthorized" }` |
| no `users.manage`, suspended / read-only tenant, MFA step-up missing | 403 | `{ "error": "forbidden" }` |
| username taken / plan staff limit | 409 | `{ "error": "username_taken" }` / `{ "error": "staff_limit_reached" }` |
| throttled | 429 | `{ "error": "try_later" }` + `Retry-After` |
| anything else | 503 | `{ "error": "server_error" }` |

Steps: verify JWT (user-scoped client) -> `fn_prepare_staff_creation` as the caller (returns the slug) -> create the Auth user
with the service role (synthetic email `<username>@<slug>.staff.cafeos.invalid`, random 32-byte password, `email_confirm`,
`app_metadata.staff = true`) -> `fn_create_staff_profile` as the caller -> `fn_set_user_pin` with the peppered digest.
Any failure after the Auth user exists deletes the profile and the Auth user. Env: see `../README.md` (`PIN_PEPPER`).

Status: written without Deno or Docker; **not executed against a real Supabase stack**. Pure logic is covered by
`tests/unit/staff-create-logic.test.ts`; the SQL side by `supabase/tests/database/22_staff_identity_authhook.test.sql`.
