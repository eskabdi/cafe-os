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
| `insufficient_stock` (detail = the tenant's own ingredient name), `duplicate_name`, `plan_limit_reached` (detail `menu_items`) | menu / inventory (0029) |
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
| `fn_set_menu_item_active(id, active)` | `menu.manage` | soft deactivation / reactivation (reactivation re-checks the plan cap) |
| `fn_set_recipe(menu_item_id, lines)` | `menu.manage` | `lines = [{ingredient_id, qty_per_serving}]` (<= 50, qty > 0, <= 3 decimals, unique, ingredients active in the tenant); replaces the recipe (`[]` clears); audit event only when it changed |
| `fn_create_ingredient(name, station_id, unit, min_level = 0, cost_per_unit = 0, initial_stock = 0)` | `inventory.adjust` | `initial_stock > 0` writes an `opening` ledger row and needs the open day (`day_closed`) |
| `fn_update_ingredient(id, patch)` | `inventory.adjust` | keys: name, station_id, unit, min_level, cost_per_unit; `unit` is locked (`invalid_state` / `unit_locked`) once any movement exists; stock is never patchable |
| `fn_set_ingredient_active(id, active)` | `inventory.adjust` | deactivation refused (`invalid_state` / `ingredient_in_active_recipe`) while an active menu item's recipe uses it |
| `fn_receive_stock(ingredient_id, qty, idempotency_key, note?)` | `inventory.receive` | qty > 0, <= 3 decimals; ledger row `received`; active ingredient only; idempotent per (tenant, key, `stock.receive`) with a payload hash (`idempotency_conflict`) |
| `fn_adjust_stock(ingredient_id, qty_delta, reason, idempotency_key)` | `inventory.adjust` | signed non-zero delta; `reason` (3..300 chars) is mandatory and stored on the row (`manual_adjustment`); below-zero => `insufficient_stock`; **step-up**: `abs(delta) * cost_per_unit >= 5000` calls `fn_require_step_up()` (`mfa_required` for enrolled / forced admins); idempotent (`stock.adjust`) |
| `fn_reverse_stock_movement(movement_id, reason, idempotency_key)` | `inventory.adjust` | compensating row (`reversal`, `reverses_movement_id`) for received / manual_adjustment / opening / correction rows; once only (`invalid_state` / `already_reversed`); reversal and consumption rows are `not_reversible` here; same step-up value rule; idempotent (`stock.reverse`) |
| `fn_list_stock_movements(ingredient_id?, limit = 50 (1..200), before?)` | `inventory.view` + (station access OR `inventory.adjust` OR `inventory.receive`) | jsonb array newest first with ingredient name / unit / actor short name; own tenant only; readable while past_due |
| `fn_post_stock_movement(rid, ingredient, delta, reason, note, order?, reverses?)` | internal | THE only writer of `stock_movements` and `ingredients.stock` / `received_today` / `consumed_today` (row-locked, open day required, never below zero) |
| `fn_apply_recipe_consumption(order_id, menu_item_id, qty)` / `fn_reverse_order_consumption(order_id)` | internal (Phase 4: `fn_submit_order` / `fn_cancel_order`) | one negative `consumed` row per recipe line in ingredient-id order (no deadlocks); atomic `insufficient_stock`; cancellation writes compensating `reversal` rows for the order's unreversed consumption, a second call is a no-op |
| `fn_stock_day`, `fn_menu_check_refs`, `fn_menu_check_image`, `fn_menu_item_json`, `fn_ingredient_json` | internal | helpers; no client EXECUTE |

Stock model: `stock_movements` is the append-only ledger; `ingredients.stock` is the transactionally maintained running total, equal to `sum(qty_delta)` (asserted for every ingredient by `30_menu_inventory`).
Idempotency keys are 8..128 chars and tenant-scoped. Direct client DML on `menu_items` / `recipe_lines` / `ingredients` master columns (0007/0020 grants + RLS) is unchanged and still audited by row triggers; the RPCs are the path that adds plan limits, reference validation, ledger rows and event audit.

## Closed-day allowlist (open question for Phase 4/9)
`fn_guard_closed_day(kind, allowed_columns)` is the single place that decides what may still change after a day closes (installment collection, customer
session status). If a late installment must flip `orders.payment_status` of a closed-day order, add that column to the orders trigger argument; never bypass the guard.
