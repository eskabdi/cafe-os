# RLS matrix (migrations 0007 + 0010 + 0022 + 0023 + 0024; 82 policies; RLS enabled AND forced on every public table)

Helpers (SECURITY DEFINER, empty search_path, identity from `profiles` via `auth.uid()`, never from JWT claims):
`current_restaurant_id()`, `current_user_id()`, `current_role_id()`, `has_permission(key)`, `has_station_access(station_id)` (RPC use), `current_station_ids()` (policies; one InitPlan per statement),
`is_platform_admin()`, `is_platform_super_admin()`, `is_tenant_admin()`, `current_tenant_writable()`.
Suspended/cancelled tenants resolve to NULL (no access); `past_due` is read-only (writes need `current_tenant_writable()`).
"T" = same tenant. "W" = tenant writable (trialing/active). Column grants further narrow UPDATE/INSERT (noted).

| table | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| plans | anon/auth: active; platform: all | platform super admin | platform super admin | platform super admin |
| restaurants | own row; platform admins all | none (fn_provision_tenant) | `settings.manage` + W, columns: name, phone, address, tin, vat_rate, opening_float, auto_consume_stock, timezone, branding; platform super admin | none |
| subscriptions | own; platform admins | platform super admin | platform super admin | platform super admin |
| platform_admins | self; platform admins | platform super admin | platform super admin | none (deactivate) |
| platform_invoices | own with `settings.manage`; platform admins (aal2) | super admin | super admin | super admin (all platform writes audited in `admin_audit_log`) |
| admin_audit_log | platform admins | none (definer fns) | trigger-blocked | trigger-blocked |
| audit_logs | T + `audit.view` | none (definer fns) | trigger-blocked for all roles | trigger-blocked for all roles |
| permissions | any active member | none | none | none |
| profiles | T and (self or `users.view`/`users.manage`) | none (server-side creation) | T + `users.manage` + W; columns: names, username, is_active; tenant_admin profiles only by tenant_admin | none |
| profile_secrets, tenant_counters, idempotency_keys | none (RLS on, zero policies, no grants) | none | none | none |
| roles | T | T + `roles.manage` + W (non-system only) | same, non-system only | same, non-system only (RESTRICT if users) |
| role_permissions, role_station_access | T and (own role or `roles.manage`) | none | none | none (only `fn_update_role_permissions`) |
| stations, categories, payment_methods, table_areas, expense_categories | T | T + `config.manage` + W | same | same (RESTRICT) |
| menu_items, recipe_lines | T + (`menu.view`/`menu.manage`/`orders.create`; recipes also `inventory.view`) | T + `menu.manage` + W | same | same |
| ingredients | T + (`inventory.view` + station access/`inventory.adjust`/`inventory.receive`) or `menu.manage` | T + `inventory.adjust` + W (master-data columns only) | same (stock columns RPC-only) | same |
| stock_movements | T + `inventory.view` + (station access or adjust/receive) | none (stock RPCs) | trigger-blocked | trigger-blocked |
| tables | T + (`tables.view`/`tables.manage`/`orders.create`) | T + `tables.manage` + W | same | same |
| table_sessions, customer_sessions | T + `tables.view`/`orders.view_all` (session token hash column not granted) | none (RPC) | none | none |
| qr_credentials | T + `qr.manage`/`tables.manage` (token_hash column not granted) | none (fn_manage_qr_credential later) | none | none |
| day_sessions | T + (`reports.view`/`day_close.execute`/`day.open`); operational staff use `fn_get_open_day()` | none (RPC) | none; closed rows trigger-frozen | none; trigger-blocked |
| orders | T + `orders.view` + (`orders.view_all` or own or `station_ids && current_station_ids()`) | none (fn_submit_order later) | none | none |
| order_items | T + `orders.view` + (`orders.view_all` or `station_id = any(current_station_ids())` or own order) | none | none | none |
| kiosk_devices | T + `kiosks.manage` (column grant: no `token_hash`) | none (`fn_register_kiosk`) | none (`fn_revoke_kiosk`; service role refreshes `last_seen_at`) | none |
| user_notifications | T and `recipient_id = auth.uid()` (own rows only, not even tenant_admin sees others'; column grant on every column, no secret column) | none (`fn_staff_login_blocked`, service-only) | none (`fn_mark_notification_read` sets `read_at` once; trigger refuses any other change, even for the owner role) | none |
| payments | T + `payments.view` | none (fn_confirm_payment later) | trigger-blocked for all roles | trigger-blocked for all roles |
| vouchers, installments | T + `vouchers.view` | none | none | none |
| expenses | T + `expenses.view`/`expenses.manage` | T + `expenses.manage` + W (actor, day, method snapshot set by trigger; **requires an open business day**, else `day_closed`; a foreign `restaurant_id` is refused with the RLS 42501 before any lookup) | same; frozen once its day is closed | same; frozen once its day is closed |

Policies per table: admin_audit_log 1, audit_logs 1, categories 4, customer_sessions 1, day_sessions 1, expense_categories 4, expenses 4,
ingredients 4, installments 1, kiosk_devices 1, menu_items 4, order_items 1, orders 1, payment_methods 4, payments 1, permissions 1, plans 5,
platform_admins 3, platform_invoices 4, profiles 2, qr_credentials 1, recipe_lines 4, restaurants 3, role_permissions 1,
role_station_access 1, roles 4, stations 4, stock_movements 1, subscriptions 4, table_areas 4, table_sessions 1, tables 4, user_notifications 1, vouchers 1;
profile_secrets, tenant_counters, idempotency_keys: 0 (deny all).

## Migration 0010 hardening (found by the adversarial suite, `supabase/tests/database/1*_*.test.sql`)
- **Realtime**: `qr_credentials` was removed from `supabase_realtime`. postgres_changes streams whole rows (column privileges do not apply),
  which would have sent `token_hash` to subscribers. Accepted residual: `orders.public_token_hash` (sha256 of a random tracking token) is still
  in the stream because `orders` needs REPLICA IDENTITY FULL; moving it to a side table is a Phase-4 option. Every published table has RLS
  enabled+forced and a `restaurant_id` (asserted by `13_security_hygiene`).
- `restaurants.branding.logo_path` must start with `restaurants/<own id>/` (CHECK `restaurants_logo_own_tenant_check`).
- `platform_admins` insert/update of `id` is refused when the id is a tenant profile (AFTER trigger `trg_guard_platform_admin`; a BEFORE trigger
  would have been an existence oracle ahead of the RLS check).
- `fn_expense_context` refuses a foreign `restaurant_id` first and requires an open day.

## Hygiene invariants asserted from the catalogs (`13_security_hygiene`)
Every function in `public` pins `search_path`; EXECUTE for PUBLIC = none, anon = `fn_resolve_tenant_slug`, authenticated = the reviewed list
(adding a client-callable function fails the test until the list is updated consciously); no view, materialized view or foreign table without
`security_invoker` (none exist); deny-all tables (`profile_secrets`, `tenant_counters`, `idempotency_keys`) carry no client privilege; no client
privilege on any `*hash*/*secret*/*token*/*password*` column; no `USING (true)` / FOR ALL policy; the total policy count (82) is pinned to this document.
**Every new migration that adds a function must `revoke all on function ... from public, anon, authenticated` explicitly** (Postgres grants PUBLIC
execute by default and a role-global default privilege now prevents it for FUTURE functions, still revoke explicitly).

## Migrations 0011-0018
- Policies unchanged in number (80). `subscriptions_select` now needs `settings.manage`; `day_sessions_select` dropped the open-day clause; `orders/order_items/ingredients/stock_movements`
  station predicates use `current_station_ids()`. `order_has_station_access` was dropped.
- Column grants: `restaurants` SELECT excludes `tin`, `opening_float` (use `fn_get_restaurant_settings()`); `platform_admins` UPDATE = `full_name, role, is_active`, INSERT = `id, full_name, role`.
- Platform helpers require `aal2` (see auth-flows.md). service_role: no TRUNCATE/REFERENCES/TRIGGER anywhere, no writes on the audit tables.
- `seed.sql` is local-only (guarded); see `supabase/seed.sql` header.
- 0019/0020: branding CHECK (size < 4096, key whitelist, hex colours, JSON null refused); `menu_items`, `recipe_lines`, `tables` use column grants (no `id`/timestamps: closes the foreign-id existence oracle); `profiles.username` is not client-updatable; renaming another user needs the same rights-coverage rule as `is_active`/`role_id`; `orders` is published to Realtime with a column list (no `public_token_hash`, no `station_ids`) and REPLICA IDENTITY USING INDEX (restaurant_id, id).
- Test note: `23_review_followups` attacks every client UPDATE/DELETE privilege from the other tenant (behavioural) and checks every write policy carries its own tenant predicate (structural: RLS hides a missing predicate behind the SELECT policy).

- 0022: `kiosk_devices` (1 SELECT policy; 81 policies in total). The service-only roster / eligibility functions are in no client EXECUTE list.

- 0023: `user_notifications` (1 SELECT policy; 82 policies in total). Published to `supabase_realtime` with an explicit column list
  `(id, restaurant_id, recipient_id, kind, payload, created_at, read_at)` and `REPLICA IDENTITY USING INDEX (restaurant_id, id)`, like `orders`; Realtime applies the
  SELECT policy, so a subscriber only receives their own rows (filter `recipient_id=eq.<uid>` is an optimisation, not the boundary). The DELETE-event residual from
  deploy-checklist item 7 applies (ids only; nothing is deleted by the app).
  **Retention:** notifications are operational messages, not an audit trail (the audit row `auth.concurrent_login_blocked` is). Keep 90 days: a platform maintenance job
  running as the table owner may `delete from public.user_notifications where created_at < now() - interval '90 days'` (no job exists yet; no client can delete). Until then rows accumulate at most one set per user per 5 minutes.
  `has_permission` / `has_station_access` / `current_station_ids` additionally answer nothing while `profile_secrets.must_change_pin` is true (tenant_admin exempt); every policy/RPC that goes through those helpers denies. Residual (same tenant only, non-sensitive config): tenant-membership-only SELECT policies (roles, role_permissions own role, permissions, stations, categories, payment_methods, table_areas, expense_categories, restaurants) and RPCs gated only by `fn_tenant_status_guard` stay readable until the PIN is changed.

- 0024 (maker-checker for a forced PIN change): no new table and no new policy (82). `profile_secrets` (RLS on, no policy, no client grant) gains `pin_change_pending` and `pin_change_requested_at`
  (CHECK: never together with `must_change_pin`). `has_permission` / `has_station_access` / `current_station_ids` now use the single helper `fn_pin_restricted(user)` =
  `must_change_pin or pin_change_pending` (tenant_admin exempt), so every policy that goes through them denies a user who is waiting for approval. `user_notifications_select` is
  unchanged (recipient-only, no `has_permission`), so a restricted user still reads their own notifications (asserted in `28_pin_change_approval`). The same tenant-membership-only residual as 0023 applies.
