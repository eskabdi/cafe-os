# RPC conventions

## Shape of every command function
- `language plpgsql security definer set search_path = ''`, every object schema-qualified.
- Tenant and caller are derived server-side by `fn_tenant_status_guard(p_write)` (returns the caller's `restaurant_id`);
  no function accepts a `restaurant_id` from the client (except platform/service functions that act on a named tenant).
- Authorization: `has_permission('<key>')` / `fn_platform_guard()` (every platform RPC since 0030: active super admin + aal2 + verified factor, no opt-out) /
  `is_service_role()`, then input validation, then work, then audit (`fn_write_audit` event and/or row triggers; platform writes also `fn_write_admin_audit`).
- Write path: where an RPC exists for a table, clients hold no INSERT / UPDATE / DELETE privilege on it (0029: menu / recipes / ingredients; 0030: plans,
  subscriptions, platform_invoices, platform_admins; 0031: roles, profiles UPDATE, restaurants UPDATE). The RLS write policies stay as a second ceiling.
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
| `insufficient_stock` (detail = the tenant's own ingredient name), `duplicate_name` (only the tenant name key; any other unique violation is `invalid_state` / `unique_conflict`), `plan_limit_reached` (detail `menu_items`), `invalid_state` details `unit_locked`, `ingredient_inactive`, `ingredient_in_active_recipe`, `already_reversed`, `not_reversible` | menu / inventory (0029) |
| `role_in_use` (detail `active_users:<n>` / `users:<n>`), `email_in_use`, `invite_rate_limited`, `invitation_expired`, `invalid_state` details `self`, `invoice_exists`, `already_attached`, `already_confirmed`, `inactive` | portals (0030 / 0031) |
| (reserved for later phases) `order_not_cancellable`, `invalid_state_transition`, `voucher_already_settled` | |

## Phase-1 functions
| function | callers | notes |
|---|---|---|
| `fn_provision_tenant(name, slug, owner_user_id, owner_email, first, middle, last, plan_id, owner_username?, require_confirmed = true)` | service_role, platform super admin | **owner email must be confirmed** (`false` only for service_role: seed/CI); reserved slug => `invalid_slug`. trialing tenant, 14-day subscription, defaults, owner profile with `auth_method='password'` and **no** `profile_secrets`, day 1 open. Owner must be a real email identity |
| `fn_seed_tenant_defaults(restaurant_id)` | internal only | roles, matrix, stations, categories, payment methods, areas, expense categories as rows |
| `fn_update_role_permissions(role_id, keys[], station_ids[])` | `roles.manage` | replaces the role's matrix; tenant_admin and own role immutable; non-admins cannot newly grant what they lack |
| `fn_change_user_role(profile_id, role_id)` | `users.manage` | tenant_admin assignment needs tenant_admin; no self change by non-admins; last admin protected; promotion deletes the PIN secret and sets `password`; demotion sets `pin`; if the identity still has a real email it returns `requires_identity_rotation` and the profile is not PIN-eligible until `fn_complete_identity_rotation`. Takes the tenant_admin role row lock (last-admin race), step-up (`mfa_required`) for enrolled admins |
| `fn_set_user_pin(profile, digest)` / `fn_verify_pin(profile, digest)` / `fn_register_pin_failure` | service_role | **digest = 64-hex HMAC-SHA256(pin, PIN_PEPPER) computed by the Edge Function; raw PINs are refused (`invalid_pin`)**; bcrypt of the digest. `fn_verify_pin` locks the secret row `FOR UPDATE`, answers only `{status: ok, profile}` or `{status: invalid}`, never raises on a bad PIN, never returns `pin_hash`; escalating lock (see security-controls). Refuses tenant_admin, platform admins, pending-rotation and inactive accounts identically |
| `fn_reset_pin_lockout(profile)` | `users.manage` | zeroes counter + lock, audited, non-escalation applies; does NOT clear `must_change_pin` |
| `fn_staff_has_active_session(profile)` / `fn_staff_login_blocked(profile, kiosk_token_hash?)` | service_role | single-session rule (see auth-flows). The first is false for admins / non-PIN / unknown ids; the second never raises for them and returns `{notified}`; it sets `must_change_pin` (and clears a pending approval), writes deduped `user_notifications` (user + active tenant_admins) and an audit row |
| `fn_complete_forced_pin_change(profile, digest, claimed_length?)` | service_role | same validation as `fn_set_user_pin`; returns `{pending_approval}`. Decides under the secret row lock: flagged => PIN stored, `pin_change_pending = true`, tenant_admins notified, audit `auth.pin_change_requested`; already pending => stays pending (no bypass, no new notification); otherwise exactly `fn_set_user_pin`. `fn_set_user_pin` itself now also clears pending (admin-set PIN) |
| `fn_approve_pin_change(profile)` / `fn_reject_pin_change(profile)` | `users.manage` + **aal2** (`fn_require_aal2`: `mfa_required` for every aal1 session, every PIN account even on an aal2 JWT (0027), admins without a verified factor, and an aal2 token whose factor was removed (0028); checked before validation and lookup) | `{profile_id, status: approved\|rejected}`; tenant from identity; own id => `permission_denied`; a role the caller does not cover => `permission_escalation`; unknown / foreign / not-pending / replay => `not_found`; row-locked; notify the subject (`security.pin_change_approved` / `_rejected`), audit `auth.pin_change_approved` / `_rejected`; reject re-flags `must_change_pin` |
| `fn_list_pending_pin_changes()` | `users.manage` | jsonb array `[{profile_id, user_name (short First+Middle), role_label, requested_at}]`, own tenant, oldest first |
| `fn_require_aal2()` | internal | raises `mfa_required` unless `auth.jwt()->>'aal' = 'aal2'` AND the caller's profile (`id = auth.uid()`) exists with `auth_method <> 'pin'` (0027) AND `auth.uid()` owns a verified `auth.mfa_factors` row (0028, same predicate as `fn_require_step_up`; fails closed without a profile or factor; no GUC); used only by `fn_decide_pin_change` and `fn_store_session_timers`; no client EXECUTE |
| `fn_pin_restricted(user)` / `fn_decide_pin_change(profile, approve)` | internal | the single restriction predicate / shared body of approve and reject; no client EXECUTE |
| `fn_get_session_timers()` | any active member of a non-suspended tenant (`fn_tenant_status_guard(false)`; past_due may read; **no permission**, works while a PIN change is required/pending) | `{idle_warning_seconds, signout_seconds, pin_pad_idle_seconds}` (integers) of the caller's tenant |
| `fn_update_session_timers(idle_warning_seconds, signout_seconds, pin_pad_idle_seconds)` | `settings.session_timers` + **aal2** (`fn_require_aal2`, no pass without a live verified authenticator), writable tenant | validation `invalid_input` with detail = the field name (`idle_warning_seconds` also when `>= signout_seconds`); null/out of range refused; returns the stored values (same shape as get); row-locked; audit `settings.session_timers_updated` `{old, new, reset: false}` only when something changed (a replay writes nothing) + row audit |
| `fn_reset_session_timers()` | same as update | stores the column defaults (15 / 30 / 60), returns them; audit `{old, new, reset: true}` |
| `fn_store_session_timers(...)` / `fn_session_timers_json(restaurant)` / `fn_create_session_settings()` | internal | shared body of update/reset; the JSON shape (defaults if a row were missing); `restaurants` insert trigger |
| `fn_kiosk_terminal_bootstrap(token_hash, slug)` | service_role | NULL for every invalid kiosk (same rules as `fn_kiosk_roster`) else `{staff: <fn_kiosk_roster array>, pin_pad_idle_seconds}` of the KIOSK's tenant |
| `fn_mark_notification_read(id)` | authenticated (own rows) | `{id, read_at}`; unknown, foreign-tenant and other users' ids are all `not_found`; works while a PIN change is pending |
| `fn_prepare_staff_creation(username, role_id)` / `fn_create_staff_profile(auth_user, first, middle, last, username, role_id)` | `users.manage` | used by the `staff-create` Edge Function; see auth-flows |
| `fn_complete_identity_rotation(profile)` | service_role | clears `identity_rotation_pending` once the auth user has the synthetic email + `app_metadata.staff` |
| `fn_get_restaurant_settings()` / `fn_get_open_day()` | `settings.manage`/`reports.view` / any tenant user | tin + opening_float / `{id, day_no, opened_at}` |
| `fn_auth_password_verification_hook(event)` | supabase_auth_admin only | rejects password sign-in for `auth_method='pin'` |
| `fn_user_auth_method(user_id)` | service_role, supabase_auth_admin | helper (the hook itself no longer needs it) |
| `fn_tenant_status_guard(write)` | internal | see error table |
| `fn_suspend_tenant` / `fn_reactivate_tenant` | platform super admin | require a reason, write `admin_audit_log` + tenant audit |
| `fn_resolve_tenant_slug(slug)` | anon | name and branding only (**no tenant id** since 0020; pin-login resolves the id with the service role); unknown/suspended/cancelled => NULL |
| `fn_get_session_context()` | authenticated | `session_timers` `{idle_warning_seconds, signout_seconds, pin_pad_idle_seconds}` (0025; every tenant user, also while restricted; absent for a platform admin without a tenant profile), `must_change_pin` (true only while `pin_change_status = 'required'`), `pin_change_status` (`none\|required\|pending_approval`), `pin_length` (4; 6 for Cashier) (permissions and station_ids are empty unless status is `none`), profile, tenant (no tin/opening_float), role, permission keys, station ids, writable flag, `open_day`, and for platform admins `platform_mfa` |
| `fn_idempotency_begin(key, command, request_hash)` / `fn_idempotency_complete(key, command, result)` | internal | unique per (tenant, key, command); a payload hash is mandatory |
| `fn_write_audit`, `fn_write_admin_audit`, `fn_next_number` | internal | `fn_write_audit(event, record, restaurant?)`: actor is only `auth.uid()` (no actor parameter, no direct EXECUTE for anyone) |

## Phase-3 functions (migration 0029, menu and inventory)
All: tenant guard -> permission -> input validation -> lock -> work -> audit event. Unknown and foreign ids both answer `not_found`; reference ids
(category / station / ingredient) that are unknown, foreign or inactive answer `invalid_input` (detail = field) or `invalid_station`.
Patch functions take a `jsonb` object with a closed key list (anything else, e.g. `restaurant_id` or `stock`, is `invalid_input` / `patch`); a no-op writes no audit event.
| function | permission | notes |
|---|---|---|
| `fn_create_menu_item(name, category_id, station_id, price, description?, emoji?, image_path?, sort_order = 0)` | `menu.manage` | price numeric, max 2 decimals (never rounded silently); `image_path` must be `restaurants/<own tenant>/menu/<file>.(png\|jpg\|jpeg\|webp)` AND an uploaded object of bucket `menu-images`; `duplicate_name`; `plan_limit_reached` (plan `max_menu_items` over active items, advisory-locked); returns the item json |
| `fn_update_menu_item(id, patch)` | `menu.manage` | keys: name, description, category_id, station_id, price, emoji, image_path, sort_order; null clears description / emoji / image_path only |
| `fn_set_menu_item_active(id, active)` | `menu.manage` | soft deactivation / reactivation (reactivation re-checks the plan cap AND locks the recipe's ingredients `FOR SHARE` and refuses `invalid_state` / `ingredient_inactive` if one is inactive) |
| `fn_set_recipe(menu_item_id, lines)` | `menu.manage` | `lines = [{ingredient_id, qty_per_serving}]` (<= 50, qty > 0, <= 3 decimals, unique, ingredients active in the tenant, locked `FOR SHARE` in id order so a concurrent deactivation / unit change waits and then sees the recipe); replaces the recipe (`[]` clears); audit event only when it changed |
| `fn_create_ingredient(name, station_id, unit, min_level = 0, cost_per_unit = 0, initial_stock = 0)` | `inventory.adjust` | `initial_stock > 0` writes an `opening` ledger row, needs the open day (`day_closed`) and follows the stock step-up rule |
| `fn_update_ingredient(id, patch)` | `inventory.adjust` | keys: name, station_id, unit, min_level, cost_per_unit; `unit` is locked (`invalid_state` / `unit_locked`) once any movement exists OR a recipe line uses it; changing `cost_per_unit` of an ingredient with any movement calls `fn_require_step_up()`; audit carries old / new cost; stock is never patchable |
| `fn_set_ingredient_active(id, active)` | `inventory.adjust` | deactivation refused (`invalid_state` / `ingredient_in_active_recipe`) while an active menu item's recipe uses it |
| `fn_receive_stock(ingredient_id, qty, idempotency_key, note?)` | `inventory.receive` | qty > 0, <= 3 decimals; ledger row `received`; active ingredient only; **stock step-up rule**; idempotent per (tenant, key, `stock.receive`) with a payload hash (`idempotency_conflict`) |
| `fn_adjust_stock(ingredient_id, qty_delta, reason, idempotency_key)` | `inventory.adjust` | signed non-zero delta; `reason` (3..300 chars) is mandatory and stored on the row (`manual_adjustment`); below-zero => `insufficient_stock`; **stock step-up rule**; idempotent (`stock.adjust`) |
| `fn_reverse_stock_movement(movement_id, reason, idempotency_key)` | `inventory.adjust` | compensating row (`reversal`, `reverses_movement_id`) for received / manual_adjustment / opening / correction rows; once only (`invalid_state` / `already_reversed`); reversal and consumption rows are `not_reversible` here; **stock step-up rule**; idempotent (`stock.reverse`) |
| `fn_list_stock_movements(ingredient_id?, limit = 50 (1..200), before?, before_id?)` | `inventory.view` + (station access OR `inventory.adjust` OR `inventory.receive`) | jsonb array newest first (`created_at desc, id desc`) with ingredient name / unit / actor short name; keyset: pass the last row's `created_at` and `id` as `before` / `before_id` (rows sharing a timestamp are not lost); `before` alone = `created_at < before`; `before_id` without `before` = `invalid_input` / `before`; own tenant only; readable while past_due |
| `fn_set_stock_stepup_threshold(threshold)` | `settings.manage` + `fn_require_aal2()` (aal2 session, verified factor, not a PIN account; subsumes step-up) | ETB 100..1000000, max 2 decimals (`invalid_input` / `stock_stepup_threshold`); writes `restaurants.stock_stepup_threshold` of the caller's tenant only; audit `settings.stock_stepup_threshold_updated` {old, new} (no event for an identical value); returns `{stock_stepup_threshold}` |
| `fn_post_stock_movement(rid, ingredient, delta, reason, note, order?, reverses?)` | internal | THE only writer of `stock_movements` and `ingredients.stock` / `received_today` / `consumed_today` (row-locked, open day required, never below zero, resulting stock / counters pre-checked `<= 999999999.999` else `invalid_input` / `qty`; actor = caller's profile only if it belongs to the tenant, else null) |
| `fn_apply_recipe_consumption(order_id, menu_item_id, qty)` / `fn_reverse_order_consumption(order_id)` | internal (Phase 4: `fn_submit_order` / `fn_cancel_order` / QR pipeline) | tenant derived from `orders.restaurant_id` (NOT the caller's profile, so QR / table-session orders work); the Phase-4 caller owns authorisation, tenant status and the order lock; one negative `consumed` row per recipe line in ingredient-id order (no deadlocks); atomic `insufficient_stock`; cancellation writes compensating `reversal` rows for the order's unreversed consumption, a second call is a no-op. **An order whose business day is closed raises `day_closed` on reversal (detail `order business day is closed`); Phase 4 `fn_cancel_order` must handle it** (refuse, or post an explicit correction in the open day) |
| `fn_stock_step_up(rid, qty, cost)`, `fn_stock_stepup_threshold(rid)`, `fn_check_idempotency_key(key)`, `fn_stock_day`, `fn_menu_check_refs`, `fn_menu_check_image`, `fn_menu_item_json`, `fn_ingredient_json` | internal | helpers; no client EXECUTE |

**Stock step-up rule** (`fn_stock_step_up`): `fn_require_step_up()` (`mfa_required` for enrolled admins or `app.tenant_admin_mfa_required = on`) when
`|qty| * cost_per_unit >= threshold`, or `cost_per_unit = 0 and |qty| >= threshold`; threshold = `restaurants.stock_stepup_threshold` (default 5000 ETB).
Order inside the stock commands: tenant guard -> permission -> idempotency key format (before any lookup or lock) -> inputs -> row lock -> idempotency begin -> state checks -> step-up -> ledger write -> audit.

Stock model: `stock_movements` is the append-only ledger; `ingredients.stock` is the transactionally maintained running total, equal to `sum(qty_delta)` (asserted for every ingredient by `30_menu_inventory`).
Idempotency keys are 8..128 chars and tenant-scoped. **The RPCs are the only write path** for `menu_items` / `recipe_lines` / `ingredients`: 0029 revokes every client INSERT / UPDATE / DELETE privilege on them (SELECT under RLS stays), so plan limits, reference / image validation, unit lock, active-recipe rule, step-up and event audit cannot be bypassed.

Deferred to Phase 9 (day close): `received_today` / `consumed_today` are never reset yet (`fn_open_day` / `fn_close_day` must reset or derive them from the ledger), and the `ingredients` row-audit trigger still records the stock columns on every ledger write (exclude them, the ledger is the record).

## Closed-day allowlist (open question for Phase 4/9)
`fn_guard_closed_day(kind, allowed_columns)` is the single place that decides what may still change after a day closes (installment collection, customer
session status). If a late installment must flip `orders.payment_status` of a closed-day order, add that column to the orders trigger argument; never bypass the guard.

## Phase-3B functions (migrations 0030 / 0031, the two portals)
Full contract with request / response / error examples and Public / Private / Internal classification: `docs/api/portals.md`.

| function | callers | notes |
|---|---|---|
| `fn_platform_guard()` | internal | the single gate of every platform RPC: `not_authenticated` / `permission_denied` / `mfa_required`; returns the admin id |
| `fn_platform_list_tenants(search?, status?, plan_id?, limit = 50, offset = 0)`, `fn_platform_get_tenant(restaurant_id)` | super admin | metadata + subscription + limits + aggregate usage (`fn_tenant_usage`) + invitations + recent invoices; never operational rows |
| `fn_platform_create_tenant(name, slug, plan_id, trial_days = 14, timezone)` | super admin | provisioning without an owner; the first Tenant Admin is invited |
| `fn_platform_change_plan(restaurant_id, plan_id, reason)`, `fn_platform_set_billing_status(restaurant_id, status, reason)`, `fn_platform_cancel_tenant(restaurant_id, reason, confirm_slug)` | super admin | reason 3..500; replay = `changed: false`; cancellation terminal |
| `fn_platform_list_plans()`, `fn_platform_create_plan(jsonb)`, `fn_platform_update_plan(id, jsonb)`, `fn_platform_set_plan_active(id, active)` | super admin | closed key list; no delete |
| `fn_platform_list_invoices(restaurant_id?, status?, limit, before?, before_id?)`, `fn_platform_create_invoice(...)`, `fn_platform_set_invoice_status(id, status, method?, reference?)` | super admin | keyset `(created_at, id)`; one live invoice per period |
| `fn_platform_system_health()`, `fn_platform_list_backup_runs(limit, before?, before_id?)` | super admin | DB-side checks; backup runs written by service_role only |
| `fn_platform_list_audit_log(limit, before?, before_id?, restaurant_id?, action_prefix?, admin_id?)`, `fn_platform_list_admins()`, `fn_platform_set_admin_active(id, active, reason)` | super admin | keyset; never yourself; last super admin protected |
| `fn_ops_register_platform_admin(user_id, full_name)` | service_role | ops-only Super Admin registration |
| `fn_prepare_tenant_admin_invitation(...)`, `fn_prepare_tenant_admin_invitation_resend(id)`, `fn_revoke_tenant_admin_invitation(id)` | super admin (named tenant) or tenant_admin + aal2 (own tenant) | used by `tenant-admin-invite`; actor resolved by `fn_invitation_actor` |
| `fn_attach_tenant_admin_invitation(id, auth_user_id)`, `fn_abort_tenant_admin_invitation(id)` | service_role | Edge Function steps |
| `fn_get_my_invitation()`, `fn_accept_tenant_admin_invitation()` | the invitee | binding happens here (confirmed e-mail, not expired, no other identity) |
| `fn_list_tenant_admin_invitations()` | tenant_admin | own tenant |
| `fn_list_roles()`, `fn_create_role(jsonb)`, `fn_update_role(id, jsonb)`, `fn_set_role_active(id, active)`, `fn_delete_role(id)`, `fn_set_role_station_access(id, station_ids)` | `roles.manage` + step-up | system role protected; own role never; coverage rule for non-admins; `role_in_use` dependency guard |
| `fn_list_users(include_inactive)`, `fn_update_user(id, jsonb)`, `fn_set_user_active(id, active)`, `fn_prepare_pin_reset(id)` | `users.view` / `users.manage` (+ step-up for state and PIN) | trigger guards (escalation, last admin) apply |
| `fn_get_restaurant_profile()`, `fn_update_restaurant_profile(jsonb)` (step-up), `fn_update_business_settings(jsonb)` (aal2), `fn_update_restaurant_branding(primary, accent, logo_path)` (step-up), `fn_get_subscription_usage()` | `settings.manage` | closed key lists; logo must be an uploaded `tenant-branding` object under the own prefix |
| `fn_tenant_usage(rid)`, `fn_invitation_actor`, `fn_*_json`, `fn_*_normalize`, `fn_role_for_edit`, `fn_user_for_edit`, `fn_json_*`, `fn_check_patch`, `fn_platform_reason`, `fn_identity_lock` | internal | no client EXECUTE (pinned by `13_security_hygiene`) |
