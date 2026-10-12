# tenant-admin-mfa-reset (Edge Function)

A Super Admin removes the authenticator(s) of a Tenant Admin who lost them (owner decision 2026-10-11) and forces credential
re-proof: the password is replaced with a random value and a password-recovery e-mail goes to the Tenant Admin's registered address.
A phone call plus a stolen password is therefore not enough to take the account over: the new owner must also control the inbox.
Platform Admin Portal only. Classification: **Private**. Full contract: `docs/api/portals.md`.

`POST /functions/v1/tenant-admin-mfa-reset`, header `Authorization: Bearer <super admin access token>`, JSON body (max 2048 bytes, exactly these keys):
```json
{ "restaurant_id": "<uuid>", "profile_id": "<uuid>", "reason": "Lost phone, identity confirmed by call" }
```
`reason`: trimmed, 3..500 characters. The function pre-checks with JS `trim()`; SQL `fn_platform_reason` (btrim, spaces only) is
authoritative. The reason is recorded in `admin_audit_log` and in the tenant's `audit_logs`.

| result | status | body |
|---|---|---|
| reset done | 200 | `{ "profile_id", "mfa_reset": true, "factors_removed": <int>, "sessions_revoked": <int or null>, "devices_revoked": <int>, "password_rotated": true, "recovery_sent": <bool> }` |
| bad shape / bad reason | 400 | `{ "error": "invalid_request" }` |
| no / invalid JWT | 401 | `{ "error": "unauthorized" }` |
| not an active Super Admin, own account; requester no longer an active Super Admin at completion | 403 | `{ "error": "forbidden" }` |
| no MFA-satisfied session | 403 | `{ "error": "mfa_required" }` |
| no real TOTP verification in the last 12 h | 403 | `{ "error": "step_up_required" }` |
| unknown restaurant / profile, not a tenant_admin of that restaurant, inactive (at prepare or completion) | 404 | `{ "error": "not_found" }` |
| no verified authenticator and no half-done reset to finish | 409 | `{ "error": "no_factor" }` |
| the reset row expired (> 5 min), was already completed, or was superseded by a newer completed reset | 409 | `{ "error": "reset_expired" }` |
| throttled | 429 | `{ "error": "try_later" }` |
| anything else (incl. a factor GoTrue could not delete -> `factors_remain`, or the password rotation failed): the reset is NOT completed, run it again | 503 | `{ "error": "server_error" }` |

`sessions_revoked` is `null` when the database role may not delete `auth.sessions` (possible on hosted Supabase). The sessions are
then not signed out by GoTrue, but none of them can pass an MFA gate again (see below); the portal shows a warning instead of
"They were signed out". `recovery_sent: false` means GoTrue refused the recovery e-mail (rate limit, SMTP, captcha): the reset
itself stands and the portal warns that the Tenant Admin needs a recovery e-mail before they can sign in.

## Steps

1. `auth.getUser(token)`; rate limits.
2. AS THE CALLER `fn_platform_prepare_mfa_reset(restaurant_id, profile_id, reason)`: Super Admin + MFA session + TOTP at most 12 h old,
   target an ACTIVE tenant_admin of that restaurant (else `not_found`), never the caller. Needs a verified factor (else
   `invalid_state/no_factor`) unless a half-done reset is pending (`fn_mfa_reset_pending`: an earlier reset's factors were deleted
   but it never completed). Inserts a single-use `public.mfa_resets` row (expires in 5 min; RLS forced, no API-role privilege) and
   audits `tenant_admin.mfa_reset_requested`. Returns `{ reset_id, profile_id, user_id, factor_ids }`; `factor_ids` is empty when
   finishing.
3. SERVICE ROLE `auth.admin.mfa.deleteFactor({ id, userId })` for every factor id.
4. SERVICE ROLE `auth.admin.updateUserById(userId, { password })` with base64url(32 random bytes) + `aA1!` (passes any GoTrue
   strength policy). Never logged or returned. On failure: 503, the reset is not completed (run it again; step 2 lets it finish).
5. SERVICE ROLE `fn_platform_complete_mfa_reset(reset_id)`: locks the row; unknown -> `not_found`, completed ->
   `invalid_state/reset_completed`, expired -> `invalid_state/reset_expired`, older than the user's latest completed reset ->
   `invalid_state/reset_superseded`. Actor, target, tenant and reason come from the row. If the requester is no longer an active
   Super Admin or the target no longer an active tenant_admin of that tenant: raises while a verified factor remains; once the
   factors are gone it RETURNS `{ profile_id, refused }` and writes `tenant_admin.mfa_reset_incomplete` (an exception would roll
   the audit row back). Refuses `invalid_state/factors_remain` while a verified factor remains. Otherwise revokes the live trusted
   devices (reason `mfa_reset`), deletes the session attestations and every `auth.sessions` row of the user, stamps
   `completed_at`, and audits `tenant_admin.mfa_reset` (admin_audit_log, actor = the requesting Super Admin) and
   `auth.mfa_reset_by_platform` (the tenant's audit_logs, actor_type platform_admin, with the reason).
6. Anon client `auth.resetPasswordForEmail(<registered e-mail>, { redirectTo: RECOVERY_REDIRECT_URL })` (implicit flow). Sent AFTER
   step 5 so the recovery session is newer than `completed_at`. The e-mail address is read with the service role
   (`auth.admin.getUserById`), never taken from the request.

## Sessions that survive the reset

`fn_mfa_session_ok()` (every portal MFA gate) and `fn_require_recent_totp()` (step-up actions, trusting a device) refuse any session
of a user with a completed reset unless the JWT `session_id` names an `auth.sessions` row created after the latest `completed_at`
(no row -> refused). A session that existed before the reset (not deleted on hosted Supabase, or opened with the stolen password)
therefore never reaches an MFA-gated action again, even after enrolling a new factor or attesting a device. Its access token stays
signed until it expires (<= 1 h) and its refresh token may keep refreshing where GoTrue still knows the session, but only at a level
that no tenant-admin or platform gate accepts.

## Environment

`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `ALLOWED_ORIGINS`, and **`RECOVERY_REDIRECT_URL`**:
`https://<app origin>/reset-password` (the app's set-new-password page). Absolute `https://` URL (or `http://localhost` / `127.0.0.1` / `*.localhost` for local), no credentials, no fragment (same rule as
`INVITE_REDIRECT_URL`); it must also be in GoTrue's redirect allow-list. Missing or unsafe -> the function is disabled (every call
503, fail closed).

Rate limits: 20 requests / IP burst (0.2/s refill), 5 / Super Admin burst (1/min refill).

Status: **not executed against a real Supabase stack** (no Deno here). Logic: `tests/unit/tenant-admin-mfa-reset-logic.test.ts`;
SQL: `supabase/tests/database/48_plan_features_mfa_reset.test.sql`; portal: `src/features/platform/components/TenantAdminsCard.test.tsx`,
`tests/e2e/platform-tenant-admins.spec.ts` (mocked backend).

## Landing page

`/reset-password` (`src/features/password-reset/ResetPasswordPage.tsx`, public route). It accepts only a `type=recovery` link; the
recovery session arrives in the URL fragment (the Supabase client has `detectSessionInUrl: false`, so the page reads it once, removes
it from the address bar and calls `auth.setSession`, which GoTrue validates). An expired / used link (GoTrue `error_code`, or a
session GoTrue rejects) asks the person to have the platform administrator reset again; any other link type is refused. The new
password follows the invitation policy (`src/lib/domain/password.ts`: 12..72 characters, letters and a digit; GoTrue's own policy
is authoritative), is set with `auth.updateUser({ password })` and is never logged or stored. The page then signs the account out
everywhere (`signOut({ scope: 'global' })`, falling back to a local sign-out) and sends the Tenant Admin to
`/r/<slug>/admin-login` (slug from the server-derived session context) with the notice "Password changed. Sign in, then set up your
authenticator again." Tests: `src/features/password-reset/*.test.ts(x)`, `tests/e2e/reset-password.spec.ts` (mocked backend).
