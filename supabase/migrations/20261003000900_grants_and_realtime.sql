-- 0009  Privileges (deny-by-default) and Realtime publication
--
-- Supabase grants ALL on new public objects to anon/authenticated/service_role through default
-- privileges. We reset that for everything that exists today and then grant back exactly what
-- the API surface needs. RLS policies (0007) remain the row-level ceiling.
-- NEW TABLES / FUNCTIONS IN LATER MIGRATIONS MUST END WITH THEIR OWN REVOKE/GRANT BLOCK.

-- stop future objects created by this role from being world-accessible
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;

revoke all on all tables in schema public from public, anon, authenticated;
revoke all on all sequences in schema public from public, anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;

grant usage on schema public to anon, authenticated, service_role;

-- service_role (Edge Functions, CI seeding): full table access; RLS is bypassed but the
-- immutability/guard triggers still apply to it.
grant select, insert, update, delete on all tables in schema public to service_role;

-- ── read access for signed-in staff (rows filtered by RLS) ──
grant select on
  public.restaurants, public.subscriptions, public.platform_admins, public.platform_invoices,
  public.admin_audit_log, public.audit_logs, public.permissions, public.profiles, public.roles,
  public.role_permissions, public.role_station_access,
  public.stations, public.categories, public.payment_methods, public.table_areas, public.expense_categories,
  public.menu_items, public.ingredients, public.recipe_lines, public.stock_movements,
  public.tables, public.table_sessions, public.customer_sessions,
  public.day_sessions, public.orders, public.order_items, public.payments, public.vouchers,
  public.installments, public.expenses, public.plans
to authenticated;
grant select on public.plans to anon;

-- qr_credentials: everything except the token hash
grant select (id, restaurant_id, table_id, version, status, issued_at, issued_by, revoked_at, revoked_by, created_at, updated_at)
  on public.qr_credentials to authenticated;
-- customer_sessions: never expose the session token hash
revoke select on public.customer_sessions from authenticated;
grant select (id, restaurant_id, table_session_id, qr_credential_id, customer_name, customer_phone, status,
              expires_at, last_seen_at, created_at, updated_at)
  on public.customer_sessions to authenticated;
-- orders: never expose the public tracking token hash
revoke select on public.orders from authenticated;
grant select (id, restaurant_id, day_session_id, order_no, source, order_type, status, payment_status, table_id,
              table_label_snapshot, table_session_id, customer_session_id, created_by, created_by_name_snapshot,
              subtotal, vat_rate_snapshot, vat_amount, total, stock_consumed, client_key, customer_name,
              customer_phone, customer_note, ready_at, served_at, cancelled_at, cancelled_by, cancel_reason,
              created_at, updated_at)
  on public.orders to authenticated;

-- ── direct writes (each also needs a matching RLS policy) ──
-- tenant settings: whitelist of columns (slug/domain/status/billing are platform-only)
grant update (name, phone, address, tin, vat_rate, opening_float, auto_consume_stock, timezone, branding)
  on public.restaurants to authenticated;
-- staff: names/username/active flag; role_id only through fn_change_user_role
grant update (first_name, middle_name, last_name, username, is_active) on public.profiles to authenticated;
-- the six dynamic domains: presentation + lifecycle columns only (system flags are not client-writable)
grant insert (restaurant_id, name, description, color, icon, sort_order, is_active),
      update (name, description, color, icon, sort_order, is_active),
      delete
  on public.roles to authenticated;
grant insert (restaurant_id, name, description, color, icon, sort_order, is_active),
      update (name, description, color, icon, sort_order, is_active),
      delete
  on public.stations, public.categories, public.table_areas, public.expense_categories to authenticated;
grant insert (restaurant_id, name, description, color, icon, sort_order, is_active, affects_cash_drawer, requires_reference),
      update (name, description, color, icon, sort_order, is_active, affects_cash_drawer, requires_reference),
      delete
  on public.payment_methods to authenticated;
grant insert, update, delete on public.menu_items, public.recipe_lines, public.tables to authenticated;
-- ingredients: master data only. stock / opening / received / consumed move exclusively via stock RPCs.
grant insert (restaurant_id, name, station_id, unit, min_level, cost_per_unit, is_active),
      update (name, station_id, unit, min_level, cost_per_unit, is_active),
      delete
  on public.ingredients to authenticated;
-- expenses: actor, business day and method snapshots are filled by trigger
grant insert (restaurant_id, expense_category_id, payment_method_id, amount, description, expense_date),
      update (expense_category_id, payment_method_id, amount, description, expense_date),
      delete
  on public.expenses to authenticated;
-- platform surface (policies restrict these to platform super admins)
grant insert, update, delete on public.plans, public.subscriptions, public.platform_invoices to authenticated;
grant insert, update on public.platform_admins to authenticated;

-- NOT granted to any client role (RLS enabled, no policies): profile_secrets, tenant_counters, idempotency_keys.
-- audit_logs / admin_audit_log: SELECT only; INSERT happens inside definer functions.

-- ── functions ──
-- RLS helpers (invoked by policy expressions in the caller's context)
grant execute on function
  public.current_user_id(), public.current_restaurant_id(), public.current_role_id(),
  public.current_tenant_writable(), public.is_platform_admin(), public.is_platform_super_admin(),
  public.is_tenant_admin(), public.has_permission(text), public.has_station_access(uuid),
  public.is_order_owner(uuid), public.order_has_station_access(uuid)
to authenticated;
-- public RPC surface
grant execute on function public.fn_resolve_tenant_slug(text) to anon, authenticated, service_role;
grant execute on function
  public.fn_get_session_context(),
  public.fn_update_role_permissions(uuid, text[], uuid[]),
  public.fn_change_user_role(uuid, uuid),
  public.fn_provision_tenant(text, text, uuid, text, text, text, uuid, text),
  public.fn_suspend_tenant(uuid, text),
  public.fn_reactivate_tenant(uuid, text)
to authenticated;
-- service-only surface (also re-checked inside each function)
grant execute on function
  public.fn_provision_tenant(text, text, uuid, text, text, text, uuid, text),
  public.fn_set_user_pin(uuid, text),
  public.fn_verify_pin(uuid, text),
  public.fn_register_pin_failure(uuid),
  public.fn_write_audit(text, jsonb, uuid, uuid)
to service_role;
-- Internal only (no client role): fn_seed_tenant_defaults, fn_next_number, fn_write_admin_audit,
-- fn_tenant_status_guard, fn_idempotency_*, fn_err and all trigger functions. They are reached only
-- through SECURITY DEFINER callers owned by the migration role.
grant execute on function public.fn_err(text, text) to authenticated, anon, service_role;

-- ── Realtime ──
-- postgres_changes evaluates the subscriber's RLS policies. REPLICA IDENTITY FULL makes
-- restaurant_id available on UPDATE/DELETE events so tenant filters work for every event type.
do $$
declare
  t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array[
      'orders', 'order_items', 'ingredients', 'stock_movements', 'vouchers', 'installments', 'payments',
      'expenses', 'day_sessions', 'tables', 'table_sessions', 'qr_credentials',
      'stations', 'categories', 'payment_methods', 'table_areas', 'expense_categories',
      'roles', 'role_permissions', 'role_station_access', 'menu_items', 'recipe_lines', 'profiles'
    ] loop
      execute format('alter table public.%I replica identity full', t);
      if not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;
