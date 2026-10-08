-- Review/audit follow-ups: branding shape, installment compensating path, no_open_day, identity-guard narrowing,
-- rename guard, column-grant oracle (M1), username grant (L4), resolver (L3), foreign-row UPDATE/DELETE matrix (M3).
begin;
select plan(33);

create temp table _f on commit drop as
select tests.tenant_id('central-cafe') a, tests.tenant_id('second-cafe') b,
       tests.user_id('selam', 'central-cafe') admin, tests.user_id('owner', 'second-cafe') b_admin,
       tests.user_id('hanna', 'central-cafe') cashier, tests.user_id('abebe', 'central-cafe') kitchen,
       tests.user_id('yonas', 'central-cafe') waiter,
       (select id from public.payment_methods where restaurant_id = tests.tenant_id('central-cafe') and name = 'Cash') pm_cash,
       (select id from public.expense_categories where restaurant_id = tests.tenant_id('central-cafe') and name = 'Rent') ec,
       (select id from public.categories where restaurant_id = tests.tenant_id('central-cafe') limit 1) cat,
       (select id from public.stations where restaurant_id = tests.tenant_id('central-cafe') and name = 'Kitchen') st,
       (select id from public.menu_items where restaurant_id = tests.tenant_id('central-cafe') and name = 'Doro Wat') mi,
       (select id from public.menu_items where restaurant_id = tests.tenant_id('second-cafe') limit 1) b_mi,
       (select id from public.tables where restaurant_id = tests.tenant_id('central-cafe') and label = 'T01') tbl,
       (select id from public.day_sessions where restaurant_id = tests.tenant_id('central-cafe') and status = 'open') day1;
grant all on _f to public;
grant execute on all functions in schema tests to public;

-- ═════════ branding ═════════
select matches(tests.run(format($q$update public.restaurants set branding = branding || '{"evil": "x"}' where id = %L$q$, (select a from _f))), '^23514\|', 'branding: unknown key refused');
select matches(tests.run(format($q$update public.restaurants set branding = jsonb_set(branding, '{primary_color}', '"red"') where id = %L$q$, (select a from _f))), '^23514\|', 'branding: non-hex colour refused');
select matches(tests.run(format($q$update public.restaurants set branding = jsonb_set(branding, '{accent_color}', 'null') where id = %L$q$, (select a from _f))), '^23514\|', 'branding: null colour refused');
select matches(tests.run(format($q$update public.restaurants set branding = jsonb_set(branding, '{logo_path}', to_jsonb('restaurants/%s/' || repeat('a', 190) || '.png')) || jsonb_build_object('primary_color', '#112233') where id = %L$q$, (select a from _f), (select a from _f))), '^(ok:1|23514\|)', 'branding: a legal logo path is not the problem');
select matches(tests.run(format($q$update public.restaurants set branding = branding || jsonb_build_object('primary_color', '#' || repeat('a', 5000)) where id = %L$q$, (select a from _f))), '^23514\|', 'branding: oversized / malformed payload refused');
select is(tests.run(format($q$update public.restaurants set branding = '{"primary_color": "#112233", "accent_color": "#445566", "logo_path": null}' where id = %L$q$, (select a from _f))), 'ok:1', 'branding: the legal shape is accepted');
select matches(tests.run(format($q$update public.restaurants set branding = '[]' where id = %L$q$, (select a from _f))), '^23514\|', 'branding: not an object refused');

-- ═════════ closed-day installments: the single compensating path ═════════
insert into public.orders (restaurant_id, day_session_id, order_no, created_by, subtotal, vat_rate_snapshot, vat_amount, total) select a, day1, 'ORD-0001', waiter, 100, 15, 15, 115 from _f;
create temp table _c (order_id uuid, voucher_id uuid, pay1 uuid, pay2 uuid, i1 uuid, i2 uuid, i3 uuid) on commit drop;
grant all on _c to public;
insert into _c default values;
update _c set order_id = (select id from public.orders where order_no = 'ORD-0001' and restaurant_id = (select a from _f));
insert into public.vouchers (restaurant_id, voucher_no, order_id, customer_name, total, installment_count, interval_days) select f.a, 'VCH-0001', c.order_id, 'C', 115, 3, 30 from _f f, _c c;
update _c set voucher_id = (select id from public.vouchers where voucher_no = 'VCH-0001' and restaurant_id = (select a from _f));
insert into public.installments (restaurant_id, voucher_id, no, due_date, amount) select f.a, c.voucher_id, g, current_date + g, 10 from _f f, _c c, generate_series(1, 3) g;
update _c set i1 = (select id from public.installments where no = 1 and voucher_id = _c.voucher_id), i2 = (select id from public.installments where no = 2 and voucher_id = _c.voucher_id), i3 = (select id from public.installments where no = 3 and voucher_id = _c.voucher_id);
insert into public.payments (restaurant_id, day_session_id, order_id, kind, amount, payment_method_id, method_name_snapshot, method_affects_drawer_snapshot, receipt_no) select f.a, f.day1, c.order_id, 'order_payment', 10, f.pm_cash, 'Cash', true, 'RCT-0001' from _f f, _c c;
update _c set pay1 = (select id from public.payments where receipt_no = 'RCT-0001' and restaurant_id = (select a from _f));
update public.installments set paid = true, paid_at = now(), payment_id = (select pay1 from _c) where id = (select i3 from _c);   -- settled BEFORE the close (open day)
update public.day_sessions set status = 'closed', closed_at = now(), closed_by = (select admin from _f), order_count = 1, gross_collected = 10, cash_collected = 10, cash_expenses = 0, expenses_total = 0, expected_cash = 10, counted_cash = 10, cash_variance = 0, net_profit = 10, inventory_variance = 0, station_snapshot = '[]', expense_snapshot = '[]', payment_snapshot = '[]' where id = (select day1 from _f);
insert into public.day_sessions (restaurant_id, day_no, opened_by) select a, 2, admin from _f;
insert into public.payments (restaurant_id, day_session_id, order_id, kind, amount, payment_method_id, method_name_snapshot, method_affects_drawer_snapshot, receipt_no)
  select f.a, (select id from public.day_sessions where restaurant_id = f.a and status = 'open'), c.order_id, 'order_payment', 10, f.pm_cash, 'Cash', true, 'RCT-0002' from _f f, _c c;
update _c set pay2 = (select id from public.payments where receipt_no = 'RCT-0002' and restaurant_id = (select a from _f));
select is(tests.run(format($q$update public.installments set paid = false, paid_at = null, payment_id = null where id = %L$q$, (select i3 from _c))), 'P0001|day_closed|', 'un-paying a settled installment after the close is refused');
select is(tests.run(format($q$update public.installments set payment_id = %L where id = %L$q$, (select pay2 from _c), (select i3 from _c))), 'P0001|day_closed|', 'neither can its payment be re-pointed (nor a settled row edited)');
select is(tests.run(format($q$update public.installments set paid = true, paid_at = now(), payment_id = %L where id = %L$q$, (select pay1 from _c), (select i1 from _c))), 'P0001|day_closed|', 'settling with a payment of the CLOSED day is refused');
select is(tests.run(format($q$update public.installments set paid_at = now() where id = %L$q$, (select i1 from _c))), 'P0001|day_closed|', 'a partial change (paid_at only) is not the compensating path');
select is(tests.run(format($q$update public.installments set paid = true, paid_at = now(), payment_id = %L where id = %L$q$, (select pay2 from _c), (select i1 from _c))), 'ok:1', 'settling an unpaid installment with an open-day payment is the one allowed path');

-- ═════════ no_open_day ═════════
select is(tests.run(format($q$insert into public.stock_movements (restaurant_id, ingredient_id, station_id, qty_delta, reason) select restaurant_id, id, station_id, 1, 'manual_adjustment' from public.ingredients where restaurant_id = %L limit 1$q$, (select a from _f))), 'P0001|no_open_day|', 'stock_movements without a day: no_open_day');
select is(tests.run(format($q$insert into public.table_sessions (restaurant_id, table_id) values (%L, %L)$q$, (select a from _f), (select tbl from _f))), 'P0001|no_open_day|', 'table_sessions without a day: no_open_day');

-- ═════════ identity guard never blocks narrowing; rename guard ═════════
update auth.users set email = 'hanna@real-person.example.com' where id = (select cashier from _f);   -- legacy PIN profile with a non-synthetic email
select tests.authenticate_as((select admin from _f));
select is(tests.run(format($q$update public.profiles set is_active = false where id = %L$q$, (select cashier from _f))), 'ok:1', 'deactivating a profile with a legacy identity is never blocked by the identity check');
select is(tests.run(format($q$update public.profiles set first_name = 'Hanna2' where id = %L$q$, (select cashier from _f))), 'ok:1', 'nor is a rename');
select tests.clear_auth();
update public.profiles set is_active = true where id = (select cashier from _f);
update auth.users set email = 'hanna@central-cafe.staff.cafeos.invalid' where id = (select cashier from _f);
do $$ begin
  declare v_a uuid := tests.tenant_id('central-cafe'); v_lead uuid;
  begin
    insert into public.roles (restaurant_id, name) values (v_a, 'Shift Lead') returning id into v_lead;
    insert into public.role_permissions (role_id, permission_id, restaurant_id) select v_lead, id, v_a from public.permissions where key in ('users.manage', 'users.view', 'orders.view');
    perform tests.create_auth_user('00000000-0000-4000-8000-0000000000f1', 'lead@central-cafe.staff.cafeos.invalid');
    insert into public.profiles (id, restaurant_id, first_name, username, role_id, auth_method) values ('00000000-0000-4000-8000-0000000000f1', v_a, 'Lead', 'lead', v_lead, 'pin');
  end;
end $$;
select tests.authenticate_as('00000000-0000-4000-8000-0000000000f1');
select is(tests.run(format($q$update public.profiles set first_name = 'Renamed' where id = %L$q$, (select cashier from _f))), 'P0001|permission_escalation|target holds rights the caller does not', 'users.manage cannot RENAME a user whose role it does not cover (first_name)');
select is(tests.run(format($q$update public.profiles set last_name = 'X' where id = %L$q$, (select kitchen from _f))), 'P0001|permission_escalation|target holds rights the caller does not', '... nor last_name');
select is(tests.run(format($q$update public.profiles set username = 'hijack' where id = %L$q$, (select cashier from _f))), '42501|permission denied for table profiles|', 'username is not client-updatable at all (L4)');
select tests.clear_auth();
select is(tests.run(format($q$update public.profiles set username = 'hijack' where id = %L$q$, (select cashier from _f))), 'ok:1', 'owner/service contexts may still rename (trigger exempts non-tenant actors)');
select tests.authenticate_as((select admin from _f));
select is(tests.run(format($q$update public.profiles set first_name = 'Ok' where id = %L$q$, (select kitchen from _f))), 'ok:1', 'tenant_admin renames anyone');
select tests.clear_auth();

-- ═════════ M1: client cannot write id / timestamps (cross-tenant existence oracle) ═════════
select tests.authenticate_as((select admin from _f));
select is(tests.oracle(format($q$insert into public.menu_items (id, restaurant_id, name, category_id, station_id, price) values ({id}, %L, 'Oracle', %L, %L, 1)$q$, (select a from _f), (select cat from _f), (select st from _f)), (select b_mi from _f)),
          '42501|permission denied for table menu_items|', 'menu_items: INSERT with a chosen id is refused identically for a foreign and an unknown id');
select is(tests.oracle(format($q$update public.menu_items set id = {id} where id = %L$q$, (select mi from _f)), (select b_mi from _f)),
          '42501|permission denied for table menu_items|', 'menu_items: UPDATE of id refused identically');
select is(tests.run(format($q$update public.menu_items set created_at = now() where id = %L$q$, (select mi from _f))), '42501|permission denied for table menu_items|', 'menu_items.created_at not writable');
select is(tests.oracle(format($q$insert into public.tables (id, restaurant_id, table_area_id, label) values ({id}, %L, (select id from public.table_areas where restaurant_id = %L limit 1), 'Oracle')$q$, (select a from _f), (select a from _f)), (select tbl from _f)),
          '42501|permission denied for table tables|', 'tables: INSERT with a chosen id refused identically');
select is(tests.oracle(format($q$update public.recipe_lines set id = {id} where restaurant_id = %L$q$, (select a from _f)), (select id from public.recipe_lines limit 1)),
          '42501|permission denied for table recipe_lines|', 'recipe_lines: UPDATE of id refused identically');
select is(tests.run(format($q$select public.fn_create_menu_item('Plain New', %L, %L, 5)$q$, (select cat from _f), (select st from _f))), 'ok:1', 'menu_items: a normal create still works (through fn_create_menu_item, the only write path since 0029)');
select tests.clear_auth();

-- ═════════ L3 resolver ═════════
select is((select jsonb_object_keys(public.fn_resolve_tenant_slug('central-cafe')) order by 1 limit 1), 'branding', 'resolver keys: branding ...');
select is((select array_agg(k order by k) from jsonb_object_keys(public.fn_resolve_tenant_slug('central-cafe')) k), array['branding', 'name'], '... and name only (no tenant id)');

-- ═════════ M3: foreign-row UPDATE + DELETE matrix, from the catalog ═════════
-- Every public table on which the authenticated role holds an UPDATE (any column) or DELETE privilege is attacked, per
-- verb, by the OTHER tenant's full tenant_admin against the victim tenant's rows. Anything that changes a row = leak.
insert into public.expenses (restaurant_id, expense_category_id, payment_method_id, amount, description) select a, ec, pm_cash, 5, 'victim expense' from _f;
insert into public.platform_invoices (restaurant_id, subscription_id, amount, period_start, period_end, status) select a, (select id from public.subscriptions where restaurant_id = a), 1, current_date, current_date, 'pending' from _f;
create function tests.foreign_write_matrix(p_victim uuid) returns text language plpgsql as $$
declare
  t record; v_col text; v_filter text; n bigint; o text := '';
begin
  for t in select c.oid, c.relname::text rel,
                  exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped and a.attname = 'restaurant_id') has_rid
           from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' order by 2 loop
    v_filter := case when t.rel = 'restaurants' then format('id = %L', p_victim)
                     when t.has_rid then format('restaurant_id = %L', p_victim)
                     else 'true' end;
    select a.attname into v_col from pg_attribute a
     where a.attrelid = t.oid and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''
       and has_column_privilege('authenticated', t.oid, a.attnum, 'update') order by a.attnum limit 1;
    if v_col is not null then
      begin
        execute format('update public.%I set %I = %I where %s', t.rel, v_col, v_col, v_filter);
        get diagnostics n = row_count;
        if n > 0 then o := o || t.rel || ':update(' || n || ') '; end if;
      exception when insufficient_privilege then null;
                when others then o := o || t.rel || ':update-err ';
      end;
    end if;
    if has_table_privilege('authenticated', t.oid, 'delete') then
      begin
        execute format('delete from public.%I where %s', t.rel, v_filter);
        get diagnostics n = row_count;
        if n > 0 then o := o || t.rel || ':delete(' || n || ') '; end if;
      exception when insufficient_privilege then null;
                when others then o := o || t.rel || ':delete-err ';
      end;
    end if;
  end loop;
  return o;
end $$;
-- the matrix is only meaningful where the victim has rows: list every attackable table that is empty for the victim
create function tests.matrix_vacuous(p_victim uuid) returns text language plpgsql security definer set search_path = pg_catalog, public as $$
declare t record; n bigint; o text := '';
begin
  for t in select c.oid, c.relname::text rel,
                  exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped and a.attname = 'restaurant_id') has_rid
           from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
             and (has_table_privilege('authenticated', c.oid, 'delete') or has_any_column_privilege('authenticated', c.oid, 'update')) order by 2 loop
    execute format('select count(*) from public.%I %s', t.rel,
                   case when t.rel = 'restaurants' then format('where id = %L', p_victim) when t.has_rid then format('where restaurant_id = %L', p_victim) else '' end) into n;
    if n = 0 then o := o || t.rel || ' '; end if;
  end loop;
  return o;
end $$;
grant execute on function tests.foreign_write_matrix(uuid), tests.matrix_vacuous(uuid) to public;
create temp table _snap on commit drop as select tests.snapshot((select a from _f)) a;
grant all on _snap to public;
select is(tests.matrix_vacuous((select a from _f)), '', 'every client-writable table has victim rows (the matrix is not vacuous)');
select tests.authenticate_as((select b_admin from _f));
select is(tests.foreign_write_matrix((select a from _f)), '', 'tenant B admin changes NO row of tenant A through any client UPDATE/DELETE privilege');
select tests.clear_auth();
select is(tests.snapshot((select a from _f)), (select a from _snap), 'tenant A is byte-for-byte unchanged');

-- Structural complement: RLS masks a missing tenant predicate on a DELETE/UPDATE policy behind the SELECT policy
-- (the WHERE clause reads columns), so behaviour alone cannot see it. Every write policy must carry the tenant (or
-- platform) predicate in its USING and, where it has one, its WITH CHECK clause on its own.
select is((select string_agg(p.tablename || '.' || p.policyname || '(' || p.cmd || ')', ',' order by p.tablename, p.policyname)
           from pg_policies p
           where p.schemaname = 'public' and p.cmd in ('UPDATE', 'DELETE', 'INSERT')
             and ((p.cmd in ('UPDATE', 'DELETE') and coalesce(p.qual, '') !~ '(current_restaurant_id|is_platform_admin|is_platform_super_admin|auth\.uid|auth_uid|current_user_id)')
                  or (p.cmd in ('UPDATE', 'INSERT') and coalesce(p.with_check, '') !~ '(current_restaurant_id|is_platform_admin|is_platform_super_admin|auth\.uid|auth_uid|current_user_id)'))),
          null, 'every INSERT/UPDATE/DELETE policy states the tenant/platform predicate in USING and WITH CHECK individually');

select * from finish();
rollback;
