-- Phase 8 (migration 0037): reports. GATE: a hand-calculated fixture. A fresh business day 99 with known activity:
--   waiter Yonas: o1 Macchiato x2 = 140.00 + 15% VAT = 161.00 (paid Cash), o2 Shiro Wat x1 = 220.00 + 33.00 = 253.00 (paid Telebirr),
--                 o3 Macchiato x1 = 80.50 (cancelled, reason 'left')
--   admin: expense 50.00 Purchases paid Cash
-- Expected by hand (report r, tenant_admin): orders 2, cancelled 1, items 3, sales 414.00, subtotal 360.00, VAT 54.00, avg 207.00,
-- gross 414.00, cash 161.00, expenses 50.00, net 364.00, unpaid 0; Cash 161.00 x1, Telebirr 253.00 x1; Beverages 2 / 140.00,
-- Lunch 1 / 220.00; Yonas 2 / 414.00; Purchases 50.00 x1.
-- Then (report r2): waiter Meron o4 Macchiato x1 = 80.50 (unpaid); o2's Telebirr payment REVERSED and re-paid Cash; waiter Yonas o5
-- Shiro Wat x2 = 440.00 + 66.00 = 506.00 turned into a voucher (down 106.00 Cash, 2 x 200.00 every 7 days), installment 1 collected
-- Cash. Expected: orders 4, sales 1000.50, subtotal 870.00, VAT 130.50, unpaid 80.50 (o4 only: the voucher order is not unpaid),
-- gross = cash = 161 + 253 - 253 + 253 + 106 + 200 = 720.00, net 670.00; Cash 720.00 x4, Telebirr 0.00 x0 (the reversed original is
-- not counted); reversals 1 / 253.00; installments issued 1 / 506.00, down 106.00, collected 200.00, outstanding 200.00.
-- Business days (tenant tz Africa/Addis_Ababa, base = local today - 20): seed day 1 opened now (base + 20), day 98 opened at local
-- 00:30 of base + 3 (UTC: still base + 2), day 99 opened at local 08:00 of base + 7.
begin;
select plan(133);

create temp table _f on commit drop as
select tests.tenant_id('central-cafe') a, tests.tenant_id('second-cafe') b,
       tests.user_id('selam', 'central-cafe') a_admin, tests.user_id('yonas', 'central-cafe') a_waiter,
       tests.user_id('hanna', 'central-cafe') a_cashier, tests.user_id('owner', 'second-cafe') b_admin,
       tests.user_id('meron', 'central-cafe') a_waiter2, tests.user_id('abebe', 'central-cafe') a_kitchen,
       '00000000-0000-4000-8000-0000000045a1'::uuid a_analyst, '00000000-0000-4000-8000-0000000045a2'::uuid a_stock,
       '00000000-0000-4000-8000-0000000000c1'::uuid super_admin,
       (now() at time zone 'Africa/Addis_Ababa')::date - 20 base;
grant all on _f to public;
create temp table _n (k text primary key, v text);
grant all on _n to public;
create function tests.nv(p_k text) returns uuid language sql stable as $$ select v::uuid from _n where k = p_k $$;
create function tests.jv(p_k text) returns jsonb language sql stable as $$ select v::jsonb from _n where k = p_k $$;
create function tests.pm(p_rid uuid, p_name text) returns uuid language sql stable security definer set search_path = '' as $$
  select id from public.payment_methods where restaurant_id = p_rid and name = p_name $$;
create function tests.ec(p_rid uuid, p_name text) returns uuid language sql stable security definer set search_path = '' as $$
  select id from public.expense_categories where restaurant_id = p_rid and name = p_name $$;
create function tests.cart(p_spec text[]) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_agg(jsonb_build_object('menu_item_id', m.id, 'qty', split_part(s, ':', 2)::int) order by o)
  from unnest(p_spec) with ordinality u(s, o)
  join public.menu_items m on m.name = split_part(s, ':', 1)
   and m.restaurant_id = (select id from public.restaurants where slug = 'central-cafe') $$;
-- local wall-clock time of tenant A on base + p_day -> timestamptz
create function tests.at_local(p_day int, p_time text) returns timestamptz language sql stable as $$
  select ((select base from _f) + p_day + p_time::time) at time zone 'Africa/Addis_Ababa' $$;
-- the list in a report section, as a sorted jsonb array of the given key
create function tests.keys_of(p_doc jsonb, p_section text, p_key text) returns jsonb language sql immutable as $$
  select coalesce(jsonb_agg(x ->> p_key order by x ->> p_key), '[]'::jsonb) from jsonb_array_elements(p_doc -> p_section) x $$;
grant execute on all functions in schema tests to public;

-- ── fixtures: tenant time zone, business days, custom roles ──
update public.restaurants set timezone = 'Africa/Addis_Ababa' where id = (select a from _f);
update public.day_sessions set status = 'closed', closed_at = now(), closed_by = (select a_admin from _f), order_count = 0, gross_collected = 0, cash_collected = 0,
       cash_expenses = 0, expenses_total = 0, expected_cash = 0, counted_cash = 0, cash_variance = 0, net_profit = 0, inventory_variance = 0,
       station_snapshot = '[]', expense_snapshot = '[]', payment_snapshot = '[]'
where restaurant_id = (select a from _f) and status = 'open';
insert into public.day_sessions (restaurant_id, day_no, opened_by, opening_float, opened_at) select a, 98, a_admin, 0, tests.at_local(3, '00:30') from _f;
update public.day_sessions set status = 'closed', closed_at = now(), closed_by = (select a_admin from _f), order_count = 0, gross_collected = 0, cash_collected = 0,
       cash_expenses = 0, expenses_total = 0, expected_cash = 0, counted_cash = 0, cash_variance = 0, net_profit = 0, inventory_variance = 0,
       station_snapshot = '[]', expense_snapshot = '[]', payment_snapshot = '[]'
where restaurant_id = (select a from _f) and status = 'open';
insert into public.day_sessions (restaurant_id, day_no, opened_by, opening_float, opened_at) select a, 99, a_admin, 2500, tests.at_local(7, '08:00') from _f;

-- Analyst: reports.view + dashboard.view only. Stock Analyst: reports.view + inventory.view + dashboard.view, Pastry station only.
do $$ begin
  declare v_a uuid := tests.tenant_id('central-cafe'); v_an uuid; v_st uuid;
  begin
    insert into public.roles (restaurant_id, name) values (v_a, 'Analyst') returning id into v_an;
    insert into public.roles (restaurant_id, name) values (v_a, 'Stock Analyst') returning id into v_st;
    insert into public.role_permissions (role_id, permission_id, restaurant_id)
      select v_an, id, v_a from public.permissions where key in ('reports.view', 'dashboard.view');
    insert into public.role_permissions (role_id, permission_id, restaurant_id)
      select v_st, id, v_a from public.permissions where key in ('reports.view', 'inventory.view', 'dashboard.view');
    insert into public.role_station_access (role_id, station_id, restaurant_id)
      select v_st, s.id, v_a from public.stations s where s.restaurant_id = v_a and s.name = 'Pastry';
    perform tests.create_auth_user('00000000-0000-4000-8000-0000000045a1', 'analyst@central-cafe.staff.cafeos.invalid');
    perform tests.create_auth_user('00000000-0000-4000-8000-0000000045a2', 'stock@central-cafe.staff.cafeos.invalid');
    insert into public.profiles (id, restaurant_id, first_name, username, role_id, auth_method) values
      ('00000000-0000-4000-8000-0000000045a1', v_a, 'Ana', 'analyst', v_an, 'pin'),
      ('00000000-0000-4000-8000-0000000045a2', v_a, 'Stock', 'stockist', v_st, 'pin');
  end;
end $$;
-- a Kitchen ingredient below its minimum too (seed: Blueberries, Pastry, is already low)
update public.ingredients set min_level = 100 where restaurant_id = (select a from _f) and name = 'Berbere';

-- ── catalogue: the two new permissions, granted to every tenant_admin role ──
select is((select string_agg(key || ':' || module, ',' order by key) from public.permissions where key in ('reports.export', 'reports.staff')),
          'reports.export:reports,reports.staff:reports', 'catalogue: reports.export and reports.staff (module reports)');
select is((select count(*)::int from public.roles r cross join public.permissions pm
           where r.system_key = 'tenant_admin' and pm.key in ('reports.export', 'reports.staff')
             and not exists (select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = pm.id)), 0,
          'every tenant_admin role (both tenants) holds reports.export and reports.staff');
select is((select count(*)::int from public.role_permissions rp join public.permissions pm on pm.id = rp.permission_id
           join public.roles r on r.id = rp.role_id where pm.key in ('reports.export', 'reports.staff') and r.system_key is null), 0,
          'no other default role gets them (grantable in the matrix)');

-- ── activity of day 99 (through the real pipeline) ──
select tests.authenticate_as((select a_waiter from _f));
insert into _n select 'o1', public.fn_submit_order(tests.cart(array['Macchiato:2']), 'rep-order-0001') ->> 'id';
insert into _n select 'o2', public.fn_submit_order(tests.cart(array['Shiro Wat:1']), 'rep-order-0002') ->> 'id';
insert into _n select 'o3', public.fn_submit_order(tests.cart(array['Macchiato:1']), 'rep-order-0003') ->> 'id';
select lives_ok(format($q$select public.fn_cancel_order(%L, 'left')$q$, tests.nv('o3')), 'o3 cancelled');
select is(tests.run('select public.fn_report()'), 'P0001|permission_denied|', 'a waiter has no reports');
select is(tests.run('select public.fn_report_period(current_date, current_date)'), 'P0001|permission_denied|', 'a waiter has no period report');
select ok((public.fn_dashboard() -> 'money') is null and (public.fn_dashboard() -> 'recent' -> 0 ->> 'total') is null,
          'dashboard for a waiter (dashboard.view without reports.view): no money figures');
select is((public.fn_dashboard() -> 'orders_by_status' ->> 'submitted')::int, 2, 'dashboard: two live orders');
select ok((public.fn_dashboard() ? 'low_stock_count') and (public.fn_dashboard() -> 'low_stock_count') = 'null'::jsonb,
          'dashboard for a waiter (no inventory.view): low_stock_count withheld');
select tests.clear_auth();

select tests.authenticate_as((select a_cashier from _f));
select lives_ok(format($q$select public.fn_confirm_payment(%L, %L, null, 'rep-pay-0001')$q$, tests.nv('o1'), tests.pm((select a from _f), 'Cash')), 'pay o1 cash');
insert into _n select 'p2', public.fn_confirm_payment(tests.nv('o2'), tests.pm((select a from _f), 'Telebirr'), 'TB-1', 'rep-pay-0002') ->> 'payment_id';
select tests.clear_auth();
select tests.authenticate_as((select a_admin from _f));
insert into public.expenses (restaurant_id, expense_category_id, payment_method_id, amount, description)
  select a, tests.ec(a, 'Purchases'), tests.pm(a, 'Cash'), 50, 'milk' from _f;
insert into _n select 'r', public.fn_report()::text;
select tests.clear_auth();

select is((tests.jv('r') -> 'kpis' ->> 'order_count')::int, 2, 'order_count = 2 (cancelled excluded)');
select is((tests.jv('r') -> 'kpis' ->> 'cancelled_count')::int, 1, 'cancelled_count = 1');
select is((tests.jv('r') -> 'kpis' ->> 'items_sold')::int, 3, 'items_sold = 3');
select is((tests.jv('r') -> 'kpis' ->> 'sales_total')::numeric, 414.00, 'sales_total = 161 + 253');
select is((tests.jv('r') -> 'kpis' ->> 'subtotal_total')::numeric, 360.00, 'subtotal_total = 140 + 220');
select is((tests.jv('r') -> 'kpis' ->> 'vat_total')::numeric, 54.00, 'vat_total = 21 + 33');
select is((tests.jv('r') -> 'kpis' ->> 'avg_order_value')::numeric, 207.00, 'avg = 207');
select is((tests.jv('r') -> 'kpis' ->> 'gross_collected')::numeric, 414.00, 'gross_collected = 414');
select is((tests.jv('r') -> 'kpis' ->> 'cash_collected')::numeric, 161.00, 'cash_collected = 161');
select is((tests.jv('r') -> 'kpis' ->> 'expenses_total')::numeric, 50.00, 'expenses = 50');
select is((tests.jv('r') -> 'kpis' ->> 'net_position')::numeric, 364.00, 'net = 414 - 50');
select is((tests.jv('r') -> 'kpis' ->> 'unpaid_total')::numeric, 0.00, 'nothing unpaid');
select is((select jsonb_agg(jsonb_build_array(x ->> 'name', (x ->> 'amount')::numeric, (x ->> 'count')::int) order by x ->> 'name')
           from jsonb_array_elements(tests.jv('r') -> 'by_payment_method') x),
          '[["Cash", 161.00, 1], ["Telebirr", 253.00, 1]]'::jsonb, 'by payment method');
select is((select jsonb_agg(jsonb_build_array(x ->> 'name', (x ->> 'qty')::int, (x ->> 'amount')::numeric) order by x ->> 'name')
           from jsonb_array_elements(tests.jv('r') -> 'by_category') x),
          '[["Beverages", 2, 140.00], ["Lunch", 1, 220.00]]'::jsonb, 'by category (pre-VAT line totals)');
select is((select jsonb_agg(jsonb_build_array((x ->> 'orders')::int, (x ->> 'sales')::numeric)) from jsonb_array_elements(tests.jv('r') -> 'by_waiter') x),
          '[[2, 414.00]]'::jsonb, 'by waiter: one waiter, 2 orders, 414');
select is((select jsonb_agg(jsonb_build_array(x ->> 'name', (x ->> 'amount')::numeric, (x ->> 'count')::int)) from jsonb_array_elements(tests.jv('r') -> 'by_expense_category') x),
          '[["Purchases", 50.00, 1]]'::jsonb, 'by expense category');
select is(jsonb_array_length(tests.jv('r') -> 'by_hour'), 24, 'by hour: 24 buckets');
select is(jsonb_typeof(tests.jv('r') -> 'inventory' -> 'consumption'), 'array', 'consumption is a list');
select is(tests.jv('r') ->> 'timezone', 'Africa/Addis_Ababa', 'the tenant time zone travels with the report');
select is(tests.jv('r') -> 'restricted', '[]'::jsonb, 'tenant_admin: nothing restricted');
select is((select jsonb_agg(jsonb_build_array(x ->> 'order_no', (x ->> 'total')::numeric, x ->> 'reason', x ->> 'by_name'))
           from jsonb_array_elements(tests.jv('r') -> 'cancellations' -> 'items') x),
          jsonb_build_array(jsonb_build_array((select order_no from public.orders where id = tests.nv('o3')), 80.50, 'left', 'Yonas Tesfaye')),
          'cancellations: order no, total, reason and who cancelled');

-- category snapshot: filled by trigger from the menu item at insert, frozen afterwards
select is((select string_agg(distinct oi.category_name_snapshot, ',') from public.order_items oi where oi.order_id = tests.nv('o1')), 'Beverages',
          'order_items.category_name_snapshot is set from the menu item at insert');
select ok((select bool_and(oi.category_id_snapshot = m.category_id) from public.order_items oi join public.menu_items m on m.id = oi.menu_item_id
           where oi.order_id = tests.nv('o1')), 'order_items.category_id_snapshot = the menu item''s category at insert');

-- ── gating: per-section permissions (M1/M2) ──
select tests.authenticate_as((select a_cashier from _f));
insert into _n select 'rc', public.fn_report()::text;
select tests.clear_auth();
select is(tests.jv('rc') -> 'restricted', '["expenses", "inventory", "staff"]'::jsonb,
          'cashier (reports.view, payments.view, vouchers.view): expenses, inventory and staff withheld');
select ok((tests.jv('rc') -> 'kpis' -> 'expenses_total') = 'null'::jsonb and (tests.jv('rc') -> 'kpis' -> 'net_position') = 'null'::jsonb
          and (tests.jv('rc') -> 'by_expense_category') = 'null'::jsonb and (tests.jv('rc') -> 'by_day' -> 0 -> 'expenses') = 'null'::jsonb,
          'without expenses.view: expenses_total, net_position, by_expense_category and by_day[].expenses are null');
select ok((tests.jv('rc') -> 'inventory') = 'null'::jsonb and (tests.jv('rc') -> 'by_waiter') = 'null'::jsonb,
          'without inventory.view / reports.staff: inventory and by_waiter are null');
select ok((tests.jv('rc') -> 'kpis' ->> 'gross_collected')::numeric = 414.00 and jsonb_typeof(tests.jv('rc') -> 'by_payment_method') = 'array'
          and jsonb_typeof(tests.jv('rc') -> 'installments') = 'object', 'cashier keeps the payment and installment sections');
select is((select jsonb_agg(jsonb_build_array(x ->> 'order_no', (x ->> 'total')::numeric, x ->> 'reason', x -> 'by_name'))
           from jsonb_array_elements(tests.jv('rc') -> 'cancellations' -> 'items') x),
          jsonb_build_array(jsonb_build_array((select order_no from public.orders where id = tests.nv('o3')), 80.50, 'left', null)),
          'without reports.staff: cancellations keep order no, total and reason, but by_name (who cancelled) is null');

select tests.authenticate_as((select a_analyst from _f));
insert into _n select 'ra', public.fn_report()::text;
select is(tests.jv('ra') -> 'restricted', '["expenses", "installments", "inventory", "payments", "staff"]'::jsonb,
          'a role with only reports.view: every gated section is listed in restricted');
select ok((select bool_and(tests.jv('ra') -> 'kpis' -> k = 'null'::jsonb)
           from unnest(array['gross_collected', 'cash_collected', 'expenses_total', 'net_position', 'vouchers_outstanding', 'vouchers_overdue']) k),
          'reports.view only: every gated KPI is null');
select ok((select bool_and(tests.jv('ra') -> k = 'null'::jsonb)
           from unnest(array['by_payment_method', 'by_waiter', 'by_expense_category', 'inventory', 'installments', 'reversals']) k)
          and (tests.jv('ra') -> 'by_day' -> 0 -> 'collected') = 'null'::jsonb,
          'reports.view only: every gated section (and by_day[].collected) is null');
select ok((tests.jv('ra') -> 'kpis' ->> 'sales_total')::numeric = 414.00 and jsonb_array_length(tests.jv('ra') -> 'by_category') = 2
          and jsonb_array_length(tests.jv('ra') -> 'by_item') = 2 and (tests.jv('ra') -> 'cancellations' ->> 'count')::int = 1,
          'reports.view only: sales, categories, items and cancellations stay');
select is((select count(*)::int from jsonb_array_elements(tests.jv('ra') -> 'cancellations' -> 'items') x where x -> 'by_name' <> 'null'::jsonb), 0,
          'reports.view only: no staff name in cancellations.items[].by_name');
select ok((public.fn_dashboard() -> 'money') is null and (public.fn_dashboard() -> 'recent') = '[]'::jsonb,
          'dashboard with reports.view but not payments.view: no money block (and no orders.view: no recent orders)');
select tests.clear_auth();

-- inventory station scope (same predicate as ingredients_select): Stock Analyst sees Pastry only
select tests.authenticate_as((select a_stock from _f));
insert into _n select 'rs', public.fn_report()::text;
select is((select count(*)::int from jsonb_array_elements(tests.jv('rs') -> 'inventory' -> 'low_stock') x
           join public.ingredients i on i.id = (x ->> 'ingredient_id')::uuid join public.stations s on s.id = i.station_id
           where s.name <> 'Pastry'), 0, 'low_stock is station-scoped: no ingredient of another station');
select ok(tests.keys_of(tests.jv('rs') -> 'inventory', 'low_stock', 'name') ? 'Blueberries', 'low_stock: the Pastry low item is there');
select is(tests.jv('rs') -> 'inventory' -> 'consumption', '[]'::jsonb, 'consumption is station-scoped (the day consumed Bar / Kitchen stock only)');
select is((public.fn_dashboard() ->> 'low_stock_count')::int,
          (select count(*)::int from public.ingredients i join public.stations s on s.id = i.station_id
           where i.restaurant_id = (select a from _f) and i.is_active and i.stock <= i.min_level and s.name = 'Pastry'),
          'dashboard low_stock_count is station-scoped');
select tests.clear_auth();
select tests.authenticate_as((select a_admin from _f));
select ok(tests.keys_of(public.fn_report() -> 'inventory', 'low_stock', 'name') @> '["Berbere", "Blueberries"]'::jsonb
          and jsonb_array_length(public.fn_report() -> 'inventory' -> 'consumption') > 0, 'tenant_admin: every station''s low stock and consumption');
select tests.clear_auth();

-- ── day ranges ──
select tests.authenticate_as((select a_cashier from _f));
select is(jsonb_array_length(public.fn_report(1, 99) -> 'days'), (select count(*)::int from public.day_sessions where restaurant_id = (select a from _f)),
          'a day range covers every day in it');
select is(tests.run('select public.fn_report(5, 2)'), 'P0001|invalid_input|day_range', 'a reversed range is refused');
select is(tests.run('select public.fn_report(1, 367)'), 'P0001|invalid_input|day_range', 'a span of more than 366 days (to - from > 365) is refused');
select is(tests.run('select public.fn_report(1, 366)'), 'ok:1', 'a span of 366 days is accepted (the same limit as fn_report_period)');
select is(tests.run('select public.fn_report(0, null)'), 'P0001|invalid_input|day_range', 'day 0 is refused');
select is((select jsonb_agg((x ->> 'day_no')::int) from jsonb_array_elements(public.fn_report(1, null) -> 'days') x), '[1]'::jsonb,
          '(1, null) is the single day 1, not an open-ended range');
select is((select jsonb_agg((x ->> 'day_no')::int) from jsonb_array_elements(public.fn_report(null, 98) -> 'days') x), '[98]'::jsonb,
          '(null, 98) is the single day 98');
select ok((public.fn_dashboard() -> 'money' ->> 'gross_collected')::numeric = 414.00, 'dashboard with reports.view and payments.view: money figures of the open day');
select tests.clear_auth();

-- dashboard 'recent' honours the order-visibility rule: a waiter (no orders.view_all) sees only own orders; since 0042 the status counts use the same rule
select tests.authenticate_as((select a_waiter2 from _f));
insert into _n select 'o4', public.fn_submit_order(tests.cart(array['Macchiato:1']), 'rep-order-0004') ->> 'id';
select tests.clear_auth();
select tests.authenticate_as((select a_waiter from _f));
select is((select count(*)::int from jsonb_array_elements(public.fn_dashboard() -> 'recent') x where (x ->> 'id')::uuid = tests.nv('o4')), 0,
          'dashboard recent: a waiter does not see another waiter''s order');
select is((select count(*)::int from jsonb_array_elements(public.fn_dashboard() -> 'recent') x), 3, 'dashboard recent: the waiter''s own three orders');
select is((select sum(v::int)::int from jsonb_each_text(public.fn_dashboard() -> 'orders_by_status') e(k, v)), 3, 'dashboard status counts are scoped like recent (0042): own o1..o3 only, not the other waiter''s o4');
select tests.clear_auth();
select tests.authenticate_as((select a_kitchen from _f));
select is(tests.run('select public.fn_dashboard()'), 'P0001|permission_denied|', 'a station role without dashboard.view has no dashboard');
select tests.clear_auth();
select tests.authenticate_as((select a_cashier from _f));
select is((select count(*)::int from jsonb_array_elements(public.fn_dashboard() -> 'recent') x), 4, 'dashboard recent: orders.view_all sees every order of the day');
select ok((select bool_and(x ? 'total' and jsonb_typeof(x -> 'total') = 'number') from jsonb_array_elements(public.fn_dashboard() -> 'recent') x),
          'dashboard recent: totals present with reports.view and payments.view');
select is(public.fn_dashboard() -> 'low_stock_count', 'null'::jsonb, 'dashboard: reports.view alone no longer reveals low_stock_count (inventory.view needed)');
select tests.clear_auth();

-- ── reversal, re-payment with another method, voucher with down payment and one installment ──
select tests.aal2((select a_admin from _f));
select lives_ok(format($q$select public.fn_reverse_payment(%L, 'wrong method', 'rep-rev-0001')$q$, tests.nv('p2')), 'reverse o2''s Telebirr payment');
select tests.clear_auth();
select tests.authenticate_as((select a_cashier from _f));
select lives_ok(format($q$select public.fn_confirm_payment(%L, %L, null, 'rep-pay-0003')$q$, tests.nv('o2'), tests.pm((select a from _f), 'Cash')), 're-pay o2 cash');
select tests.clear_auth();
select tests.authenticate_as((select a_waiter from _f));
insert into _n select 'o5', public.fn_submit_order(tests.cart(array['Shiro Wat:2']), 'rep-order-0005') ->> 'id';
select tests.clear_auth();
select tests.authenticate_as((select a_cashier from _f));
insert into _n select 'v5', public.fn_generate_voucher(tests.nv('o5'), 'Almaz Kebede', null, 106, tests.pm((select a from _f), 'Cash'), null, 2, 7, 'rep-vch-0001') -> 'voucher' ->> 'id';
select lives_ok(format($q$select public.fn_confirm_installment(%L, %L, null, 'rep-inst-0001')$q$, tests.nv('v5'), tests.pm((select a from _f), 'Cash')), 'collect installment 1');
select tests.clear_auth();
-- exact local hours: o1 09:30, o4 09:45, o2 23:59, o5 00:00 (the next local day; UTC 21:00)
update public.orders set created_at = tests.at_local(7, '09:30') where id = tests.nv('o1');
update public.orders set created_at = tests.at_local(7, '09:45') where id = tests.nv('o4');
update public.orders set created_at = tests.at_local(7, '23:59') where id = tests.nv('o2');
update public.orders set created_at = tests.at_local(8, '00:00') where id = tests.nv('o5');

select tests.authenticate_as((select a_admin from _f));
insert into _n select 'r2', public.fn_report()::text;
insert into _n select 'p99', public.fn_report_period((select base + 7 from _f), (select base + 7 from _f))::text;
select tests.clear_auth();
select is((select jsonb_build_array((k ->> 'order_count')::int, (k ->> 'sales_total')::numeric, (k ->> 'subtotal_total')::numeric, (k ->> 'vat_total')::numeric,
                                    (k ->> 'unpaid_total')::numeric) from (select tests.jv('r2') -> 'kpis' k) x),
          '[4, 1000.50, 870.00, 130.50, 80.50]'::jsonb, 'r2: orders, sales, subtotal, VAT, unpaid (the voucher order is not unpaid)');
select is((select jsonb_build_array((k ->> 'gross_collected')::numeric, (k ->> 'cash_collected')::numeric, (k ->> 'net_position')::numeric)
           from (select tests.jv('r2') -> 'kpis' k) x),
          '[720.00, 720.00, 670.00]'::jsonb, 'r2: gross = cash = 720 (net of the reversal, incl. down payment and installment), net 670');
select is((select jsonb_agg(jsonb_build_array(x ->> 'name', (x ->> 'amount')::numeric, (x ->> 'count')::int) order by x ->> 'name')
           from jsonb_array_elements(tests.jv('r2') -> 'by_payment_method') x),
          '[["Cash", 720.00, 4], ["Telebirr", 0.00, 0]]'::jsonb, 'by payment method: the reversed original is not counted, net 0');
select is((select jsonb_build_array((r ->> 'count')::int, (r ->> 'amount')::numeric, r -> 'items' -> 0 ->> 'method', r -> 'items' -> 0 ->> 'by_name',
                                    (r -> 'items' -> 0 ->> 'receipt_no') ~ '^RCT-')
           from (select tests.jv('r2') -> 'reversals' r) x),
          '[1, 253.00, "Telebirr", "Selam Abate", true]'::jsonb, 'reversals: count, amount, method, who, receipt');
select tests.authenticate_as((select a_cashier from _f));
select is((select jsonb_build_array((r -> 'reversals' ->> 'count')::int, r -> 'reversals' -> 'items' -> 0 -> 'by_name',
                                    r -> 'cancellations' -> 'items' -> 0 -> 'by_name')
           from (select public.fn_report() r) x),
          '[1, null, null]'::jsonb, 'without reports.staff: reversals.items[].by_name is null as well');
select tests.clear_auth();
select is((select jsonb_build_array((i ->> 'issued_count')::int, (i ->> 'issued_total')::numeric, (i ->> 'down_total')::numeric,
                                    (i ->> 'collected_total')::numeric, (i ->> 'outstanding_total')::numeric, (i ->> 'overdue_count')::int)
           from (select tests.jv('r2') -> 'installments' i) x),
          '[1, 506.00, 106.00, 200.00, 200.00, 0]'::jsonb, 'installments: issued, down, collected, outstanding, overdue');
select is((select jsonb_agg(jsonb_build_array((x ->> 'hour')::int, (x ->> 'orders')::int, (x ->> 'sales')::numeric) order by (x ->> 'hour')::int)
           from jsonb_array_elements(tests.jv('r2') -> 'by_hour') x where (x ->> 'orders')::int > 0),
          '[[0, 1, 506.00], [9, 2, 241.50], [23, 1, 253.00]]'::jsonb, 'by_hour: exact buckets in the tenant time zone');
select is((select jsonb_agg(jsonb_build_array(x ->> 'name', (x ->> 'qty')::int, (x ->> 'amount')::numeric))
           from jsonb_array_elements(tests.jv('r2') -> 'by_item') x),
          '[["Shiro Wat", 3, 660.00], ["Macchiato", 3, 210.00]]'::jsonb, 'by_item: by amount, latest name snapshot');
select is((select jsonb_agg(jsonb_build_array(x ->> 'name', (x ->> 'orders')::int, (x ->> 'sales')::numeric))
           from jsonb_array_elements(tests.jv('r2') -> 'by_waiter') x),
          '[["Yonas Tesfaye", 3, 920.00], ["Meron Alemu", 1, 80.50]]'::jsonb, 'by_waiter (reports.staff): latest name snapshot');
select is((select jsonb_agg(jsonb_build_array((x ->> 'day_no')::int, x ->> 'date', (x ->> 'orders')::int, (x ->> 'sales')::numeric,
                                              (x ->> 'collected')::numeric, (x ->> 'expenses')::numeric))
           from jsonb_array_elements(tests.jv('r2') -> 'by_day') x),
          jsonb_build_array(jsonb_build_array(99, ((select base from _f) + 7)::text, 4, 1000.50, 720.00, 50.00)), 'by_day: one row per business day, local date');
select is(tests.jv('p99') - 'period', tests.jv('r2'), 'fn_report_period over day 99''s date = fn_report of day 99');
select is(tests.jv('p99') -> 'period', jsonb_build_object('from', (select base + 7 from _f), 'to', (select base + 7 from _f)), 'period echoes from / to');

-- an overdue voucher: the open installment falls due yesterday (tenant-local)
update public.installments set due_date = (now() at time zone 'Africa/Addis_Ababa')::date - 1 where voucher_id = tests.nv('v5') and no = 2;
select tests.authenticate_as((select a_admin from _f));
select is((public.fn_report() -> 'installments' ->> 'overdue_count')::int, 1, 'installments: an overdue voucher is counted');
select is((public.fn_report() -> 'kpis' ->> 'vouchers_overdue')::int, 1, 'kpis.vouchers_overdue agrees');
select tests.clear_auth();

-- moving the menu item to another category later does not rewrite history
update public.menu_items set category_id = (select id from public.categories where restaurant_id = (select a from _f) and name = 'Lunch')
 where restaurant_id = (select a from _f) and name = 'Macchiato';
update public.order_items set category_id_snapshot = (select id from public.categories where restaurant_id = (select a from _f) and name = 'Lunch'),
                              category_name_snapshot = 'Rewritten'
 where order_id = tests.nv('o1');
select tests.authenticate_as((select a_admin from _f));
select is((select jsonb_agg(jsonb_build_array(x ->> 'name', (x ->> 'qty')::int, (x ->> 'amount')::numeric) order by x ->> 'name')
           from jsonb_array_elements(public.fn_report() -> 'by_category') x),
          '[["Beverages", 3, 210.00], ["Lunch", 3, 660.00]]'::jsonb, 'by_category uses the snapshot: a later recategorisation (or an UPDATE of it) changes nothing');
select tests.clear_auth();

-- ── fn_report_period windows (business days by tenant-local opened_at date) ──
select tests.authenticate_as((select a_admin from _f));
select is((select jsonb_agg((x ->> 'day_no')::int order by (x ->> 'day_no')::int) from jsonb_array_elements(public.fn_report_period((select base + 7 from _f), (select base + 7 from _f)) -> 'days') x),
          '[99]'::jsonb, 'daily window: day 99 only');
select is((select jsonb_agg((x ->> 'day_no')::int order by (x ->> 'day_no')::int) from jsonb_array_elements(public.fn_report_period((select base + 1 from _f), (select base + 7 from _f)) -> 'days') x),
          '[98, 99]'::jsonb, 'weekly window: days 98 and 99');
select is((select jsonb_agg((x ->> 'day_no')::int order by (x ->> 'day_no')::int) from jsonb_array_elements(public.fn_report_period((select base from _f), (select base + 29 from _f)) -> 'days') x),
          '[1, 98, 99]'::jsonb, 'monthly window: every day of the month');
select is(public.fn_report_period((select base + 2 from _f), (select base + 2 from _f)) -> 'days', '[]'::jsonb,
          'day 98 opened at local 00:30 (UTC still the day before): it belongs to the local date, not the UTC one');
select is((select jsonb_agg(x ->> 'date') from jsonb_array_elements(public.fn_report_period((select base + 3 from _f), (select base + 3 from _f)) -> 'by_day') x),
          jsonb_build_array(((select base from _f) + 3)::text), 'by_day.date is the tenant-local date');
select is((select k ->> 'order_count' || '/' || (k ->> 'sales_total') from (select public.fn_report_period((select base - 5 from _f), (select base - 1 from _f)) -> 'kpis' k) x),
          '0/0', 'an empty window: zero figures');
select is(tests.run(format('select public.fn_report_period(%L, %L)', (select base + 7 from _f), (select base from _f))), 'P0001|invalid_input|period', 'to < from is refused');
select is(tests.run(format('select public.fn_report_period(null, %L)', (select base from _f))), 'P0001|invalid_input|period', 'a null bound is refused');
select is(tests.run(format('select public.fn_report_period(%L, %L)', (select base from _f), (select base + 366 from _f))), 'P0001|invalid_input|period', '367 calendar days is refused');
select is(tests.run(format('select public.fn_report_period(%L, %L)', (select base from _f), (select base + 365 from _f))), 'ok:1', '366 calendar days is accepted');
select is(public.fn_report_period((select base from _f), (select base + 29 from _f)), public.fn_report_period((select base from _f), (select base + 29 from _f)),
          'replay: the same period gives the same document');
select tests.clear_auth();

-- ── export audit ──
select tests.authenticate_as((select a_cashier from _f));
select is(tests.run(format($q$select public.fn_log_report_export('summary', %L, %L, 'csv')$q$, (select base from _f), (select base + 7 from _f))),
          'P0001|permission_denied|', 'no reports.export: export refused');
select tests.clear_auth();
select tests.authenticate_as((select a_admin from _f));
select ok((public.fn_log_report_export('revenue', (select base from _f), (select base + 7 from _f), 'pdf') ->> 'ok')::boolean, 'tenant_admin exports');
select is((select jsonb_build_array(a.actor_id, a.restaurant_id, a.new_data) from public.audit_logs a where a.event = 'report.exported' order by a.created_at desc limit 1),
          jsonb_build_array((select a_admin from _f), (select a from _f),
                            jsonb_build_object('report', 'revenue', 'from', (select base from _f), 'to', (select base + 7 from _f), 'format', 'pdf')),
          'audit report.exported {report, from, to, format}, actor and tenant from identity');
select is(tests.run(format($q$select public.fn_log_report_export('everything', %L, %L, 'csv')$q$, (select base from _f), (select base from _f))),
          'P0001|invalid_input|report', 'unknown report type refused');
select is(tests.run(format($q$select public.fn_log_report_export('summary', %L, %L, 'xlsx')$q$, (select base from _f), (select base from _f))),
          'P0001|invalid_input|format', 'unknown format refused');
select is(tests.run(format($q$select public.fn_log_report_export('summary', %L, %L, 'print')$q$, (select base + 1 from _f), (select base from _f))),
          'P0001|invalid_input|period', 'reversed period refused');
select tests.clear_auth();
insert into public.role_permissions (role_id, permission_id, restaurant_id)
  select tests.role_id('Cashier', 'central-cafe'), id, (select a from _f) from public.permissions where key = 'reports.export';
select tests.authenticate_as((select a_cashier from _f));
select is(tests.run(format($q$select public.fn_log_report_export('expenses', %L, %L, 'csv')$q$, (select base from _f), (select base from _f))),
          'P0001|permission_denied|', 'reports.export without expenses.view cannot export the expenses report');
select is(tests.run(format($q$select (public.fn_log_report_export('payments', %L, %L, 'csv') ->> 'ok')$q$, (select base from _f), (select base from _f))),
          'ok:1', 'reports.export + payments.view exports the payments report');
select tests.clear_auth();

-- ── export throttle: at most 20 report.exported rows per user in the last 60 seconds ──
-- 25 rows of the cashier older than the window do not count
insert into public.audit_logs (restaurant_id, actor_id, actor_type, event, action, new_data, created_at)
  select a, a_cashier, 'user', 'report.exported', 'event', '{}'::jsonb, now() - interval '61 seconds' from _f, generate_series(1, 25);
select tests.authenticate_as((select a_cashier from _f));
-- the cashier already exported once above ('payments'); 19 more reach the limit of 20
select is((select count(*)::int from generate_series(1, 19) g
           where tests.run(format($q$select public.fn_log_report_export('summary', %L, %L, 'csv')$q$, (select base from _f), (select base from _f))) = 'ok:1'),
          19, 'throttle: exports up to 20 in 60 seconds pass (rows older than 60 seconds ignored)');
select is(tests.run(format($q$select public.fn_log_report_export('summary', %L, %L, 'csv')$q$, (select base from _f), (select base from _f))),
          'P0001|rate_limited|', 'throttle: the 21st export within 60 seconds is refused with rate_limited');
select is(tests.run(format($q$select public.fn_log_report_export('summary', %L, %L, 'csv')$q$, (select base from _f), (select base from _f))),
          'P0001|rate_limited|', 'throttle: replay stays refused (a refused export writes no audit row)');
select tests.clear_auth();
select is((select count(*)::int from public.audit_logs where actor_id = (select a_cashier from _f) and event = 'report.exported'
           and created_at > now() - interval '60 seconds'), 20, 'throttle: exactly 20 audited exports in the window, none for the refused calls');
select tests.authenticate_as((select a_admin from _f));
select is(tests.run(format($q$select public.fn_log_report_export('summary', %L, %L, 'csv')$q$, (select base from _f), (select base from _f))),
          'ok:1', 'throttle is per user: another user of the tenant still exports');
select tests.clear_auth();
select tests.authenticate_as((select b_admin from _f));
select is(tests.run(format($q$select public.fn_log_report_export('summary', %L, %L, 'csv')$q$, (select base from _f), (select base from _f))),
          'ok:1', 'throttle is per user: tenant B is unaffected');
select tests.clear_auth();
select ok(exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'audit_logs' and indexname = 'audit_logs_report_export_idx'
                  and indexdef like '%(restaurant_id, actor_id, created_at)%' and indexdef like '%report.exported%'),
          'throttle count is backed by the partial index audit_logs_report_export_idx');

-- ── the closed-day guard is back ON everywhere (0037 disables it on order_items for the one-off backfill) ──
select is((select string_agg(c.relname || ':' || t.tgenabled::text, ',' order by c.relname) from pg_trigger t join pg_class c on c.oid = t.tgrelid
           join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and t.tgname = 'trg_01_closed_day' and not t.tgisinternal),
          'customer_sessions:O,installments:O,order_items:O,orders:O,payments:O,stock_movements:O,table_sessions:O,vouchers:O',
          'trg_01_closed_day exists and is enabled (tgenabled = O) on every table it guards');

-- ── permission / portal boundary; internal builders ──
select tests.authenticate_as((select a_kitchen from _f));
select is(tests.run('select public.fn_report(1, 99)'), 'P0001|permission_denied|', 'a station role has no reports');
select tests.clear_auth();
select tests.aal2((select super_admin from _f));
select is(tests.run('select public.fn_report(1, 99)'), 'P0001|permission_denied|', 'the Super Admin (aal2) gets no tenant report');
select is(tests.run('select public.fn_report_period(current_date, current_date)'), 'P0001|permission_denied|', 'the Super Admin gets no period report');
select is(tests.run('select public.fn_dashboard()'), 'P0001|permission_denied|', 'the Super Admin (aal2) gets no tenant dashboard');
select tests.clear_auth();
select tests.as_anon();
select is(tests.run('select public.fn_report()'), '42501|permission denied for function fn_report|', 'anon cannot execute fn_report');
select is(tests.run('select public.fn_report_period(current_date, current_date)'), '42501|permission denied for function fn_report_period|', 'anon cannot execute fn_report_period');
select is(tests.run($q$select public.fn_log_report_export('summary', current_date, current_date, 'csv')$q$), '42501|permission denied for function fn_log_report_export|',
          'anon cannot execute fn_log_report_export');
select is(tests.run('select public.fn_dashboard()'), '42501|permission denied for function fn_dashboard|', 'anon cannot execute fn_dashboard');
select tests.clear_auth();
select tests.authenticate_as((select a_admin from _f));
select is(tests.run('select public.fn_report_days(tests.tenant_id(''second-cafe''), 1, 99)'), '42501|permission denied for function fn_report_days|',
          'fn_report_days (takes a tenant id) is internal, not client-executable');
select is(tests.run('select public.fn_report_build(tests.tenant_id(''second-cafe''), ''{}'')'), '42501|permission denied for function fn_report_build|',
          'fn_report_build (takes a tenant id) is internal');
select is(tests.run('select public.fn_report_light(tests.tenant_id(''second-cafe''), ''{}'')'), '42501|permission denied for function fn_report_light|',
          'fn_report_light (takes a tenant id) is internal');
select tests.clear_auth();

-- ── isolation: B sees none of A's figures ──
select tests.authenticate_as((select b_admin from _f));
insert into _n select 'rb', public.fn_report_period((select base from _f), (select base + 29 from _f))::text;
select is((select count(*)::int from jsonb_array_elements(public.fn_report(1, 99) -> 'days') x
           where (x ->> 'id')::uuid in (select id from public.day_sessions where restaurant_id = (select a from _f))), 0,
          'tenant B''s report covers none of A''s business days');
select is((select count(*)::int from jsonb_array_elements(tests.jv('rb') -> 'days') x
           where (x ->> 'id')::uuid in (select id from public.day_sessions where restaurant_id = (select a from _f))), 0,
          'tenant B''s period report covers none of A''s business days');
select is((select count(*)::int from jsonb_array_elements(tests.jv('rb') -> 'by_payment_method') x
           where (x ->> 'payment_method_id')::uuid in (select id from public.payment_methods where restaurant_id = (select a from _f))), 0,
          'no A payment method in B''s report');
select is((select count(*)::int from jsonb_array_elements(public.fn_report(1, 99) -> 'by_waiter') x
           where (x ->> 'user_id')::uuid in (select id from public.profiles where restaurant_id = (select a from _f))), 0,
          'no A waiter in B''s report');
select is((select count(*)::int from jsonb_array_elements(tests.jv('rb') -> 'inventory' -> 'low_stock') x
           where (x ->> 'ingredient_id')::uuid in (select id from public.ingredients where restaurant_id = (select a from _f)))
          + (select count(*)::int from jsonb_array_elements(tests.jv('rb') -> 'inventory' -> 'consumption') x
             where (x ->> 'ingredient_id')::uuid in (select id from public.ingredients where restaurant_id = (select a from _f))), 0,
          'no A ingredient in B''s low_stock / consumption');
select is((select count(*)::int from jsonb_array_elements(tests.jv('rb') -> 'by_item') x
           where (x ->> 'menu_item_id')::uuid in (select id from public.menu_items where restaurant_id = (select a from _f))), 0,
          'no A menu item in B''s by_item');
select is((tests.jv('rb') -> 'cancellations' ->> 'count')::int + jsonb_array_length(tests.jv('rb') -> 'cancellations' -> 'items'), 0,
          'none of A''s cancellations in B''s report');
select is((select jsonb_build_array((i ->> 'issued_count')::int, (i ->> 'outstanding_total')::numeric, (i ->> 'overdue_count')::int)
           from (select tests.jv('rb') -> 'installments' i) x), '[0, 0, 0]'::jsonb, 'none of A''s vouchers (incl. the overdue one) in B''s figures');
select is((select count(*)::int from jsonb_array_elements(public.fn_dashboard() -> 'recent') x
           where (x ->> 'id')::uuid in (tests.nv('o1'), tests.nv('o2'), tests.nv('o3'), tests.nv('o4'), tests.nv('o5'))), 0, 'no A order on B''s dashboard');
select tests.clear_auth();

-- ── tenant status: reports and the export audit are read actions, so past_due keeps them; suspended loses them ──
update public.restaurants set status = 'past_due' where id = (select a from _f);
select tests.authenticate_as((select a_admin from _f));
select is(tests.run('select public.fn_report(1, 99)'), 'ok:1', 'past_due: reports stay readable');
select is(tests.run(format($q$select public.fn_log_report_export('summary', %L, %L, 'print')$q$, (select base from _f), (select base from _f))), 'ok:1',
          'past_due (tenant_read_only): the export audit is not blocked');
select tests.clear_auth();
update public.restaurants set status = 'suspended' where id = (select a from _f);
select tests.authenticate_as((select a_admin from _f));
select is(tests.run('select public.fn_report(1, 99)'), 'P0001|tenant_suspended|', 'suspended: no report');
select is(tests.run(format($q$select public.fn_log_report_export('summary', %L, %L, 'print')$q$, (select base from _f), (select base from _f))),
          'P0001|tenant_suspended|', 'suspended: no export');
select tests.clear_auth();

select * from finish();
rollback;
