# tenant-admin-invite (Edge Function)

Invite / resend / revoke a **Tenant Admin** invitation (Phase 3B). Classification: **Private** (signed-in Super Admin or tenant_admin, aal2).
Full contract with examples: `docs/api/portals.md`. Flow and threat notes: `docs/architecture/auth-flows.md` ("Tenant Admin invitation").

`POST /functions/v1/tenant-admin-invite`, header `Authorization: Bearer <user access token>` (`verify_jwt = true`; the function also calls `auth.getUser`),
JSON body (max 2048 bytes, exact keys):
```json
{ "action": "invite", "restaurant_id": "<uuid, Super Admin only>", "email": "owner@example.com", "first_name": "Almaz", "middle_name": "Kebede", "last_name": null, "username": "almaz" }
{ "action": "resend", "invitation_id": "<uuid>" }
{ "action": "revoke", "invitation_id": "<uuid>" }
```
A tenant_admin omits `restaurant_id` (the tenant comes from its identity; naming another tenant is `forbidden`).

| result | status | body |
|---|---|---|
| invited | 201 | `{ "invitation_id", "expires_at" }` |
| resent / revoked | 200 | `{ "invitation_id", "resent": true }` / `{ "invitation_id", "status": "revoked" }` |
| bad shape / invalid input | 400 | `{ "error": "invalid_request" }` |
| no / invalid JWT | 401 | `{ "error": "unauthorized" }` |
| not a Super Admin / tenant_admin of that tenant, tenant suspended | 403 | `{ "error": "forbidden" }` |
| aal1 or no live authenticator | 403 | `{ "error": "mfa_required" }` (step up, retry the same request) |
| unknown / foreign invitation | 404 | `{ "error": "not_found" }` |
| e-mail already has an account or a pending invitation / username taken / staff quota / wrong state | 409 | `email_in_use` / `username_taken` / `staff_limit_reached` / `invalid_state` |
| throttled (edge, or resend gap 60 s / 5 sends) | 429 | `{ "error": "try_later" }` + `Retry-After` |
| anything else | 503 | `{ "error": "server_error" }` |

Service role (confined here): `auth.admin.inviteUserByEmail`, `auth.admin.getUserById` / `deleteUser` (only a never-confirmed invitee), and the service-only RPCs
`fn_attach_tenant_admin_invitation` / `fn_abort_tenant_admin_invitation`. Env: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `ALLOWED_ORIGINS`,
`INVITE_REDIRECT_URL` (see `../README.md`).

Status: `deno check` passes (Deno 2.9 via npx); **not executed against a real Supabase stack** (GoTrue e-mail delivery untested). Pure logic:
`tests/unit/tenant-admin-invite-logic.test.ts`; SQL side: `supabase/tests/database/35_tenant_admin_invitations.test.sql`.
