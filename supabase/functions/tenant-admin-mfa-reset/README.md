# tenant-admin-mfa-reset (Edge Function)

A Super Admin removes the authenticator(s) of a Tenant Admin who lost them (owner decision 2026-10-11), so the Tenant Admin can sign in
with the password and enrol a new one. Platform Admin Portal only. Classification: **Private**. Full contract: `docs/api/portals.md`.

`POST /functions/v1/tenant-admin-mfa-reset`, header `Authorization: Bearer <super admin access token>`, JSON body (max 2048 bytes, exactly these keys):
```json
{ "restaurant_id": "<uuid>", "profile_id": "<uuid>", "reason": "Lost phone, identity confirmed by call" }
```
`reason`: trimmed, 3..500 characters (recorded in `admin_audit_log`).

| result | status | body |
|---|---|---|
| reset done | 200 | `{ "profile_id", "mfa_reset": true, "sessions_revoked": <int or null>, "devices_revoked": <int> }` |
| bad shape / bad reason | 400 | `{ "error": "invalid_request" }` |
| no / invalid JWT | 401 | `{ "error": "unauthorized" }` |
| not an active Super Admin, own account | 403 | `{ "error": "forbidden" }` |
| no MFA-satisfied session | 403 | `{ "error": "mfa_required" }` |
| no real TOTP verification in the last 12 h | 403 | `{ "error": "step_up_required" }` |
| unknown restaurant / profile, not a tenant_admin of that restaurant, inactive | 404 | `{ "error": "not_found" }` |
| the Tenant Admin has no verified authenticator | 409 | `{ "error": "no_factor" }` |
| throttled | 429 | `{ "error": "try_later" }` |
| anything else (incl. a factor GoTrue could not delete: nothing was revoked, retry) | 503 | `{ "error": "server_error" }` |

Steps: `auth.getUser` -> `fn_platform_prepare_mfa_reset` AS THE CALLER (audited `tenant_admin.mfa_reset_requested`) -> service role
`auth.admin.mfa.deleteFactor({ id, userId })` for every factor id it returned -> service role `fn_platform_complete_mfa_reset(profile_id,
caller id, reason)`, which refuses (`invalid_state/factors_remain`) while a verified factor remains, otherwise revokes the user's trusted devices
(reason `mfa_reset`), drops their device attestations and deletes every auth session of the user, audited `tenant_admin.mfa_reset`
(admin_audit_log, actor = the Super Admin) and `auth.mfa_reset_by_platform` (the tenant's audit_logs, actor_type platform_admin).
Access tokens already issued stay signed until they expire (<= 1 h) but no longer satisfy any MFA gate (no verified factor).

Rate limits: 20 requests / IP burst (0.2/s refill), 5 / Super Admin burst (1/min refill).

Status: **not executed against a real Supabase stack** (no Deno / Docker here). Logic: `tests/unit/tenant-admin-mfa-reset-logic.test.ts`;
SQL: `supabase/tests/database/48_plan_features_mfa_reset.test.sql`.
