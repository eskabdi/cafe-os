-- 0007  Row Level Security: enabled AND forced on EVERY table in public.
-- One policy per verb. Policies call SECURITY DEFINER helpers (no recursion) wrapped in
-- (select ...) so Postgres evaluates them once per statement (initplan), not per row.
-- Tenant suspension: helpers return NULL/false for suspended or cancelled tenants (no access),
-- and writes additionally require current_tenant_writable() (denies past_due).

do $$
declare
  r record;
begin
  for r in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', r.tablename);
    execute format('alter table public.%I force row level security', r.tablename);
  end loop;
end $$;

-- ═════════════ platform layer ═════════════
-- plans: publicly readable (anon sees active plans), only platform super admins write
create policy plans_select_anon on public.plans for select to anon
  using (is_active);
create policy plans_select_auth on public.plans for select to authenticated
  using (is_active or (select public.is_platform_admin()));
create policy plans_insert_platform on public.plans for insert to authenticated
  with check ((select public.is_platform_super_admin()));
create policy plans_update_platform on public.plans for update to authenticated
  using ((select public.is_platform_super_admin())) with check ((select public.is_platform_super_admin()));
create policy plans_delete_platform on public.plans for delete to authenticated
  using ((select public.is_platform_super_admin()));

-- restaurants: tenants read their own row; settings.manage edits whitelisted columns (column grants);
-- no client INSERT/DELETE (provisioning is fn_provision_tenant).
create policy restaurants_select on public.restaurants for select to authenticated
  using (id = (select public.current_restaurant_id()) or (select public.is_platform_admin()));
create policy restaurants_update_tenant on public.restaurants for update to authenticated
  using (id = (select public.current_restaurant_id())
         and (select public.has_permission('settings.manage'))
         and (select public.current_tenant_writable()))
  with check (id = (select public.current_restaurant_id())
         and (select public.has_permission('settings.manage'))
         and (select public.current_tenant_writable()));
create policy restaurants_update_platform on public.restaurants for update to authenticated
  using ((select public.is_platform_super_admin())) with check ((select public.is_platform_super_admin()));

-- subscriptions
create policy subscriptions_select on public.subscriptions for select to authenticated
  using (restaurant_id = (select public.current_restaurant_id()) or (select public.is_platform_admin()));
create policy subscriptions_insert_platform on public.subscriptions for insert to authenticated
  with check ((select public.is_platform_super_admin()));
create policy subscriptions_update_platform on public.subscriptions for update to authenticated
  using ((select public.is_platform_super_admin())) with check ((select public.is_platform_super_admin()));
create policy subscriptions_delete_platform on public.subscriptions for delete to authenticated
  using ((select public.is_platform_super_admin()));

-- platform_admins
create policy platform_admins_select on public.platform_admins for select to authenticated
  using (id = (select auth.uid()) or (select public.is_platform_admin()));
create policy platform_admins_insert on public.platform_admins for insert to authenticated
  with check ((select public.is_platform_super_admin()));
create policy platform_admins_update on public.platform_admins for update to authenticated
  using ((select public.is_platform_super_admin())) with check ((select public.is_platform_super_admin()));
-- no DELETE policy: deactivate instead

-- platform_invoices
create policy platform_invoices_select on public.platform_invoices for select to authenticated
  using ((restaurant_id = (select public.current_restaurant_id()) and (select public.has_permission('settings.manage')))
         or (select public.is_platform_admin()));
create policy platform_invoices_insert on public.platform_invoices for insert to authenticated
  with check ((select public.is_platform_super_admin()));
create policy platform_invoices_update on public.platform_invoices for update to authenticated
  using ((select public.is_platform_super_admin())) with check ((select public.is_platform_super_admin()));
create policy platform_invoices_delete on public.platform_invoices for delete to authenticated
  using ((select public.is_platform_super_admin()));

-- admin_audit_log: platform admins read; rows are written only by definer RPCs
create policy admin_audit_log_select on public.admin_audit_log for select to authenticated
  using ((select public.is_platform_admin()));

-- tenant_counters / idempotency_keys / profile_secrets: RLS on, NO policies (definer code + service_role only)

-- ═════════════ audit ═════════════
create policy audit_logs_select on public.audit_logs for select to authenticated
  using (restaurant_id = (select public.current_restaurant_id()) and (select public.has_permission('audit.view')));

-- ═════════════ identity & authorization ═════════════
create policy permissions_select on public.permissions for select to authenticated
  using ((select public.current_user_id()) is not null);

create policy profiles_select on public.profiles for select to authenticated
  using (restaurant_id = (select public.current_restaurant_id())
         and (id = (select public.current_user_id())
              or (select public.has_permission('users.view'))
              or (select public.has_permission('users.manage'))));
-- UPDATE limited to (first_name, middle_name, last_name, username, is_active) by column grants;
-- role_id changes only via fn_change_user_role. Only a tenant_admin may touch a tenant_admin profile.
create policy profiles_update on public.profiles for update to authenticated
  using (restaurant_id = (select public.current_restaurant_id())
         and (select public.has_permission('users.manage'))
         and (select public.current_tenant_writable())
         and (not exists (select 1 from public.roles ro where ro.id = profiles.role_id and ro.system_key = 'tenant_admin')
              or (select public.is_tenant_admin())))
  with check (restaurant_id = (select public.current_restaurant_id())
         and (select public.has_permission('users.manage'))
         and (select public.current_tenant_writable()));
-- no INSERT/DELETE: staff are created server-side with an auth user (Edge Function / RPC)

create policy roles_select on public.roles for select to authenticated
  using (restaurant_id = (select public.current_restaurant_id()));
create policy roles_insert on public.roles for insert to authenticated
  with check (restaurant_id = (select public.current_restaurant_id())
              and system_key is null and not is_system
              and (select public.has_permission('roles.manage'))
              and (select public.current_tenant_writable()));
create policy roles_update on public.roles for update to authenticated
  using (restaurant_id = (select public.current_restaurant_id())
         and system_key is null
         and (select public.has_permission('roles.manage'))
         and (select public.current_tenant_writable()))
  with check (restaurant_id = (select public.current_restaurant_id())
         and system_key is null and not is_system
         and (select public.has_permission('roles.manage'))
         and (select public.current_tenant_writable()));
create policy roles_delete on public.roles for delete to authenticated
  using (restaurant_id = (select public.current_restaurant_id())
         and system_key is null
         and (select public.has_permission('roles.manage'))
         and (select public.current_tenant_writable()));

-- matrix rows: readable for your own role (drives navigation) or with roles.manage; NO write policies
create policy role_permissions_select on public.role_permissions for select to authenticated
  using (restaurant_id = (select public.current_restaurant_id())
         and (role_id = (select public.current_role_id()) or (select public.has_permission('roles.manage'))));
create policy role_station_access_select on public.role_station_access for select to authenticated
  using (restaurant_id = (select public.current_restaurant_id())
         and (role_id = (select public.current_role_id()) or (select public.has_permission('roles.manage'))));

-- ═════════════ dynamic configuration domains (stations, categories, ...) ═════════════
do $$
declare
  t text;
begin
  foreach t in array array['stations', 'categories', 'payment_methods', 'table_areas', 'expense_categories'] loop
    execute format($f$create policy %1$s_select on public.%1$I for select to authenticated
      using (restaurant_id = (select public.current_restaurant_id()))$f$, t);
    execute format($f$create policy %1$s_insert on public.%1$I for insert to authenticated
      with check (restaurant_id = (select public.current_restaurant_id())
                  and (select public.has_permission('config.manage'))
                  and (select public.current_tenant_writable()))$f$, t);
    execute format($f$create policy %1$s_update on public.%1$I for update to authenticated
      using (restaurant_id = (select public.current_restaurant_id())
             and (select public.has_permission('config.manage'))
             and (select public.current_tenant_writable()))
      with check (restaurant_id = (select public.current_restaurant_id())
             and (select public.has_permission('config.manage'))
             and (select public.current_tenant_writable()))$f$, t);
    execute format($f$create policy %1$s_delete on public.%1$I for delete to authenticated
      using (restaurant_id = (select public.current_restaurant_id())
             and (select public.has_permission('config.manage'))
             and (select public.current_tenant_writable()))$f$, t);
  end loop;
end $$;

-- ═════════════ menu & inventory ═════════════
create policy menu_items_select on public.menu_items for select to authenticated
  using (restaurant_id = (select public.current_restaurant_id())
         and ((select public.has_permission('menu.view'))
              or (select public.has_permission('menu.manage'))
              or (select public.has_permission('orders.create'))));
create policy menu_items_insert on public.menu_items for insert to authenticated
  with check (restaurant_id = (select public.current_restaurant_id())
              and (select public.has_permission('menu.manage'))
              and (select public.current_tenant_writable()));
create policy menu_items_update on public.menu_items for update to authenticated
  using (restaurant_id = (select public.current_restaurant_id())
         and (select public.has_permission('menu.manage'))
         and (select public.current_tenant_writable()))
  with check (restaurant_id = (select public.current_restaurant_id())
         and (select public.has_permission('menu.manage'))
         and (select public.current_tenant_writable()));
create policy menu_items_delete on public.menu_items for delete to authenticated
  using (restaurant_id = (select public.current_restaurant_id())
         and (select public.has_permission('menu.manage'))
         and (select public.current_tenant_writable()));

create policy recipe_lines_select on public.recipe_lines for select to authenticated
  using (restaurant_id = (select public.current_restaurant_id())
         and ((select public.has_permission('menu.view'))
              or (select public.has_permission('menu.manage'))
              or (select public.has_permission('inventory.view'))));
create policy recipe_lines_insert on public.recipe_lines for insert to authenticated
  with check (restaurant_id = (select public.current_restaurant_id())
              and (select public.has_permission('menu.manage'))
              and (select public.current_tenant_writable()));
create policy recipe_lines_update on public.recipe_lines for update to authenticated
  using (restaurant_id = (select public.current_restaurant_id())
         and (select public.has_permission('menu.manage'))
         and (select public.current_tenant_writable()))
  with check (restaurant_id = (select public.current_restaurant_id())
         and (select public.has_permission('menu.manage'))
         and (select public.current_tenant_writable()));
create policy recipe_lines_delete on public.recipe_lines for delete to authenticated
  using (restaurant_id = (select public.current_restaurant_id())
         and (select public.has_permission('menu.manage'))
         and (select public.current_tenant_writable()));

-- ingredients: master-data writes via column grants (stock columns are RPC-only)
create policy ingredients_select on public.ingredients for select to authenticated
  using (restaurant_id = (select public.current_restaurant_id())
         and (((select public.has_permission('inventory.view'))
               and (public.has_station_access(station_id)
                    or (select public.has_permission('inventory.adjust'))
                    or (select public.has_permission('inventory.receive'))))
              or (select public.has_permission('menu.manage'))));
create policy ingredients_insert on public.ingredients for insert to authenticated
  with check (restaurant_id = (select public.current_restaurant_id())
              and (select public.has_permission('inventory.adjust'))
              and (select public.current_tenant_writable()));
create policy ingredients_update on public.ingredients for update to authenticated
  using (restaurant_id = (select public.current_restaurant_id())
         and (select public.has_permission('inventory.adjust'))
         and (select public.current_tenant_writable()))
  with check (restaurant_id = (select public.current_restaurant_id())
         and (select public.has_permission('inventory.adjust'))
         and (select public.current_tenant_writable()));
create policy ingredients_delete on public.ingredients for delete to authenticated
  using (restaurant_id = (select public.current_restaurant_id())
         and (select public.has_permission('inventory.adjust'))
         and (select public.current_tenant_writable()));

-- stock_movements: read only; rows come from stock RPCs
create policy stock_movements_select on public.stock_movements for select to authenticated
  using (restaurant_id = (select public.current_restaurant_id())
         and (select public.has_permission('inventory.view'))
         and (public.has_station_access(station_id)
              or (select public.has_permission('inventory.adjust'))
              or (select public.has_permission('inventory.receive'))));

-- ═════════════ tables & QR ═════════════
create policy tables_select on public.tables for select to authenticated
  using (restaurant_id = (select public.current_restaurant_id())
         and ((select public.has_permission('tables.view'))
              or (select public.has_permission('tables.manage'))
              or (select public.has_permission('orders.create'))));
create policy tables_insert on public.tables for insert to authenticated
  with check (restaurant_id = (select public.current_restaurant_id())
              and (select public.has_permission('tables.manage'))
              and (select public.current_tenant_writable()));
create policy tables_update on public.tables for update to authenticated
  using (restaurant_id = (select public.current_restaurant_id())
         and (select public.has_permission('tables.manage'))
         and (select public.current_tenant_writable()))
  with check (restaurant_id = (select public.current_restaurant_id())
         and (select public.has_permission('tables.manage'))
         and (select public.current_tenant_writable()));
create policy tables_delete on public.tables for delete to authenticated
  using (restaurant_id = (select public.current_restaurant_id())
         and (select public.has_permission('tables.manage'))
         and (select public.current_tenant_writable()));

create policy table_sessions_select on public.table_sessions for select to authenticated
  using (restaurant_id = (select public.current_restaurant_id())
         and ((select public.has_permission('tables.view'))
              or (select public.has_permission('orders.view_all'))
              or (select public.has_permission('orders.create'))));

-- QR credentials: staff with qr.manage / tables.manage can read metadata (token_hash is never granted);
-- issue / regenerate / revoke happen only inside fn_manage_qr_credential (token generated server-side).
create policy qr_credentials_select on public.qr_credentials for select to authenticated
  using (restaurant_id = (select public.current_restaurant_id())
         and ((select public.has_permission('qr.manage')) or (select public.has_permission('tables.manage'))));

create policy customer_sessions_select on public.customer_sessions for select to authenticated
  using (restaurant_id = (select public.current_restaurant_id())
         and ((select public.has_permission('tables.view')) or (select public.has_permission('orders.view_all'))));

-- ═════════════ business day, orders, money (read-only to clients; RPC writes) ═════════════
create policy day_sessions_select on public.day_sessions for select to authenticated
  using (restaurant_id = (select public.current_restaurant_id())
         and ((select public.has_permission('reports.view'))
              or (select public.has_permission('day_close.execute'))
              or (select public.has_permission('day.open'))
              or (status = 'open'
                  and ((select public.has_permission('orders.create'))
                       or (select public.has_permission('payments.create'))
                       or (select public.has_permission('dashboard.view'))))));

create policy orders_select on public.orders for select to authenticated
  using (restaurant_id = (select public.current_restaurant_id())
         and (select public.has_permission('orders.view'))
         and ((select public.has_permission('orders.view_all'))
              or created_by = (select public.current_user_id())
              or public.order_has_station_access(id)));

create policy order_items_select on public.order_items for select to authenticated
  using (restaurant_id = (select public.current_restaurant_id())
         and (select public.has_permission('orders.view'))
         and ((select public.has_permission('orders.view_all'))
              or public.has_station_access(station_id)
              or public.is_order_owner(order_id)));

create policy payments_select on public.payments for select to authenticated
  using (restaurant_id = (select public.current_restaurant_id())
         and (select public.has_permission('payments.view')));

create policy vouchers_select on public.vouchers for select to authenticated
  using (restaurant_id = (select public.current_restaurant_id())
         and (select public.has_permission('vouchers.view')));

create policy installments_select on public.installments for select to authenticated
  using (restaurant_id = (select public.current_restaurant_id())
         and (select public.has_permission('vouchers.view')));

-- ═════════════ expenses (direct writes with expenses.manage; context filled by trigger) ═════════════
create policy expenses_select on public.expenses for select to authenticated
  using (restaurant_id = (select public.current_restaurant_id())
         and ((select public.has_permission('expenses.view')) or (select public.has_permission('expenses.manage'))));
create policy expenses_insert on public.expenses for insert to authenticated
  with check (restaurant_id = (select public.current_restaurant_id())
              and (select public.has_permission('expenses.manage'))
              and (select public.current_tenant_writable()));
create policy expenses_update on public.expenses for update to authenticated
  using (restaurant_id = (select public.current_restaurant_id())
         and (select public.has_permission('expenses.manage'))
         and (select public.current_tenant_writable()))
  with check (restaurant_id = (select public.current_restaurant_id())
         and (select public.has_permission('expenses.manage'))
         and (select public.current_tenant_writable()));
create policy expenses_delete on public.expenses for delete to authenticated
  using (restaurant_id = (select public.current_restaurant_id())
         and (select public.has_permission('expenses.manage'))
         and (select public.current_tenant_writable()));
