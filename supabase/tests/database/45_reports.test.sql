-- Phase 8 (migration 0037): reports. GATE: a hand-calculated fixture. A fresh business day with known activity:
--   waiter Yonas: o1 Macchiato x2 = 140.00 + 15% VAT = 161.00 (paid Cash), o2 Shiro Wat x1 = 220.00 + 33.00 = 253.00 (paid Telebirr),
--                 o3 Macchiato x1 = 80.50 (cancelled)
--   cashier: expense 50.00 Purchases paid Cash
-- Expected by hand: orders 2, cancelled 1, items 3, sales 414.00, avg 207.00, gross 414.00, cash 161.00, expenses 50.00,
-- net 364.00, unpaid 0; Cash 161.00 x1, Telebirr 253.00 x1; Beverages 2 / 140.00, Lunch 1 / 220.00; Yonas 2 / 414.00;
-- Purchases 50.00 x1.
begin;
select plan(46);

create temp table _f on commit drop as
select tests.tenant_id('central-cafe') a, tests.tenant_id('second-cafe') b,
       tests.user_id('selam', 'central-cafe') a_admin, tests.user_id('yonas', 'central-cafe') a_waiter,
       tests.user_id('hanna', 'central-cafe') a_cashier, tests.user_id('owner', 'second-cafe') b_admin,
       tests.user_id('meron', 'central-cafe') a_waiter2, tests.user_id('abebe', 'central-cafe') a_kitchen,
       '00000000-0000-4000-8000-0000000000c1'::uuid super_admin;
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
grant execute on all functions in schema tests to public;

-- a fresh day: close the seeded one, open day 99 with nothing in it
update public.day_sessions set status = 'closed', closed_at = now(), closed_by = (select a_admin from _f), order_count = 0, gross_collected = 0, cash_collected = 0,
       cash_expenses = 0, expenses_total = 0, expected_cash = 0, counted_cash = 0, cash_variance = 0, net_profit = 0, inventory_variance = 0,
       station_snapshot = '[]', expense_snapshot = '[]', payment_snapshot = '[]'
where restaurant_id = (select a from _f) and status = 'open';
insert into public.day_sessions (restaurant_id, day_no, opened_by, opening_float) select a, 99, a_admin, 2500 from _f;

select tests.authenticate_as((select a_waiter from _f));
insert into _n select 'o1', public.fn_submit_order(tests.cart(array['Macchiato:2']), 'rep-order-0001') ->> 'id';
insert into _n select 'o2', public.fn_submit_order(tests.cart(array['Shiro Wat:1']), 'rep-order-0002') ->> 'id';
insert into _n select 'o3', public.fn_submit_order(tests.cart(array['Macchiato:1']), 'rep-order-0003') ->> 'id';
select lives_ok(format($q$select public.fn_cancel_order(%L, 'left')$q$, tests.nv('o3')), 'o3 cancelled');
select is(tests.run('select public.fn_report()'), 'P0001|permission_denied|', 'a waiter has no reports');
select ok((public.fn_dashboard() -> 'money') is null and (public.fn_dashboard() -> 'recent' -> 0 ->> 'total') is null,
          'dashboard for a waiter (dashboard.view without reports.view): no money figures');
select is((public.fn_dashboard() -> 'orders_by_status' ->> 'submitted')::int, 2, 'dashboard: two live orders');
select ok((public.fn_dashboard() ? 'low_stock_count') and (public.fn_dashboard() -> 'low_stock_count') = 'null'::jsonb,
          'dashboard for a waiter (no inventory.view, no reports.view): low_stock_count withheld');
select tests.clear_auth();

select tests.authenticate_as((select a_cashier from _f));
select lives_ok(format($q$select public.fn_confirm_payment(%L, %L, null, 'rep-pay-0001')$q$, tests.nv('o1'), tests.pm((select a from _f), 'Cash')), 'pay o1 cash');
select lives_ok(format($q$select public.fn_confirm_payment(%L, %L, 'TB-1', 'rep-pay-0002')$q$, tests.nv('o2'), tests.pm((select a from _f), 'Telebirr')), 'pay o2 telebirr');
select tests.clear_auth();
select tests.authenticate_as((select a_admin from _f));
insert into public.expenses (restaurant_id, expense_category_id, payment_method_id, amount, description)
  select a, tests.ec(a, 'Purchases'), tests.pm(a, 'Cash'), 50, 'milk' from _f;
select tests.clear_auth();

select tests.authenticate_as((select a_cashier from _f));
insert into _n select 'r', public.fn_report()::text;
select tests.clear_auth();

select is((tests.jv('r') -> 'kpis' ->> 'order_count')::int, 2, 'order_count = 2 (cancelled excluded)');
select is((tests.jv('r') -> 'kpis' ->> 'cancelled_count')::int, 1, 'cancelled_count = 1');
select is((tests.jv('r') -> 'kpis' ->> 'items_sold')::int, 3, 'items_sold = 3');
select is((tests.jv('r') -> 'kpis' ->> 'sales_total')::numeric, 414.00, 'sales_total = 161 + 253');
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
select is((select sum((x ->> 'orders')::int)::int from jsonb_array_elements(tests.jv('r') -> 'by_hour') x), 2, 'by hour adds up to the order count');
select is(jsonb_array_length(tests.jv('r') -> 'by_hour'), 24, 'by hour: 24 buckets');
select is(jsonb_typeof(tests.jv('r') -> 'inventory' -> 'consumption'), 'array', 'consumption is a list');
select is(tests.jv('r') ->> 'timezone', (select timezone from public.restaurants where id = (select a from _f)), 'the tenant time zone travels with the report');

-- a range report over the closed seed day + day 99 includes both
select tests.authenticate_as((select a_cashier from _f));
select is(jsonb_array_length(public.fn_report(1, 99) -> 'days'), (select count(*)::int from public.day_sessions where restaurant_id = (select a from _f)),
          'a day range covers every day in it');
select is(tests.run('select public.fn_report(5, 2)'), 'P0001|invalid_input|day_range', 'a reversed range is refused');
select ok((public.fn_dashboard() -> 'money' ->> 'gross_collected')::numeric = 414.00, 'dashboard with reports.view: money figures of the open day');
select tests.clear_auth();

-- dashboard 'recent' honours the order-visibility rule: a waiter (no orders.view_all) sees only own orders; counts stay floor-wide
select tests.authenticate_as((select a_waiter2 from _f));
insert into _n select 'o4', public.fn_submit_order(tests.cart(array['Macchiato:1']), 'rep-order-0004') ->> 'id';
select tests.clear_auth();
select tests.authenticate_as((select a_waiter from _f));
select is((select count(*)::int from jsonb_array_elements(public.fn_dashboard() -> 'recent') x where (x ->> 'id')::uuid = tests.nv('o4')), 0,
          'dashboard recent: a waiter does not see another waiter''s order');
select is((select count(*)::int from jsonb_array_elements(public.fn_dashboard() -> 'recent') x), 3, 'dashboard recent: the waiter''s own three orders');
select is((select sum(v::int)::int from jsonb_each_text(public.fn_dashboard() -> 'orders_by_status') e(k, v)), 4, 'dashboard status counts are floor-wide (o1..o4, incl. the other waiter''s)');
select tests.clear_auth();
select tests.authenticate_as((select a_cashier from _f));
select is((select count(*)::int from jsonb_array_elements(public.fn_dashboard() -> 'recent') x), 4, 'dashboard recent: orders.view_all sees every order of the day');
select ok((select bool_and(x ? 'total' and jsonb_typeof(x -> 'total') = 'number') from jsonb_array_elements(public.fn_dashboard() -> 'recent') x),
          'dashboard recent: totals present with reports.view');
select tests.clear_auth();

-- permission / portal boundary
select tests.authenticate_as((select a_kitchen from _f));
select is(tests.run('select public.fn_dashboard()'), 'P0001|permission_denied|', 'a station role without dashboard.view has no dashboard');
select is(tests.run('select public.fn_report(1, 99)'), 'P0001|permission_denied|', 'a station role has no reports');
select tests.clear_auth();
select tests.aal2((select super_admin from _f));
select is(tests.run('select public.fn_report(1, 99)'), 'P0001|permission_denied|', 'the Super Admin (aal2) gets no tenant report');
select is(tests.run('select public.fn_dashboard()'), 'P0001|permission_denied|', 'the Super Admin (aal2) gets no tenant dashboard');
select tests.clear_auth();
select tests.as_anon();
select is(tests.run('select public.fn_report()'), '42501|permission denied for function fn_report|', 'anon cannot execute fn_report');
select is(tests.run('select public.fn_dashboard()'), '42501|permission denied for function fn_dashboard|', 'anon cannot execute fn_dashboard');
select tests.clear_auth();
select tests.authenticate_as((select a_admin from _f));
select is(tests.run('select public.fn_report_days(tests.tenant_id(''second-cafe''), 1, 99)'), '42501|permission denied for function fn_report_days|',
          'fn_report_days (takes a tenant id) is internal, not client-executable');
select tests.clear_auth();

-- isolation: B sees none of A's figures
select tests.authenticate_as((select b_admin from _f));
select ok((public.fn_report(1, 99) -> 'kpis' ->> 'sales_total')::numeric <> 414.00 or (public.fn_report(1, 99) -> 'kpis' ->> 'sales_total') is null,
          'tenant B''s report does not contain A''s sales');
select is((select count(*)::int from jsonb_array_elements(public.fn_report(1, 99) -> 'by_payment_method') x
           where (x ->> 'payment_method_id')::uuid in (select id from public.payment_methods where restaurant_id = (select a from _f))), 0,
          'no A payment method in B''s report');
select is((select count(*)::int from jsonb_array_elements(public.fn_report(1, 99) -> 'by_waiter') x
           where (x ->> 'user_id')::uuid in (select id from public.profiles where restaurant_id = (select a from _f))), 0,
          'no A waiter in B''s report');
select is((select count(*)::int from jsonb_array_elements(public.fn_dashboard() -> 'recent') x
           where (x ->> 'id')::uuid in (tests.nv('o1'), tests.nv('o2'), tests.nv('o3'), tests.nv('o4'))), 0, 'no A order on B''s dashboard');
select tests.clear_auth();

-- tenant status: reports are read-only, so past_due keeps them; suspended loses them
update public.restaurants set status = 'past_due' where id = (select a from _f);
select tests.authenticate_as((select a_cashier from _f));
select is(tests.run('select public.fn_report(1, 99)'), 'ok:1', 'past_due: reports stay readable');
select tests.clear_auth();
update public.restaurants set status = 'suspended' where id = (select a from _f);
select tests.authenticate_as((select a_cashier from _f));
select is(tests.run('select public.fn_report(1, 99)'), 'P0001|tenant_suspended|', 'suspended: no report');
select tests.clear_auth();

select * from finish();
rollback;
