# RLS matrix (migration 0007; 80 policies; RLS enabled AND forced on every public table)

Helpers (SECURITY DEFINER, empty search_path, identity from `profiles` via `auth.uid()`, never from JWT claims):
`current_restaurant_id()`, `current_user_id()`, `current_role_id()`, `has_permission(key)`, `has_station_access(station_id)`,
`is_platform_admin()`, `is_platform_super_admin()`, `is_tenant_admin()`, `current_tenant_writable()`.
Suspended/cancelled tenants resolve to NULL (no access); `past_due` is read-only (writes need `current_tenant_writable()`).
"T" = same tenant. "W" = tenant writable (trialing/active). Column grants further narrow UPDATE/INSERT (noted).

| table | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| plans | anon/auth: active; platform: all | platform super admin | platform super admin | platform super admin |
| restaurants | own row; platform admins all | none (fn_provision_tenant) | `settings.manage` + W, columns: name, phone, address, tin, vat_rate, opening_float, auto_consume_stock, timezone, branding; platform super admin | none |
| subscriptions | own; platform admins | platform super admin | platform super admin | platform super admin |
| platform_admins | self; platform admins | platform super admin | platform super admin | none (deactivate) |
| platform_invoices | own with `settings.manage`; platform admins | super admin | super admin | super admin |
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
| day_sessions | T + (`reports.view`/`day_close.execute`/`day.open`, or open day for POS/cashier/dashboard) | none (RPC) | none; closed rows trigger-frozen | none; trigger-blocked |
| orders | T + `orders.view` + (`orders.view_all` or own or station item) | none (fn_submit_order later) | none | none |
| order_items | T + `orders.view` + (`orders.view_all` or station access or own order) | none | none | none |
| payments | T + `payments.view` | none (fn_confirm_payment later) | trigger-blocked for all roles | trigger-blocked for all roles |
| vouchers, installments | T + `vouchers.view` | none | none | none |
| expenses | T + `expenses.view`/`expenses.manage` | T + `expenses.manage` + W (actor, day, method snapshot set by trigger) | same; frozen once its day is closed | same; frozen once its day is closed |

Policies per table: admin_audit_log 1, audit_logs 1, categories 4, customer_sessions 1, day_sessions 1, expense_categories 4, expenses 4,
ingredients 4, installments 1, menu_items 4, order_items 1, orders 1, payment_methods 4, payments 1, permissions 1, plans 5,
platform_admins 3, platform_invoices 4, profiles 2, qr_credentials 1, recipe_lines 4, restaurants 3, role_permissions 1,
role_station_access 1, roles 4, stations 4, stock_movements 1, subscriptions 4, table_areas 4, table_sessions 1, tables 4, vouchers 1;
profile_secrets, tenant_counters, idempotency_keys: 0 (deny all).
