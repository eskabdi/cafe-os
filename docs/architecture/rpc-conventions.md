# RPC conventions

## Shape of every command function
- `language plpgsql security definer set search_path = ''`, every object schema-qualified.
- Tenant and caller are derived server-side by `fn_tenant_status_guard(p_write)` (returns the caller's `restaurant_id`);
  no function accepts a `restaurant_id` from the client (except platform/service functions that act on a named tenant).
- Authorization: `has_permission('<key>')` / `is_platform_super_admin()` / `is_service_role()`, then input validation, then work,
  then audit (`fn_write_audit` event and/or row triggers).
- `EXECUTE` is revoked from `public, anon, authenticated` by default and granted explicitly in the migration's grant block.

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
| `idempotency_conflict` | same key, different command/payload |
| (reserved for later phases) `insufficient_stock`, `order_not_cancellable`, `invalid_state_transition`, `voucher_already_settled` | |

## Phase-1 functions
| function | callers | notes |
|---|---|---|
| `fn_provision_tenant(name, slug, owner_user_id, owner_email, first, middle, last, plan_id, owner_username?)` | service_role, platform super admin | trialing tenant, 14-day subscription, defaults, owner profile with `auth_method='password'` and **no** `profile_secrets`, day 1 open. Owner must be a real email identity |
| `fn_seed_tenant_defaults(restaurant_id)` | internal only | roles, matrix, stations, categories, payment methods, areas, expense categories as rows |
| `fn_update_role_permissions(role_id, keys[], station_ids[])` | `roles.manage` | replaces the role's matrix; tenant_admin and own role immutable; non-admins cannot newly grant what they lack |
| `fn_change_user_role(profile_id, role_id)` | `users.manage` | tenant_admin assignment needs tenant_admin; no self change by non-admins; last admin protected; promotion deletes the PIN secret and sets `password`; demotion sets `pin` and requires a new PIN |
| `fn_set_user_pin` / `fn_verify_pin` / `fn_register_pin_failure` | service_role | bcrypt (pgcrypto), 5 failures => 15 min lock. **Refuse for tenant_admin profiles and platform admins with the same result as an unknown account.** `fn_verify_pin` returns a status object and never raises on a bad PIN (the counter must commit); never returns `pin_hash` |
| `fn_user_auth_method(user_id)` | service_role, supabase_auth_admin | for an Auth hook that must block password login of PIN-only staff |
| `fn_tenant_status_guard(write)` | internal | see error table |
| `fn_suspend_tenant` / `fn_reactivate_tenant` | platform super admin | require a reason, write `admin_audit_log` + tenant audit |
| `fn_resolve_tenant_slug(slug)` | anon | id, name, branding only; unknown/suspended/cancelled => NULL |
| `fn_get_session_context()` | authenticated | profile, tenant, role, permission keys, station ids, writable flag |
| `fn_idempotency_begin/complete` | internal | tenant-scoped `idempotency_keys` |
| `fn_write_audit`, `fn_write_admin_audit`, `fn_next_number` | internal | actor always `auth.uid()` |
