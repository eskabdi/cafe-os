-- Adversarial: immutability (payments, audit logs, stock ledger, closed business days), audit integrity
-- (no forged actors, config changes audited with the real actor), tenant-key immutability, branding scope,
-- and the least-privileged write matrix. Owner, service_role and authenticated are all attacked.
begin;
select plan(108);
set local client_min_messages = warning;   -- TRUNCATE ... CASCADE is chatty

create temp table _f on commit drop as
select tests.tenant_id('central-cafe') a, tests.tenant_id('second-cafe') b,
       tests.user_id('selam', 'central-cafe') admin, tests.user_id('yonas', 'central-cafe') waiter,
       tests.user_id('abebe', 'central-cafe') kitchen, tests.user_id('meron', 'central-cafe') meron,
       tests.user_id('owner', 'second-cafe') b_admin,
       (select id from public.payment_methods where restaurant_id = tests.tenant_id('central-cafe') and name = 'Cash') pm_cash,
       (select id from public.expense_categories where restaurant_id = tests.tenant_id('central-cafe') and name = 'Rent') exp_rent,
       (select id from public.stations where restaurant_id = tests.tenant_id('central-cafe') and name = 'Kitchen') st_kitchen,
       (select id from public.day_sessions where restaurant_id = tests.tenant_id('central-cafe') and status = 'open') day1;
grant all on _f to public;
create temp table _ctx (order_id uuid, item_id uuid, expense_id uuid, day2 uuid);
grant all on _ctx to public;

insert into public.orders (restaurant_id, day_session_id, order_no, created_by, created_by_name_snapshot, subtotal, vat_rate_snapshot, vat_amount, total)
  select a, day1, 'ORD-0001', waiter, 'Yonas Tesfaye', 420, 15, 63, 483 from _f;
insert into _ctx (order_id) select id from public.orders where order_no = 'ORD-0001' and restaurant_id = (select a from _f);
insert into public.order_items (restaurant_id, order_id, menu_item_id, name_snapshot, price_snapshot, qty, station_id, station_name_snapshot)
  select f.a, c.order_id, (select id from public.menu_items where name = 'Doro Wat' and restaurant_id = f.a), 'Doro Wat', 420, 1, f.st_kitchen, 'Kitchen' from _f f, _ctx c;
update _ctx set item_id = (select id from public.order_items where order_id = _ctx.order_id);
insert into public.payments (restaurant_id, day_session_id, order_id, kind, amount, payment_method_id, method_name_snapshot, method_affects_drawer_snapshot, receipt_no)
  select f.a, f.day1, c.order_id, 'order_payment', 483, f.pm_cash, 'Cash', true, 'RCT-0001' from _f f, _ctx c;
insert into public.expenses (restaurant_id, expense_category_id, payment_method_id, amount, description)
  select a, exp_rent, pm_cash, 1000, 'rent' from _f;
update _ctx set expense_id = (select id from public.expenses where description = 'rent' and restaurant_id = (select a from _f));

-- ═════════ append-only tables: owner, service_role and authenticated ═════════
select is(tests.run($q$update public.payments set amount = 1$q$), 'P0001|immutable_record|payments', 'payments: UPDATE blocked for the owner');
select is(tests.run($q$delete from public.payments$q$), 'P0001|immutable_record|payments', 'payments: DELETE blocked for the owner');
select matches(tests.run($q$truncate public.payments$q$), '^(P0001\|immutable_record\||0A000\|cannot truncate a table referenced)', 'payments: TRUNCATE blocked for the owner (trigger or FK, never executed)');
select is(tests.run($q$truncate public.payments cascade$q$), 'P0001|immutable_record|payments', 'payments: TRUNCATE ... CASCADE blocked for the owner');
select is(tests.run($q$insert into public.payments (id, restaurant_id, day_session_id, order_id, kind, amount, payment_method_id, method_name_snapshot, method_affects_drawer_snapshot, receipt_no)
                       select id, restaurant_id, day_session_id, order_id, kind, 1, payment_method_id, method_name_snapshot, method_affects_drawer_snapshot, receipt_no from public.payments
                       on conflict (id) do update set amount = excluded.amount$q$),
          'P0001|immutable_record|payments', 'payments: INSERT ... ON CONFLICT DO UPDATE cannot rewrite a payment');
select matches(tests.run($q$truncate public.restaurants cascade$q$), '^P0001\|immutable_record\|', 'TRUNCATE restaurants CASCADE cannot wipe the ledgers through the foreign keys');
select is(tests.run($q$update public.audit_logs set event = 'tampered'$q$), 'P0001|immutable_record|audit_logs', 'audit_logs: UPDATE blocked for the owner');
select is(tests.run($q$delete from public.audit_logs$q$), 'P0001|immutable_record|audit_logs', 'audit_logs: DELETE blocked for the owner');
select is(tests.run($q$truncate public.audit_logs$q$), 'P0001|immutable_record|audit_logs', 'audit_logs: TRUNCATE blocked for the owner');
select is(tests.run($q$update public.admin_audit_log set action = 'tampered'$q$), 'P0001|immutable_record|admin_audit_log', 'admin_audit_log: UPDATE blocked for the owner');
select is(tests.run($q$delete from public.admin_audit_log$q$), 'P0001|immutable_record|admin_audit_log', 'admin_audit_log: DELETE blocked for the owner');
select is(tests.run($q$truncate public.admin_audit_log$q$), 'P0001|immutable_record|admin_audit_log', 'admin_audit_log: TRUNCATE blocked for the owner');
select is(tests.run($q$update public.stock_movements set qty_delta = 999$q$), 'P0001|immutable_record|stock_movements', 'stock_movements: UPDATE blocked for the owner');
select is(tests.run($q$delete from public.stock_movements$q$), 'P0001|immutable_record|stock_movements', 'stock_movements: DELETE blocked for the owner');
select is(tests.run($q$truncate public.stock_movements$q$), 'P0001|immutable_record|stock_movements', 'stock_movements: TRUNCATE blocked for the owner');

select tests.authenticate_as_service_role();
select is(tests.run($q$update public.payments set amount = 1$q$), 'P0001|immutable_record|payments', 'payments: UPDATE blocked for service_role');
select is(tests.run($q$delete from public.payments$q$), 'P0001|immutable_record|payments', 'payments: DELETE blocked for service_role');
select matches(tests.run($q$truncate public.payments$q$), '^(42501\|permission denied for table payments\||P0001\|immutable_record\||0A000\|cannot truncate a table referenced)', 'payments: TRUNCATE blocked for service_role (trigger or FK, never executed)');
select is(tests.run($q$update public.audit_logs set event = 'tampered'$q$), '42501|permission denied for table audit_logs|', 'audit_logs: UPDATE blocked for service_role');
select is(tests.run($q$delete from public.audit_logs$q$), '42501|permission denied for table audit_logs|', 'audit_logs: DELETE blocked for service_role');
select is(tests.run($q$truncate public.audit_logs$q$), '42501|permission denied for table audit_logs|', 'audit_logs: TRUNCATE blocked for service_role');
select is(tests.run($q$update public.admin_audit_log set action = 'tampered'$q$), '42501|permission denied for table admin_audit_log|', 'admin_audit_log: UPDATE blocked for service_role');
select is(tests.run($q$delete from public.admin_audit_log$q$), '42501|permission denied for table admin_audit_log|', 'admin_audit_log: DELETE blocked for service_role');
select is(tests.run($q$update public.stock_movements set qty_delta = 999$q$), 'P0001|immutable_record|stock_movements', 'stock_movements: UPDATE blocked for service_role');
select is(tests.run($q$delete from public.stock_movements$q$), 'P0001|immutable_record|stock_movements', 'stock_movements: DELETE blocked for service_role');
select is(tests.run($q$truncate public.stock_movements$q$), '42501|permission denied for table stock_movements|', 'stock_movements: TRUNCATE blocked for service_role');
select tests.clear_auth();

select tests.authenticate_as((select admin from _f));
select is(tests.run($q$update public.payments set amount = 1$q$), '42501|permission denied for table payments|', 'payments: tenant_admin has no UPDATE privilege');
select is(tests.run($q$delete from public.payments$q$), '42501|permission denied for table payments|', 'payments: tenant_admin has no DELETE privilege');
select is(tests.run($q$truncate public.payments$q$), '42501|permission denied for table payments|', 'payments: tenant_admin has no TRUNCATE privilege');
select is(tests.run($q$update public.audit_logs set event = 'x'$q$), '42501|permission denied for table audit_logs|', 'audit_logs: tenant_admin has no UPDATE privilege');
select is(tests.run($q$delete from public.audit_logs$q$), '42501|permission denied for table audit_logs|', 'audit_logs: tenant_admin has no DELETE privilege');
select is(tests.run($q$update public.stock_movements set qty_delta = 1$q$), '42501|permission denied for table stock_movements|', 'stock_movements: tenant_admin has no UPDATE privilege');
select is(tests.run($q$delete from public.stock_movements$q$), '42501|permission denied for table stock_movements|', 'stock_movements: tenant_admin has no DELETE privilege');
select is(tests.run(format($q$insert into public.stock_movements (restaurant_id, ingredient_id, station_id, qty_delta, reason) select restaurant_id, id, station_id, 100, 'manual_adjustment' from public.ingredients where restaurant_id = %L limit 1$q$, (select a from _f))),
          '42501|permission denied for table stock_movements|', 'stock ledger rows cannot be inserted by a client');
select is(tests.run(format($q$insert into public.payments (restaurant_id, day_session_id, kind, amount, payment_method_id, method_name_snapshot, method_affects_drawer_snapshot, receipt_no) values (%L, %L, 'order_payment', 1, %L, 'Cash', true, 'RCT-7777')$q$, (select a from _f), (select day1 from _f), (select pm_cash from _f))),
          '42501|permission denied for table payments|', 'payments cannot be inserted by a client');
select is(tests.run($q$update public.ingredients set stock = 9999$q$), '42501|permission denied for table ingredients|', 'stock quantity is not client-writable (RPC-only)');
select is(tests.run($q$update public.orders set total = 0, status = 'served'$q$), '42501|permission denied for table orders|', 'orders cannot be edited directly');
select is(tests.run($q$update public.order_items set item_status = 'ready'$q$), '42501|permission denied for table order_items|', 'order items cannot be edited directly');
select tests.clear_auth();

-- a station operator cannot change another station's (or its own) operational state directly
select tests.authenticate_as((select kitchen from _f));
select is(tests.run($q$update public.order_items set item_status = 'ready'$q$), '42501|permission denied for table order_items|', 'station operator: no direct order_items mutation');
select is(tests.run($q$update public.orders set status = 'ready'$q$), '42501|permission denied for table orders|', 'station operator: no direct orders mutation');
select is(tests.run($q$update public.ingredients set name = 'x'$q$), 'ok:0', 'station operator: no ingredient edits (no inventory.adjust)');
select tests.clear_auth();

-- ═════════ audit integrity ═════════
select tests.authenticate_as((select admin from _f));
select is(tests.run(format($q$insert into public.audit_logs (restaurant_id, actor_id, actor_type, event, action) values (%L, %L, 'user', 'forged', 'event')$q$, (select a from _f), (select waiter from _f))),
          '42501|permission denied for table audit_logs|', 'tenant_admin cannot insert audit rows (no forged actor / fake history)');
select is(tests.run(format($q$select public.fn_write_audit('forged', null, %L)$q$, (select a from _f))),
          '42501|permission denied for function fn_write_audit|', 'fn_write_audit is not callable by clients (and takes no actor argument)');
select is(tests.run($q$select public.fn_write_admin_audit('forged', null)$q$), '42501|permission denied for function fn_write_admin_audit|', 'fn_write_admin_audit is not callable by clients');

-- every config change is audited with the real actor, the real tenant, and only the changed columns
select is(tests.run(format($q$insert into public.stations (restaurant_id, name) values (%L, 'Wok')$q$, (select a from _f))), 'ok:1', 'admin creates a station');
select is(tests.run(format($q$insert into public.categories (restaurant_id, name) values (%L, 'Sides')$q$, (select a from _f))), 'ok:1', 'admin creates a category');
select is(tests.run(format($q$insert into public.payment_methods (restaurant_id, name) values (%L, 'Amole')$q$, (select a from _f))), 'ok:1', 'admin creates a payment method');
select is(tests.run(format($q$insert into public.table_areas (restaurant_id, name) values (%L, 'Garden')$q$, (select a from _f))), 'ok:1', 'admin creates a table area');
select is(tests.run(format($q$insert into public.expense_categories (restaurant_id, name) values (%L, 'Fuel')$q$, (select a from _f))), 'ok:1', 'admin creates an expense category');
select is(tests.run(format($q$insert into public.roles (restaurant_id, name) values (%L, 'Runner')$q$, (select a from _f))), 'ok:1', 'admin creates a role');
select is(tests.run($q$update public.stations set color = '#112233' where name = 'Wok'$q$), 'ok:1', 'admin edits a station');
select is(tests.run($q$update public.restaurants set name = 'Central Cafe & Bakery'$q$), 'ok:1', 'admin edits the restaurant');
select is(tests.run(format($q$select public.fn_update_role_permissions((select id from public.roles where name = 'Runner' and restaurant_id = %L), array['orders.view'], '{}')$q$, (select a from _f))), 'ok:1', 'admin edits a role matrix');
select is(tests.run($q$delete from public.stations where name = 'Wok'$q$), 'ok:1', 'admin deletes an unused station');
select tests.clear_auth();
select is((select count(*)::int from public.audit_logs where event = 'stations.insert' and actor_id = (select admin from _f) and actor_type = 'user' and restaurant_id = (select a from _f) and table_name = 'stations'), 1, 'station insert audited: real actor, tenant and table');
select is((select count(*)::int from public.audit_logs where event = 'categories.insert' and actor_id = (select admin from _f)), 1, 'category insert audited');
select is((select count(*)::int from public.audit_logs where event = 'payment_methods.insert' and actor_id = (select admin from _f)), 1, 'payment method insert audited');
select is((select count(*)::int from public.audit_logs where event = 'table_areas.insert' and actor_id = (select admin from _f)), 1, 'table area insert audited');
select is((select count(*)::int from public.audit_logs where event = 'expense_categories.insert' and actor_id = (select admin from _f)), 1, 'expense category insert audited');
select is((select count(*)::int from public.audit_logs where event = 'roles.insert' and actor_id = (select admin from _f)), 1, 'role insert audited');
select is((select new_data::text from public.audit_logs where event = 'stations.update' and actor_id = (select admin from _f)), '{"color": "#112233"}', 'station update audit carries only the changed columns');
select is((select old_data::text from public.audit_logs where event = 'stations.update' and actor_id = (select admin from _f)), '{"color": null}', '... and the previous value');
select is((select new_data::text from public.audit_logs where event = 'restaurants.update' and actor_id = (select admin from _f)), '{"name": "Central Cafe & Bakery"}', 'restaurant edit audited with the changed column only');
select is((select restaurant_id from public.audit_logs where event = 'restaurants.update' and actor_id = (select admin from _f)), (select a from _f), 'restaurant edit is filed under the right tenant');
select is((select count(*)::int from public.audit_logs where event = 'stations.delete' and actor_id = (select admin from _f)), 1, 'station delete audited');
select is((select count(*)::int from public.audit_logs where event = 'role.permissions_updated' and actor_id = (select admin from _f) and restaurant_id = (select a from _f)), 1, 'matrix change audited by the RPC with the real actor');
select is((select count(*)::int from public.audit_logs where event = 'role_permissions.insert' and actor_id = (select admin from _f)), 1, 'matrix rows audited row-by-row too');
select is((select count(*)::int from public.audit_logs where actor_id = (select admin from _f) and restaurant_id <> (select a from _f)), 0, 'no audit row for the admin is filed under another tenant');
select is((select count(*)::int from public.audit_logs where actor_id is null and actor_type <> 'system'), 0, 'rows without an actor are explicitly typed system');

-- another actor: the audit row carries THAT actor (tenant staff delegated users.manage)
select tests.authenticate_as((select admin from _f));
select is(tests.run(format($q$select public.fn_update_role_permissions((select id from public.roles where name = 'Waiter' and restaurant_id = %L), array['orders.view','orders.create','menu.view','users.view','users.manage'], '{}')$q$, (select a from _f))), 'ok:1', 'admin gives Waiter users.manage for the next check');
select tests.clear_auth();
select tests.authenticate_as((select waiter from _f));
select is(tests.run(format($q$update public.profiles set first_name = 'Meron-Edited' where id = %L$q$, (select meron from _f))), 'ok:1', 'delegated waiter edits a colleague');
select tests.clear_auth();
select is((select actor_id from public.audit_logs where event = 'profiles.update' and record_id = (select meron::text from _f)), (select waiter from _f), 'the audit row names the delegated waiter, not the admin and not the edited user');

-- ═════════ the tenant key never moves ═════════
create function tests.moved_tenant_rows(p_from uuid, p_to uuid) returns text language plpgsql as $$
declare t text; n bigint; o text := '';
begin
  for t in select tests.tenant_tables() loop
    begin
      execute format('select count(*) from public.%I where restaurant_id = $1', t) into n using p_from;
      continue when n = 0;
      execute format('update public.%I set restaurant_id = $1 where restaurant_id = $2', t) using p_to, p_from;
      o := o || t || ' ';
    exception when sqlstate 'P0001' then null;    -- tenant_change_forbidden / immutable_record
              when others then o := o || t || ':' || sqlstate || ' ';
    end;
  end loop;
  return o;
end $$;
select is(tests.moved_tenant_rows((select a from _f), (select b from _f)), '', 'no table lets even the owner re-home rows to another tenant (restaurant_id is immutable)');

-- ═════════ branding scope ═════════
select tests.authenticate_as((select admin from _f));
select is(tests.run(format($q$update public.restaurants set branding = jsonb_set(branding, '{logo_path}', to_jsonb('restaurants/' || %L || '/logo.png'))$q$, (select b from _f))),
          '23514|new row for relation "restaurants" violates check constraint "restaurants_logo_own_tenant_check"|', 'logo path cannot point into another tenant''s storage prefix');
select is(tests.run(format($q$update public.restaurants set branding = jsonb_set(branding, '{logo_path}', to_jsonb('restaurants/' || %L || '/logo.png'))$q$, (select a from _f))), 'ok:1', 'logo path inside the own prefix is accepted');
select matches(tests.run($q$update public.restaurants set branding = jsonb_set(branding, '{logo_path}', '"https://evil.example.com/x.png"')$q$), '^23514\|', 'logo path as a URL is rejected');
select matches(tests.run($q$update public.restaurants set branding = jsonb_set(branding, '{logo_path}', '"data:image/png;base64,AAAA"')$q$), '^23514\|', 'logo path as a data: URI is rejected');
select matches(tests.run(format($q$update public.restaurants set branding = jsonb_set(branding, '{logo_path}', to_jsonb('restaurants/' || %L || '/../%s/x.png'))$q$, (select a from _f), (select b from _f))), '^23514\|', 'path traversal in logo path is rejected');
select matches(tests.run(format($q$update public.menu_items set image_path = 'restaurants/%s/dish.png' where name = 'Doro Wat'$q$, (select b from _f))), '^23514\|', 'menu image path into another tenant''s prefix is rejected');
select tests.clear_auth();

-- ═════════ closed business day ═════════
update public.day_sessions set status = 'closed', closed_at = now(), closed_by = (select admin from _f), order_count = 1, gross_collected = 483, cash_collected = 483,
  cash_expenses = 1000, expenses_total = 1000, expected_cash = 1983, counted_cash = 1983, cash_variance = 0, net_profit = -517,
  station_snapshot = '[]', expense_snapshot = '[]', payment_snapshot = '[]', inventory_variance = 0 where id = (select day1 from _f);
select is(tests.run(format($q$update public.day_sessions set counted_cash = 1 where id = %L$q$, (select day1 from _f))), 'P0001|closed_day_immutable|', 'closed day: edit blocked for the owner');
select is(tests.run(format($q$update public.day_sessions set status = 'open', closed_at = null where id = %L$q$, (select day1 from _f))), 'P0001|closed_day_immutable|', 'closed day: cannot be silently reopened by the owner');
select is(tests.run(format($q$delete from public.day_sessions where id = %L$q$, (select day1 from _f))), 'P0001|closed_day_immutable|day sessions cannot be deleted', 'days are never deleted (owner)');
select tests.authenticate_as_service_role();
select is(tests.run(format($q$update public.day_sessions set counted_cash = 1 where id = %L$q$, (select day1 from _f))), 'P0001|closed_day_immutable|', 'closed day: edit blocked for service_role');
select is(tests.run(format($q$update public.day_sessions set status = 'open', closed_at = null where id = %L$q$, (select day1 from _f))), 'P0001|closed_day_immutable|', 'closed day: reopen blocked for service_role');
select is(tests.run(format($q$delete from public.day_sessions where id = %L$q$, (select day1 from _f))), 'P0001|closed_day_immutable|day sessions cannot be deleted', 'days are never deleted (service_role)');
select tests.clear_auth();
select tests.authenticate_as((select admin from _f));
select is(tests.run(format($q$update public.day_sessions set counted_cash = 1 where id = %L$q$, (select day1 from _f))), '42501|permission denied for table day_sessions|', 'closed day: tenant_admin has no UPDATE privilege');
select is(tests.run(format($q$delete from public.day_sessions where id = %L$q$, (select day1 from _f))), '42501|permission denied for table day_sessions|', 'closed day: tenant_admin has no DELETE privilege');
select is(tests.run(format($q$insert into public.day_sessions (restaurant_id, day_no) values (%L, 2)$q$, (select a from _f))), '42501|permission denied for table day_sessions|', 'tenant_admin cannot open a day by direct INSERT (RPC only)');
select is(tests.run(format($q$update public.expenses set amount = 1 where id = %L$q$, (select expense_id from _ctx))), 'P0001|day_closed|', 'expense of a closed day cannot be edited');
select is(tests.run(format($q$delete from public.expenses where id = %L$q$, (select expense_id from _ctx))), 'P0001|day_closed|', 'expense of a closed day cannot be deleted');
select is(tests.run(format($q$insert into public.expenses (restaurant_id, expense_category_id, payment_method_id, amount, description) values (%L, %L, %L, 5, 'after close')$q$, (select a from _f), (select exp_rent from _f), (select pm_cash from _f))),
          'P0001|day_closed|', 'no expense can be recorded while no business day is open (no orphan, day-less expenses)');
select tests.clear_auth();
select is((select count(*)::int from public.expenses where restaurant_id = (select a from _f) and day_session_id is null), 0, 'no expense without a business day exists');
-- opening day 2 (as the RPC will) makes new expenses land in it, never in the closed one
insert into public.day_sessions (restaurant_id, day_no, status, opening_float, opened_by) select a, 2, 'open', 2500, admin from _f;
update _ctx set day2 = (select id from public.day_sessions where restaurant_id = (select a from _f) and day_no = 2);
select tests.authenticate_as((select admin from _f));
select is(tests.run(format($q$insert into public.expenses (restaurant_id, expense_category_id, payment_method_id, amount, description, created_by, day_session_id) values (%L, %L, %L, 5, 'day two', %L, %L)$q$,
                           (select a from _f), (select exp_rent from _f), (select pm_cash from _f), (select waiter from _f), (select day1 from _f))),
          '42501|permission denied for table expenses|', 'a client cannot choose the expense actor or business day (columns not granted)');
select is(tests.run(format($q$insert into public.expenses (restaurant_id, expense_category_id, payment_method_id, amount, description) values (%L, %L, %L, 5, 'day two')$q$, (select a from _f), (select exp_rent from _f), (select pm_cash from _f))), 'ok:1', 'expense after the next day opens works');
select tests.clear_auth();
select is((select day_session_id from public.expenses where description = 'day two'), (select day2 from _ctx), 'it is filed under the open day (server-chosen)');
select is((select created_by from public.expenses where description = 'day two'), (select admin from _f), 'and carries the real actor (server-chosen)');

-- ═════════ least-privileged write matrix: a waiter may not write any configuration or master data ═════════
select tests.authenticate_as((select kitchen from _f));
select is(tests.run(format($q$insert into public.stations (restaurant_id, name) values (%L, 'Sneaky')$q$, (select a from _f))), '42501|new row violates row-level security policy for table "stations"|', 'no-permission user: station insert denied');
select is(tests.run(format($q$insert into public.categories (restaurant_id, name) values (%L, 'Sneaky')$q$, (select a from _f))), '42501|new row violates row-level security policy for table "categories"|', 'no-permission user: category insert denied');
select is(tests.run(format($q$insert into public.payment_methods (restaurant_id, name) values (%L, 'Sneaky')$q$, (select a from _f))), '42501|new row violates row-level security policy for table "payment_methods"|', 'no-permission user: payment method insert denied');
select is(tests.run(format($q$insert into public.table_areas (restaurant_id, name) values (%L, 'Sneaky')$q$, (select a from _f))), '42501|new row violates row-level security policy for table "table_areas"|', 'no-permission user: table area insert denied');
select is(tests.run(format($q$insert into public.expense_categories (restaurant_id, name) values (%L, 'Sneaky')$q$, (select a from _f))), '42501|new row violates row-level security policy for table "expense_categories"|', 'no-permission user: expense category insert denied');
select is(tests.run(format($q$insert into public.roles (restaurant_id, name) values (%L, 'Sneaky')$q$, (select a from _f))), '42501|new row violates row-level security policy for table "roles"|', 'no-permission user: role insert denied');
select is(tests.run(format($q$insert into public.expenses (restaurant_id, expense_category_id, payment_method_id, amount) values (%L, %L, %L, 1)$q$, (select a from _f), (select exp_rent from _f), (select pm_cash from _f))), '42501|new row violates row-level security policy for table "expenses"|', 'no-permission user: expense insert denied');
select is(tests.run($q$update public.stations set name = 'x'$q$), 'ok:0', 'no-permission user: station update changes nothing');
select is(tests.run($q$update public.roles set name = 'x'$q$), 'ok:0', 'no-permission user: role update changes nothing');
select is(tests.run($q$update public.restaurants set name = 'x'$q$), 'ok:0', 'no-permission user: restaurant update changes nothing');
select is(tests.run($q$delete from public.payment_methods$q$), 'ok:0', 'no-permission user: payment method delete changes nothing');
select is(tests.run($q$delete from public.roles$q$), 'ok:0', 'no-permission user: role delete changes nothing');
select tests.clear_auth();

select * from finish();
rollback;
