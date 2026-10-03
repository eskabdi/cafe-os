-- Adversarial: IDOR / BOLA. Tenant A's users use tenant B's real ids against EVERY tenant table and EVERY
-- RPC that takes a UUID. Denial alone is not enough: the outcome must be identical to an id that exists
-- nowhere (no existence oracle), and B's data must be byte-for-byte unchanged afterwards.
begin;
select * from no_plan();

-- ── fixtures: make sure tenant B owns at least one row in EVERY tenant table ──
create temp table _f on commit drop as
select tests.tenant_id('central-cafe') a, tests.tenant_id('second-cafe') b,
       tests.user_id('selam', 'central-cafe') a_admin, tests.user_id('yonas', 'central-cafe') a_waiter,
       tests.user_id('owner', 'second-cafe') b_admin, tests.user_id('waiter', 'second-cafe') b_waiter,
       tests.role_id('Waiter', 'central-cafe') a_waiter_role, tests.role_id('Waiter', 'second-cafe') b_waiter_role,
       tests.admin_role_id('second-cafe') b_admin_role,
       (select id from public.stations where restaurant_id = tests.tenant_id('central-cafe') and name = 'Kitchen') a_station,
       (select id from public.stations where restaurant_id = tests.tenant_id('second-cafe') and name = 'Kitchen') b_station,
       (select id from public.categories where restaurant_id = tests.tenant_id('second-cafe') and name = 'Lunch') b_category,
       (select id from public.payment_methods where restaurant_id = tests.tenant_id('second-cafe') and name = 'Cash') b_method,
       (select id from public.table_areas where restaurant_id = tests.tenant_id('second-cafe') and name = 'Main Hall') b_area,
       (select id from public.expense_categories where restaurant_id = tests.tenant_id('second-cafe') and name = 'Rent') b_expcat,
       (select id from public.menu_items where restaurant_id = tests.tenant_id('second-cafe') limit 1) b_menu,
       (select id from public.tables where restaurant_id = tests.tenant_id('second-cafe') limit 1) b_table,
       (select id from public.day_sessions where restaurant_id = tests.tenant_id('second-cafe') and status = 'open') b_day,
       (select id from public.subscriptions where restaurant_id = tests.tenant_id('second-cafe')) b_sub,
       (select id from public.plans where name = 'Starter') plan_id;
grant all on _f to public;

insert into public.ingredients (restaurant_id, name, station_id, unit, stock) select b, 'Flour B', b_station, 'kg', 5 from _f;
insert into public.recipe_lines (restaurant_id, menu_item_id, ingredient_id, qty_per_serving)
  select f.b, f.b_menu, i.id, 1 from _f f join public.ingredients i on i.restaurant_id = f.b;
insert into public.stock_movements (restaurant_id, ingredient_id, station_id, qty_delta, reason)
  select f.b, i.id, i.station_id, 5, 'opening' from _f f join public.ingredients i on i.restaurant_id = f.b;
insert into public.table_sessions (restaurant_id, table_id, day_session_id) select b, b_table, b_day from _f;
insert into public.qr_credentials (restaurant_id, table_id, token_hash) select b, b_table, repeat('b', 64) from _f;
insert into public.customer_sessions (restaurant_id, table_session_id, qr_credential_id, session_token_hash, expires_at)
  select f.b, ts.id, q.id, repeat('c', 64), now() + interval '1 hour'
  from _f f join public.table_sessions ts on ts.restaurant_id = f.b join public.qr_credentials q on q.restaurant_id = f.b;
insert into public.orders (restaurant_id, day_session_id, order_no, created_by, subtotal, vat_rate_snapshot, vat_amount, total)
  select b, b_day, 'ORD-0001', b_waiter, 100, 15, 15, 115 from _f;
insert into public.order_items (restaurant_id, order_id, menu_item_id, name_snapshot, price_snapshot, qty, station_id, station_name_snapshot)
  select f.b, o.id, f.b_menu, 'Special', 100, 1, f.b_station, 'Kitchen' from _f f join public.orders o on o.restaurant_id = f.b;
insert into public.vouchers (restaurant_id, voucher_no, order_id, customer_name, total, installment_count, interval_days)
  select f.b, 'VCH-0001', o.id, 'Cust', 115, 2, 30 from _f f join public.orders o on o.restaurant_id = f.b;
insert into public.installments (restaurant_id, voucher_id, no, due_date, amount)
  select f.b, v.id, 1, current_date + 30, 57.5 from _f f join public.vouchers v on v.restaurant_id = f.b;
insert into public.payments (restaurant_id, day_session_id, order_id, kind, amount, payment_method_id, method_name_snapshot, method_affects_drawer_snapshot, receipt_no)
  select f.b, f.b_day, o.id, 'order_payment', 115, f.b_method, 'Cash', true, 'RCT-0001' from _f f join public.orders o on o.restaurant_id = f.b;
insert into public.expenses (restaurant_id, expense_category_id, payment_method_id, amount) select b, b_expcat, b_method, 10 from _f;
insert into public.idempotency_keys (restaurant_id, key, command) select b, 'idem-key-000001', 'test' from _f;
insert into public.tenant_counters (restaurant_id, counter_key, last_value) select b, 'order', 1 from _f on conflict do nothing;
insert into public.platform_invoices (restaurant_id, subscription_id, amount, period_start, period_end, status)
  select b, b_sub, 990, current_date, current_date + 30, 'pending' from _f;

insert into public.orders (restaurant_id, day_session_id, order_no, created_by, subtotal, vat_rate_snapshot, vat_amount, total)
  select a, (select id from public.day_sessions where restaurant_id = a and status = 'open'), 'ORD-0007', tests.user_id('meron', 'central-cafe'), 10, 15, 1.5, 11.5 from _f;
create temp table _g on commit drop as
select (select id from public.orders where restaurant_id = (select b from _f)) b_order,
       (select id from public.payments where restaurant_id = (select b from _f)) b_payment,
       (select id from public.audit_logs where restaurant_id = (select b from _f) limit 1) b_audit,
       (select id from public.orders where order_no = 'ORD-0007') a_colleague_order;
grant all on _g to public;

create function tests.empty_tenant_tables(p_tenant uuid) returns text language plpgsql as $$
declare t text; n bigint; o text := '';
begin
  for t in select tests.tenant_tables() loop
    execute format('select count(*) from public.%I where restaurant_id = $1', t) into n using p_tenant;
    if n = 0 then o := o || t || ' '; end if;
  end loop;
  return o;
end $$;
select is(tests.empty_tenant_tables((select b from _f)), '',
          'fixture: tenant B owns rows in every tenant table (extend the fixtures when a table is added)');

create temp table _snap on commit drop as
select tests.snapshot((select a from _f)) a, tests.snapshot((select b from _f)) b;
grant all on _snap to public;

-- ── generic probes (run under the caller's role; run in the helper functions below) ──
-- leaks_read: rows of any other tenant visible in any tenant table (insufficient_privilege = not visible)
create function tests.leaks_read(p_own uuid) returns text language plpgsql as $$
declare t text; n bigint; o text := '';
begin
  for t in select tests.tenant_tables() loop
    begin
      execute format('select count(*) from public.%I where restaurant_id is distinct from $1', t) into n using p_own;
      if n > 0 then o := o || t || '(' || n || ') '; end if;
    exception when insufficient_privilege then null;
    end;
  end loop;
  begin
    select count(*) into n from public.restaurants where id <> p_own;
    if n > 0 then o := o || 'restaurants(' || n || ') '; end if;
  exception when insufficient_privilege then null;
  end;
  return o;
end $$;

-- leaks_write: any successful write against another tenant's rows
create function tests.leaks_write(p_other uuid) returns text language plpgsql as $$
declare
  t text; n bigint; o text := ''; s record;
  updates text[][] := array[
    ['stations','name = name'], ['categories','name = name'], ['table_areas','name = name'],
    ['expense_categories','name = name'], ['payment_methods','name = name'], ['roles','name = name'],
    ['menu_items','price = price'], ['recipe_lines','qty_per_serving = qty_per_serving'],
    ['ingredients','min_level = min_level'], ['tables','capacity = capacity'], ['expenses','amount = amount'],
    ['profiles','first_name = first_name'], ['subscriptions','status = status'],
    ['platform_invoices','status = status']];
begin
  for t in select tests.tenant_tables() loop
    begin
      execute format('delete from public.%I where restaurant_id = $1', t) using p_other;
      get diagnostics n = row_count;
      if n > 0 then o := o || 'delete:' || t || ' '; end if;
    exception when insufficient_privilege then null;
              when others then o := o || 'delete-err:' || t || ':' || sqlstate || ' ';
    end;
    -- inserting INTO the other tenant must always be a privilege / RLS violation (42501)
    if t <> 'expenses' then
      begin
        execute format('insert into public.%I (restaurant_id) values ($1)', t) using p_other;
        o := o || 'insert:' || t || ' ';
      exception when insufficient_privilege then null;
                when others then o := o || 'insert-err:' || t || ':' || sqlstate || ' ';
      end;
    end if;
  end loop;
  for i in 1 .. array_length(updates, 1) loop
    begin
      execute format('update public.%I set %s where restaurant_id = $1', updates[i][1], updates[i][2]) using p_other;
      get diagnostics n = row_count;
      if n > 0 then o := o || 'update:' || updates[i][1] || ' '; end if;
    exception when insufficient_privilege then null;
              when others then o := o || 'update-err:' || updates[i][1] || ':' || sqlstate || ' ';
    end;
  end loop;
  begin
    update public.restaurants set name = name where id = p_other;
    get diagnostics n = row_count;
    if n > 0 then o := o || 'update:restaurants '; end if;
  exception when insufficient_privilege then null;
  end;
  return o;
end $$;

-- inserting into own tenant where no client INSERT grant exists (everything outside the insertable allowlist)
create function tests.unexpected_inserts(p_own uuid) returns text language plpgsql as $$
declare
  t text; o text := '';
  allowed text[] := array['stations','categories','table_areas','expense_categories','payment_methods','roles',
                          'menu_items','ingredients','recipe_lines','tables','expenses'];
begin
  for t in select tests.tenant_tables() loop
    continue when t = any (allowed);
    begin
      execute format('insert into public.%I (restaurant_id) values ($1)', t) using p_own;
      o := o || t || ' ';
    exception when insufficient_privilege then null;
              when others then o := o || t || ':' || sqlstate || ' ';
    end;
  end loop;
  return o;
end $$;

-- ═════════ tenant A admin against tenant B ═════════
select tests.authenticate_as((select a_admin from _f));
select is(tests.leaks_read((select a from _f)), '', 'A admin: no row of any other tenant is readable in any tenant table');
select is(tests.leaks_write((select b from _f)), '', 'A admin: no delete/insert/update reaches tenant B in any tenant table');
select is(tests.unexpected_inserts((select a from _f)), '', 'A admin: no INSERT grant outside the insertable-table allowlist (own tenant)');

-- explicit, well-formed inserts naming B's real parents must be denied by RLS (not merely fail validation)
select matches(tests.run(format($q$insert into public.stations (restaurant_id, name) values (%L, 'Forged')$q$, (select b from _f))),
               '^42501\|new row violates row-level security', 'A admin cannot insert a station into B');
select matches(tests.run(format($q$insert into public.categories (restaurant_id, name) values (%L, 'Forged')$q$, (select b from _f))),
               '^42501\|new row violates row-level security', 'A admin cannot insert a category into B');
select matches(tests.run(format($q$insert into public.payment_methods (restaurant_id, name) values (%L, 'Forged')$q$, (select b from _f))),
               '^42501\|new row violates row-level security', 'A admin cannot insert a payment method into B');
select matches(tests.run(format($q$insert into public.table_areas (restaurant_id, name) values (%L, 'Forged')$q$, (select b from _f))),
               '^42501\|new row violates row-level security', 'A admin cannot insert a table area into B');
select matches(tests.run(format($q$insert into public.expense_categories (restaurant_id, name) values (%L, 'Forged')$q$, (select b from _f))),
               '^42501\|new row violates row-level security', 'A admin cannot insert an expense category into B');
select matches(tests.run(format($q$insert into public.roles (restaurant_id, name) values (%L, 'Forged')$q$, (select b from _f))),
               '^42501\|new row violates row-level security', 'A admin cannot insert a role into B');
select matches(tests.run(format($q$insert into public.menu_items (restaurant_id, name, category_id, station_id, price) select %L, 'Forged', %L, %L, 1$q$,
                                (select b from _f), (select b_category from _f), (select b_station from _f))),
               '^42501\|new row violates row-level security', 'A admin cannot insert a menu item into B');
select matches(tests.run(format($q$insert into public.tables (restaurant_id, table_area_id, label) values (%L, %L, 'Z9')$q$,
                                (select b from _f), (select b_area from _f))),
               '^42501\|new row violates row-level security', 'A admin cannot insert a table into B');
select matches(tests.run(format($q$insert into public.expenses (restaurant_id, expense_category_id, payment_method_id, amount) values (%L, %L, %L, 1)$q$,
                                (select b from _f), (select b_expcat from _f), (select b_method from _f))),
               '^42501\|new row violates row-level security', 'A admin cannot insert an expense into B');

-- cross-tenant REFERENCES from A's own rows: denied, and indistinguishable from a reference to nothing
select is(tests.oracle(format($q$insert into public.menu_items (restaurant_id, name, category_id, station_id, price) values (%L, 'X1', {id}, %L, 1)$q$,
                              (select a from _f), (select a_station from _f)), (select b_category from _f)),
          '23503|insert or update on table "menu_items" violates foreign key constraint "menu_items_category_fk"|Key is not present in table "categories".',
          'menu item cannot reference B''s category, and the error is identical to an unknown id');
select is(tests.oracle(format($q$insert into public.menu_items (restaurant_id, name, category_id, station_id, price) select %L, 'X2', category_id, {id}, 1 from public.menu_items where restaurant_id = %L limit 1$q$,
                              (select a from _f), (select a from _f)), (select b_station from _f)),
          '23503|insert or update on table "menu_items" violates foreign key constraint "menu_items_station_fk"|Key is not present in table "stations".',
          'menu item cannot reference B''s station (no oracle)');
select is(tests.oracle(format($q$insert into public.tables (restaurant_id, table_area_id, label) values (%L, {id}, 'Q9')$q$, (select a from _f)), (select b_area from _f)),
          '23503|insert or update on table "tables" violates foreign key constraint "tables_area_fk"|Key is not present in table "table_areas".',
          'table cannot reference B''s area (no oracle)');
select is(tests.oracle(format($q$insert into public.expenses (restaurant_id, expense_category_id, payment_method_id, amount) values (%L, (select id from public.expense_categories where restaurant_id = %L limit 1), {id}, 1)$q$,
                              (select a from _f), (select a from _f)), (select b_method from _f)),
          'P0001|invalid_reference|payment_method_id', 'expense cannot reference B''s payment method (no oracle)');
select is(tests.oracle(format($q$insert into public.expenses (restaurant_id, expense_category_id, payment_method_id, amount) values (%L, %L, {id}, 1)$q$,
                              (select b from _f), (select b_expcat from _f)), (select b_method from _f)),
          '42501|new row violates row-level security policy for table "expenses"|',
          'expense naming B as tenant: real and unknown payment-method ids give the same RLS denial (no BEFORE-trigger oracle)');
select is(tests.oracle(format($q$update public.menu_items set category_id = {id} where restaurant_id = %L$q$, (select a from _f)), (select b_category from _f)),
          '23503|insert or update on table "menu_items" violates foreign key constraint "menu_items_category_fk"|Key is not present in table "categories".',
          'UPDATE re-pointing A''s rows at B''s category: same error as unknown id');

-- by-id access: B's real ids behave exactly like unknown ids for select / update / delete
select is(tests.oracle($q$select 1 from public.roles where id = {id}$q$, (select b_waiter_role from _f)), 'ok:0', 'select B role by id = unknown id');
select is(tests.oracle($q$select 1 from public.profiles where id = {id}$q$, (select b_waiter from _f)), 'ok:0', 'select B profile by id = unknown id');
select is(tests.oracle($q$select 1 from public.stations where id = {id}$q$, (select b_station from _f)), 'ok:0', 'select B station by id = unknown id');
select is(tests.oracle($q$select 1 from public.restaurants where id = {id}$q$, (select b from _f)), 'ok:0', 'select B restaurants row by id = unknown id');
select is(tests.oracle($q$select 1 from public.subscriptions where id = {id}$q$, (select b_sub from _f)), 'ok:0', 'select B subscription by id = unknown id');
select is(tests.oracle($q$update public.stations set name = 'pwn' where id = {id}$q$, (select b_station from _f)), 'ok:0', 'update B station by id = unknown id');
select is(tests.oracle($q$update public.profiles set is_active = false where id = {id}$q$, (select b_waiter from _f)), 'ok:0', 'deactivate B profile by id = unknown id');
select is(tests.oracle($q$update public.roles set name = 'pwn' where id = {id}$q$, (select b_waiter_role from _f)), 'ok:0', 'rename B role by id = unknown id');
select is(tests.oracle($q$delete from public.menu_items where id = {id}$q$, (select b_menu from _f)), 'ok:0', 'delete B menu item by id = unknown id');
select is(tests.oracle($q$delete from public.roles where id = {id}$q$, (select b_waiter_role from _f)), 'ok:0', 'delete B role by id = unknown id');
select is(tests.oracle($q$delete from public.tables where id = {id}$q$, (select b_table from _f)), 'ok:0', 'delete B table by id = unknown id');
select is(tests.oracle($q$select 1 from public.orders where id = {id}$q$, (select b_order from _g)), 'ok:0', 'select B order by id = unknown id');
select is(tests.oracle($q$select 1 from public.payments where id = {id}$q$, (select b_payment from _g)), 'ok:0', 'select B payment by id = unknown id');
select is(tests.oracle($q$select 1 from public.audit_logs where id = {id}$q$, (select b_audit from _g)), 'ok:0', 'select B audit row by id = unknown id');

-- RPCs taking UUIDs
select is(tests.oracle($q$select public.fn_update_role_permissions({id}, array['orders.view'], '{}')$q$, (select b_waiter_role from _f)),
          'P0001|not_found|', 'fn_update_role_permissions(B role): not_found, same as unknown role');
select is(tests.oracle($q$select public.fn_update_role_permissions({id}, '{}', '{}')$q$, (select b_admin_role from _f)),
          'P0001|not_found|', 'fn_update_role_permissions(B tenant_admin role): not_found (no system-role oracle)');
select is(tests.oracle(format($q$select public.fn_update_role_permissions(%L, '{}', array[{id}]::uuid[])$q$, (select a_waiter_role from _f)), (select b_station from _f)),
          'P0001|invalid_station|', 'fn_update_role_permissions with B station: invalid_station, same as unknown station');
select is(tests.oracle(format($q$select public.fn_change_user_role({id}, %L)$q$, (select a_waiter_role from _f)), (select b_waiter from _f)),
          'P0001|not_found|', 'fn_change_user_role(B profile): not_found, same as unknown profile');
select is(tests.oracle(format($q$select public.fn_change_user_role(%L, {id})$q$, (select a_waiter from _f)), (select b_waiter_role from _f)),
          'P0001|invalid_role|', 'fn_change_user_role(.., B role): invalid_role, same as unknown role');
select is(tests.oracle(format($q$select public.fn_change_user_role(%L, {id})$q$, (select a_waiter from _f)), (select b_admin_role from _f)),
          'P0001|invalid_role|', 'fn_change_user_role(.., B tenant_admin role): invalid_role');
select is(tests.oracle($q$select public.fn_suspend_tenant({id}, 'tenant attacking tenant')$q$, (select b from _f)),
          'P0001|permission_denied|', 'fn_suspend_tenant(B): permission_denied, same as unknown tenant');
select is(tests.oracle($q$select public.fn_reactivate_tenant({id}, 'tenant attacking tenant')$q$, (select b from _f)),
          'P0001|permission_denied|', 'fn_reactivate_tenant(B): permission_denied, same as unknown tenant');
select is(tests.oracle(format($q$select public.fn_provision_tenant('Evil', 'evil-cafe', {id}, 'x@y.example.com', 'E', null, null, %L, null)$q$, (select plan_id from _f)), (select b_admin from _f)),
          'P0001|permission_denied|', 'fn_provision_tenant(owner = B admin): permission_denied, same as unknown user');
select is(tests.oracle($q$select public.fn_set_user_pin({id}, '9999')$q$, (select b_waiter from _f)),
          '42501|permission denied for function fn_set_user_pin|', 'fn_set_user_pin(B staff): privilege denial, same as unknown');
select is(tests.oracle($q$select public.fn_verify_pin({id}, '2222')$q$, (select b_waiter from _f)),
          '42501|permission denied for function fn_verify_pin|', 'fn_verify_pin(B staff, correct PIN): privilege denial, same as unknown');
select is(tests.oracle($q$select public.fn_register_pin_failure({id})$q$, (select b_waiter from _f)),
          '42501|permission denied for function fn_register_pin_failure|', 'fn_register_pin_failure(B staff): privilege denial');
select is(tests.oracle($q$select public.fn_user_auth_method({id})$q$, (select b_waiter from _f)),
          '42501|permission denied for function fn_user_auth_method|', 'fn_user_auth_method(B staff): privilege denial');
select is(tests.oracle($q$select public.fn_seed_tenant_defaults({id})$q$, (select b from _f)),
          '42501|permission denied for function fn_seed_tenant_defaults|', 'fn_seed_tenant_defaults(B): internal only');
select is(tests.oracle($q$select public.fn_next_number({id}, 'order', 'ORD')$q$, (select b from _f)),
          '42501|permission denied for function fn_next_number|', 'fn_next_number(B): internal only (cannot burn B''s counters)');
select is(tests.oracle($q$select public.fn_write_audit('forged', null, {id}, null)$q$, (select b from _f)),
          '42501|permission denied for function fn_write_audit|', 'fn_write_audit(B): cannot forge B audit rows');
select is(tests.oracle($q$select public.fn_write_admin_audit('forged', {id})$q$, (select b from _f)),
          '42501|permission denied for function fn_write_admin_audit|', 'fn_write_admin_audit(B): internal only');
select is(tests.oracle($q$select public.has_station_access({id})$q$, (select b_station from _f)), 'ok:1', 'has_station_access(B station) answers like an unknown station');
select ok(not public.has_station_access((select b_station from _f)), 'has_station_access(B station) is false');
select ok(public.has_station_access((select a_station from _f)), 'has_station_access(own station) is true for the admin');
select ok(not public.is_order_owner((select b_order from _g)), 'is_order_owner(B order) is false');
select ok(not public.order_has_station_access((select b_order from _g)), 'order_has_station_access(B order) is false');
select tests.clear_auth();
select is(tests.snapshot((select b from _f)), (select b from _snap), 'tenant B data is byte-for-byte unchanged after every A admin attack');

-- ═════════ tenant A waiter (least privileged) ═════════
select tests.authenticate_as((select a_waiter from _f));
select is(tests.leaks_read((select a from _f)), '', 'A waiter: no row of any other tenant is readable');
select is(tests.leaks_write((select b from _f)), '', 'A waiter: no write reaches tenant B');
select is(tests.unexpected_inserts((select a from _f)), '', 'A waiter: no INSERT grant outside the allowlist (own tenant)');
select is(tests.oracle($q$select public.fn_update_role_permissions({id}, array['orders.view'], '{}')$q$, (select b_waiter_role from _f)),
          'P0001|permission_denied|', 'A waiter: fn_update_role_permissions(B role) = permission_denied, same as unknown');
select is(tests.oracle(format($q$select public.fn_change_user_role({id}, %L)$q$, (select a_waiter_role from _f)), (select b_waiter from _f)),
          'P0001|permission_denied|', 'A waiter: fn_change_user_role(B profile) = permission_denied, same as unknown');
select tests.clear_auth();

-- own-tenant by-id probing: a waiter sees only its own orders, other waiters' orders behave like unknown ids
select tests.authenticate_as((select a_waiter from _f));
select is(tests.oracle($q$select 1 from public.orders where id = {id}$q$, (select a_colleague_order from _g)),
          'ok:0', 'waiter: a colleague''s order by id behaves like an unknown id');
select tests.clear_auth();

-- ═════════ tenant B admin and waiter against tenant A (the other direction) ═════════
select tests.authenticate_as((select b_admin from _f));
select is(tests.leaks_read((select b from _f)), '', 'B admin: no row of any other tenant is readable');
select is(tests.leaks_write((select a from _f)), '', 'B admin: no write reaches tenant A');
select is(tests.oracle(format($q$select public.fn_change_user_role({id}, %L)$q$, (select b_waiter_role from _f)), (select a_waiter from _f)),
          'P0001|not_found|', 'B admin: fn_change_user_role(A profile) not_found');
select is(tests.oracle($q$select public.fn_update_role_permissions({id}, '{}', '{}')$q$, (select a_waiter_role from _f)),
          'P0001|not_found|', 'B admin: fn_update_role_permissions(A role) not_found');
select tests.clear_auth();
select tests.authenticate_as((select b_waiter from _f));
select is(tests.leaks_read((select b from _f)), '', 'B waiter: no row of any other tenant is readable');
select is(tests.leaks_write((select a from _f)), '', 'B waiter: no write reaches tenant A');
select tests.clear_auth();

-- ═════════ anonymous ═════════
select tests.as_anon();
select is(tests.leaks_read((select b from _f)), '', 'anon reads no tenant table');
select is(tests.leaks_write((select b from _f)), '', 'anon writes no tenant table');
select tests.clear_auth();
select is(tests.snapshot((select a from _f)), (select a from _snap), 'tenant A data is unchanged after the B and anon attacks');
select is(tests.snapshot((select b from _f)), (select b from _snap), 'tenant B data is unchanged after the waiter, B and anon attacks');

select * from finish();
rollback;
