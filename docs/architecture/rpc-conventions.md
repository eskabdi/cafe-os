# RPC conventions

## Shape of every command function
- `language plpgsql security definer set search_path = ''`, every object schema-qualified.
- Tenant and caller are derived server-side by `fn_tenant_status_guard(p_write)` (returns the caller's `restaurant_id`);
  no function accepts a `restaurant_id` from the client (except platform/service functions that act on a named tenant).
- Authorization: `has_permission('<key>')` / `is_platform_super_admin()` / `is_service_role()`, then input validation, then work,
  then audit (`fn_write_audit` event and/or row triggers).
- `EXECUTE`: since migration 0011 new functions get no PUBLIC/anon/authenticated/service_role execute by default; every function still revokes and grants explicitly in its migration.

## Error convention (single, mandatory)
```sql
raise exception using errcode = 'P0001', message = '<stable_machine_code>', detail = '<safe context>';
-- implemented as: perform public.fn_err('<code>', '<detail>');
```
- `message` is the machine code the client maps to a user message. `detail` is optional, safe context (a field name, a permission key
  the caller supplied); never SQL, ids of other tenants, or secrets.
- Unknown and cross-tenant ids both yield `not_found` (no existence oracle).
- Database-native violations keep their SQLSTATE (`23503` restrict, `23505` unique, `23514` check, `42501` RLS/privilege) and are mapped at the UI boundary.

| code | meaning |
|---|---|
| `not_authenticated` | no JWT subject |
| `permission_denied` | no active profile, missing permission, or platform/service-only function |
| `permission_escalation` | caller tried to grant/assign more than they hold |
| `tenant_suspended` / `tenant_read_only` | tenant suspended or cancelled / past_due write |
| `not_found`, `invalid_input`, `invalid_state` | generic validation |
| `invalid_role`, `invalid_permission`, `invalid_station` | matrix / assignment validation |
| `system_role_protected`, `last_tenant_admin` | tenant_admin invariants |
| `auth_method_mismatch`, `admin_requires_email_identity`, `pin_not_allowed`, `invalid_pin` | authentication-method rules |
| `owner_not_found`, `owner_email_mismatch`, `owner_already_assigned`, `invalid_plan`, `invalid_slug`, `slug_taken` | provisioning |
| `immutable_record`, `closed_day_immutable`, `day_closed`, `immutable_column`, `tenant_change_forbidden` | immutability triggers |
| `idempotency_conflict` | same (key, command), different payload hash |
| `mfa_required`, `use_suspend_rpc`, `last_platform_super_admin` | platform / MFA invariants |
| `invalid_timezone`, `invalid_expense_date`, `station_mismatch`, `table_mismatch`, `invalid_reversal` | validation / cross-row invariants |
| `invalid_auth_user`, `username_taken`, `staff_limit_reached`, `identity_not_rotated`, `owner_email_unconfirmed` | staff / identity provisioning |
| (reserved for later phases) `insufficient_stock`, `order_not_cancellable`, `invalid_state_transition`, `voucher_already_settled` | |

## Phase-1 functions
| function | callers | notes |
|---|---|---|
| `fn_provision_tenant(name, slug, owner_user_id, owner_email, first, middle, last, plan_id, owner_username?, require_confirmed = true)` | service_role, platform super admin | **owner email must be confirmed** (`false` only for service_role: seed/CI); reserved slug => `invalid_slug`. trialing tenant, 14-day subscription, defaults, owner profile with `auth_method='password'` and **no** `profile_secrets`, day 1 open. Owner must be a real email identity |
| `fn_seed_tenant_defaults(restaurant_id)` | internal only | roles, matrix, stations, categories, payment methods, areas, expense categories as rows |
| `fn_update_role_permissions(role_id, keys[], station_ids[])` | `roles.manage` | replaces the role's matrix; tenant_admin and own role immutable; non-admins cannot newly grant what they lack |
| `fn_change_user_role(profile_id, role_id)` | `users.manage` | tenant_admin assignment needs tenant_admin; no self change by non-admins; last admin protected; promotion deletes the PIN secret and sets `password`; demotion sets `pin`; if the identity still has a real email it returns `requires_identity_rotation` and the profile is not PIN-eligible until `fn_complete_identity_rotation`. Takes the tenant_admin role row lock (last-admin race), step-up (`mfa_required`) for enrolled admins |
| `fn_set_user_pin(profile, digest)` / `fn_verify_pin(profile, digest)` / `fn_register_pin_failure` | service_role | **digest = 64-hex HMAC-SHA256(pin, PIN_PEPPER) computed by the Edge Function; raw PINs are refused (`invalid_pin`)**; bcrypt of the digest. `fn_verify_pin` locks the secret row `FOR UPDATE`, answers only `{status: ok, profile}` or `{status: invalid}`, never raises on a bad PIN, never returns `pin_hash`; escalating lock (see security-controls). Refuses tenant_admin, platform admins, pending-rotation and inactive accounts identically |
| `fn_reset_pin_lockout(profile)` | `users.manage` | zeroes counter + lock, audited, non-escalation applies |
| `fn_prepare_staff_creation(username, role_id)` / `fn_create_staff_profile(auth_user, first, middle, last, username, role_id)` | `users.manage` | used by the `staff-create` Edge Function; see auth-flows |
| `fn_complete_identity_rotation(profile)` | service_role | clears `identity_rotation_pending` once the auth user has the synthetic email + `app_metadata.staff` |
| `fn_get_restaurant_settings()` / `fn_get_open_day()` | `settings.manage`/`reports.view` / any tenant user | tin + opening_float / `{id, day_no, opened_at}` |
| `fn_auth_password_verification_hook(event)` | supabase_auth_admin only | rejects password sign-in for `auth_method='pin'` |
| `fn_user_auth_method(user_id)` | service_role, supabase_auth_admin | helper (the hook itself no longer needs it) |
| `fn_tenant_status_guard(write)` | internal | see error table |
| `fn_suspend_tenant` / `fn_reactivate_tenant` | platform super admin | require a reason, write `admin_audit_log` + tenant audit |
| `fn_resolve_tenant_slug(slug)` | anon | id, name, branding only; unknown/suspended/cancelled => NULL |
| `fn_get_session_context()` | authenticated | profile, tenant (no tin/opening_float), role, permission keys, station ids, writable flag, `open_day`, and for platform admins `platform_mfa` |
| `fn_idempotency_begin(key, command, request_hash)` / `fn_idempotency_complete(key, command, result)` | internal | unique per (tenant, key, command); a payload hash is mandatory |
| `fn_write_audit`, `fn_write_admin_audit`, `fn_next_number` | internal | `fn_write_audit(event, record, restaurant?)`: actor is only `auth.uid()` (no actor parameter, no direct EXECUTE for anyone) |

## Closed-day allowlist (open question for Phase 4/9)
`fn_guard_closed_day(kind, allowed_columns)` is the single place that decides what may still change after a day closes (installment collection, customer
session status). If a late installment must flip `orders.payment_status` of a closed-day order, add that column to the orders trigger argument; never bypass the guard.
