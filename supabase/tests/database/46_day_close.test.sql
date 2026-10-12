-- Phase 9 (migration 0038): day close. fn_open_day (one open day, counters reset), fn_close_day (atomic snapshot, unpaid orders block,
-- sessions expire, variance), fn_close_day_preview, fn_list_days, frozen history, permissions, isolation. Gate: close / reopen flow.
-- Fixture by hand: the seed day is closed raw; fn_open_day opens a day with float 1000; waiter o1 Macchiato x2 = 161.00 paid Cash,
-- o2 Shiro Wat = 253.00 paid Telebirr; expense 50.00 Purchases Cash; o3 unpaid blocks the close until cancelled.
-- Expected: gross 414.00, cash 161.00, cash expenses 50.00, expected 1000 + 161 - 50 = 1111.00, counted 1100.00 -> variance -11.00,
-- net 364.00, orders 2.
begin;
select plan(60);

create temp table _f on commit drop as
select tests.tenant_id('central-cafe') a, tests.tenant_id('second-cafe') b,
       tests.user_id('selam', 'central-cafe') a_admin, tests.user_id('yonas', 'central-cafe') a_waiter,
       tests.user_id('hanna', 'central-cafe') a_cashier, tests.user_id('owner', 'second-cafe') b_admin;
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
create function tests.day(p_id uuid) returns public.day_sessions language sql stable security definer set search_path = '' as $$
  select * from public.day_sessions where id = p_id $$;
create function tests.open_count(p_rid uuid) returns int language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.day_sessions where restaurant_id = p_rid and status = 'open' $$;
create function tests.ev(p_rid uuid, p_event text) returns int language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.audit_logs a where a.restaurant_id = p_rid and a.event = p_event $$;
grant execute on all functions in schema tests to public;
-- a second tenant-A user allowed to close (custom role, not tenant_admin): for the cross-user idempotency check
do $$ begin
  declare v_a uuid := tests.tenant_id('central-cafe'); v_r uuid;
  begin
    insert into public.roles (restaurant_id, name) values (v_a, 'Closer') returning id into v_r;
    insert into public.role_permissions (role_id, permission_id, restaurant_id)
      select v_r, id, v_a from public.permissions where key in ('day_close.execute', 'day.open');
    perform tests.create_auth_user('00000000-0000-4000-8000-0000000046c1', 'closer@central-cafe.staff.cafeos.invalid');
    insert into public.profiles (id, restaurant_id, first_name, username, role_id, auth_method) values
      ('00000000-0000-4000-8000-0000000046c1', v_a, 'Kebede', 'closer', v_r, 'pin');
  end;
end $$;
select ok(not has_function_privilege('anon', 'public.fn_close_day(numeric, jsonb, text, text)', 'execute')
          and not has_function_privilege('anon', 'public.fn_close_day_preview()', 'execute')
          and not has_function_privilege('anon', 'public.fn_open_day(numeric, text)', 'execute')
          and not has_function_privilege('anon', 'public.fn_list_days(integer)', 'execute'), 'anon cannot execute the four day RPCs');

-- structure
select is((select count(*)::int from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosecdef and p.proconfig @> array['search_path=""']
           and p.proname in ('fn_day_figures','fn_day_json','fn_close_day_preview','fn_close_day','fn_open_day','fn_list_days')), 6,
          'all six: security definer, empty search_path');
select ok(not has_function_privilege('authenticated', 'public.fn_day_figures(uuid, uuid, jsonb)', 'execute')
          and not has_function_privilege('authenticated', 'public.fn_day_json(uuid, uuid)', 'execute'), 'the builders are internal');

-- the seed day is closed raw; then the RPC opens the next one
update public.day_sessions set status = 'closed', closed_at = now(), closed_by = (select a_admin from _f), order_count = 0, gross_collected = 0, cash_collected = 0,
       cash_expenses = 0, expenses_total = 0, expected_cash = 0, counted_cash = 0, cash_variance = 0, net_profit = 0, inventory_variance = 0,
       station_snapshot = '[]', expense_snapshot = '[]', payment_snapshot = '[]'
where restaurant_id = (select a from _f) and status = 'open';
update public.ingredients set received_today = 1 where restaurant_id = (select a from _f) and id = (select min(id::text)::uuid from public.ingredients where restaurant_id = (select a from _f));

select tests.authenticate_as((select a_waiter from _f));
select is(tests.run($q$select public.fn_open_day(1000, 'day-open-key-w01')$q$), 'P0001|permission_denied|', 'a waiter cannot open a day');
select tests.clear_auth();
select tests.authenticate_as((select a_admin from _f));
select is(tests.run($q$select public.fn_open_day(-1, 'day-open-key-0000')$q$), 'P0001|invalid_input|opening_float', 'negative float refused');
insert into _n select 'd', public.fn_open_day(1000, 'day-open-key-0001')::text;
select is((tests.jv('d') ->> 'status'), 'open', 'a new day is open');
select is((tests.jv('d') ->> 'day_no')::int, (select max(day_no) from public.day_sessions where restaurant_id = (select a from _f)), 'day_no = last + 1');
select is((public.fn_open_day(1000, 'day-open-key-0001') ->> 'replayed'), 'true', 'replay: same day, no second one');
select is(tests.run($q$select public.fn_open_day(1000, 'day-open-key-0002')$q$), 'P0001|invalid_state|day_open', 'only one open day');
select tests.clear_auth();
select is(tests.open_count((select a from _f)), 1, 'exactly one open day');
select is((select count(*)::int from public.ingredients where restaurant_id = (select a from _f)
           and (received_today <> 0 or consumed_today <> 0 or opening_stock <> stock)), 0, 'daily inventory counters reset (opening = stock)');

-- activity
select tests.authenticate_as((select a_waiter from _f));
insert into _n select 'o1', public.fn_submit_order(tests.cart(array['Macchiato:2']), 'day-order-0001') ->> 'id';
insert into _n select 'o2', public.fn_submit_order(tests.cart(array['Shiro Wat:1']), 'day-order-0002') ->> 'id';
insert into _n select 'o3', public.fn_submit_order(tests.cart(array['Macchiato:1']), 'day-order-0003') ->> 'id';
select tests.clear_auth();
select tests.authenticate_as((select a_cashier from _f));
select lives_ok(format($q$select public.fn_confirm_payment(%L, %L, null, 'day-pay-0001')$q$, tests.nv('o1'), tests.pm((select a from _f), 'Cash')), 'pay o1 cash');
select lives_ok(format($q$select public.fn_confirm_payment(%L, %L, 'TB-9', 'day-pay-0002')$q$, tests.nv('o2'), tests.pm((select a from _f), 'Telebirr')), 'pay o2 telebirr');
select tests.clear_auth();
select tests.authenticate_as((select a_admin from _f));
insert into public.expenses (restaurant_id, expense_category_id, payment_method_id, amount, description)
  select a, tests.ec(a, 'Purchases'), tests.pm(a, 'Cash'), 50, 'milk' from _f;

-- preview + blocked close
insert into _n select 'pv', public.fn_close_day_preview()::text;
select is((tests.jv('pv') ->> 'expected_cash')::numeric, 1111.00, 'preview: expected cash 1000 + 161 - 50');
select is((tests.jv('pv') ->> 'unpaid_orders')::int, 1, 'preview: one unpaid order');
select is(tests.run($q$select public.fn_close_day(1100, '[]', null, 'day-close-key-001')$q$), 'P0001|day_close_blocked|unpaid_orders:1',
          'an unpaid order blocks the close (it could never be paid afterwards)');
select is(tests.run($q$select public.fn_close_day(-5, '[]', null, 'day-close-key-002')$q$), 'P0001|invalid_input|counted_cash', 'negative count refused');
select is(tests.run($q$select public.fn_close_day(1100, '[{"ingredient_id": "nope", "counted": 1}]', null, 'day-close-key-003')$q$),
          'P0001|invalid_input|station_counts', 'malformed station count refused');
select is(tests.run(format($q$select public.fn_close_day(1100, '[{"ingredient_id": "%s", "counted": 1}]', null, 'day-close-key-004')$q$,
                          (select id from public.ingredients where restaurant_id = (select b from _f) limit 1))),
          'P0001|invalid_input|station_counts', 'another tenant''s ingredient refused');
insert into _n select 'ing0', (select id from public.ingredients where restaurant_id = (select a from _f) limit 1)::text;
select is(tests.run(format($q$select public.fn_close_day(1100, '[{"ingredient_id": "%s", "counted": 1}, {"ingredient_id": "%s", "counted": 2}]', null, 'day-close-key-005')$q$,
                          lower(tests.nv('ing0')::text), upper(tests.nv('ing0')::text))),
          'P0001|invalid_input|station_counts', 'case variants of one ingredient id are a duplicate');
select is(tests.run(format($q$select public.fn_close_day(1100, '[{"ingredient_id": "%s", "counted": 1}]', null, 'day-close-key-006')$q$, repeat('-', 36))),
          'P0001|invalid_input|station_counts', 'an id of 36 dashes is invalid_input (no raw cast error)');
select is(tests.run($q$select public.fn_list_days(0)$q$), 'P0001|invalid_input|limit', 'fn_list_days: limit 0 refused');
select is(tests.run($q$select public.fn_list_days(367)$q$), 'P0001|invalid_input|limit', 'fn_list_days: limit 367 refused');
select tests.clear_auth();
select tests.authenticate_as((select a_waiter from _f));
select lives_ok(format($q$select public.fn_cancel_order(%L, 'left')$q$, tests.nv('o3')), 'o3 cancelled');
select is(tests.run($q$select public.fn_close_day(1100, '[]', null, 'day-close-key-w01')$q$), 'P0001|permission_denied|', 'a waiter cannot close the day');
select tests.clear_auth();

-- close with counts
insert into _n select 'ing', (select id from public.ingredients where restaurant_id = (select a from _f) and is_active order by name limit 1)::text;
insert into _n select 'ing_stock', (select stock from public.ingredients where id = tests.nv('ing'))::text;
select tests.authenticate_as((select a_admin from _f));
insert into _n select 'c', public.fn_close_day(1100, jsonb_build_array(jsonb_build_object('ingredient_id', tests.nv('ing'), 'counted', (select v::numeric from _n where k = 'ing_stock') - 2)),
                                               'short by 11', 'day-close-key-100')::text;
select is(tests.jv('c') ->> 'status', 'closed', 'closed');
select is((tests.jv('c') ->> 'gross_collected')::numeric, 414.00, 'gross 414');
select is((tests.jv('c') ->> 'cash_collected')::numeric, 161.00, 'cash 161');
select is((tests.jv('c') ->> 'cash_expenses')::numeric, 50.00, 'cash expenses 50');
select is((tests.jv('c') ->> 'expected_cash')::numeric, 1111.00, 'expected 1111');
select is((tests.jv('c') ->> 'cash_variance')::numeric, -11.00, 'variance 1100 - 1111 = -11');
select is((tests.jv('c') ->> 'net_profit')::numeric, 364.00, 'net 414 - 50');
select is((tests.jv('c') ->> 'order_count')::int, 2, 'orders 2 (cancelled excluded)');
select is((tests.jv('c') ->> 'inventory_variance')::numeric, -2.000, 'inventory variance = the one counted difference');
select is((select jsonb_agg(jsonb_build_array(x ->> 'name', (x ->> 'amount')::numeric) order by x ->> 'name') from jsonb_array_elements(tests.jv('c') -> 'payment_snapshot') x),
          '[["Cash", 161.00], ["Telebirr", 253.00]]'::jsonb, 'payment snapshot by method');
select is((public.fn_close_day(1100, jsonb_build_array(jsonb_build_object('ingredient_id', tests.nv('ing'), 'counted', (select v::numeric from _n where k = 'ing_stock') - 2)),
                               'short by 11', 'day-close-key-100') ->> 'replayed'), 'true', 'replay of the close: same result');
select tests.clear_auth();
select tests.authenticate_as('00000000-0000-4000-8000-0000000046c1'::uuid);
select is(tests.run(format($q$select public.fn_close_day(1100, %L, 'short by 11', 'day-close-key-100')$q$,
                          jsonb_build_array(jsonb_build_object('ingredient_id', tests.nv('ing'), 'counted', (select v::numeric from _n where k = 'ing_stock') - 2)))),
          'P0001|idempotency_conflict|', 'another user replaying the same key gets idempotency_conflict');
select tests.clear_auth();

-- frozen + new day
select is(tests.open_count((select a from _f)), 0, 'no open day after the close');
select is(tests.run(format($q$update public.day_sessions set counted_cash = 2000 where id = %L$q$, tests.jv('d') ->> 'id')), 'P0001|closed_day_immutable|',
          'a closed day is frozen even for the owner role');
select is(tests.run(format($q$update public.orders set customer_note = 'x' where id = %L$q$, tests.nv('o1'))), 'P0001|day_closed|',
          'orders of the closed day are frozen');
select is(tests.run(format($q$delete from public.payments where order_id = %L$q$, tests.nv('o1'))) ~ '^P0001\|(day_closed|immutable|payments_immutable)', true,
          'payments of the closed day cannot be removed');
select tests.authenticate_as((select a_admin from _f));
select is(tests.run($q$select public.fn_close_day(0, '[]', null, 'day-close-key-200')$q$), 'P0001|day_closed|no open business day',
          'a closed day cannot be closed again');
select is(tests.run($q$select public.fn_close_day_preview()$q$), 'P0001|day_closed|no open business day', 'no preview without an open day');
insert into _n select 'exp', (select id from public.expenses where restaurant_id = (select a from _f) and description = 'milk')::text;
select is(tests.run($q$insert into public.expenses (restaurant_id, expense_category_id, payment_method_id, amount, description)
                       select a, tests.ec(a, 'Purchases'), tests.pm(a, 'Cash'), 5, 'late' from _f$q$), 'P0001|day_closed|',
          'no expense insert after the close');
select is(tests.run(format($q$update public.expenses set amount = 1 where id = %L$q$, tests.nv('exp'))), 'P0001|day_closed|',
          'an expense of the closed day cannot be updated');
select is(tests.run(format($q$delete from public.expenses where id = %L$q$, tests.nv('exp'))), 'P0001|day_closed|',
          'an expense of the closed day cannot be deleted');
select tests.clear_auth();
select tests.authenticate_as((select a_waiter from _f));
select is(tests.run(format($q$select public.fn_cancel_order(%L, 'late')$q$, tests.nv('o1'))), 'P0001|day_closed|order business day is closed',
          'an order of the closed day cannot be cancelled');
select is(tests.run($q$select public.fn_submit_order('[]', 'day-order-0009')$q$) ~ '^P0001\|(day_closed|invalid_input)', true, 'no orders without an open day');
select tests.clear_auth();
select tests.authenticate_as((select a_admin from _f));
insert into _n select 'd2', public.fn_open_day(2000, 'day-open-key-0100')::text;
select is((tests.jv('d2') ->> 'day_no')::int, (tests.jv('d') ->> 'day_no')::int + 1, 'the new-day workflow opens the next day');
select ok((select (j ->> 'status') = 'closed' and (j ->> 'cash_variance')::numeric = -11.00 from jsonb_array_elements(public.fn_list_days(10)) j
           where (j ->> 'id')::uuid = (tests.jv('d') ->> 'id')::uuid), 'history keeps the closed day readable with its frozen figures');
select tests.clear_auth();

-- isolation + audit
select tests.authenticate_as((select b_admin from _f));
select ok((public.fn_close_day_preview() ->> 'day_id')::uuid is distinct from (tests.jv('d2') ->> 'id')::uuid, 'another tenant previews only its own day');
select is(tests.open_count((select a from _f)), 1, 'tenant A''s new day untouched by tenant B''s calls');
select is((select count(*)::int from jsonb_array_elements(public.fn_list_days(366)) j where (j ->> 'id')::uuid = (tests.jv('d') ->> 'id')::uuid), 0,
          'another tenant does not see the day');
select tests.clear_auth();
-- tenant B closes its own day: tenant A's tables and sessions are untouched
update public.tables set status = 'occupied'
 where id = (select id from public.tables where restaurant_id = (select a from _f) order by label limit 1);
create function tests.a_state(p_rid uuid) returns text language sql stable security definer set search_path = '' as $$
  select format('%s|%s|%s|%s',
    (select string_agg(id::text || status, ',' order by id) from public.tables where restaurant_id = p_rid),
    (select count(*) from public.table_sessions where restaurant_id = p_rid and status = 'open'),
    (select count(*) from public.customer_sessions where restaurant_id = p_rid and status = 'active'),
    (select count(*) from public.day_sessions where restaurant_id = p_rid and status = 'open')) $$;
grant execute on function tests.a_state(uuid) to public;
insert into _n select 'astate', tests.a_state((select a from _f));
select tests.authenticate_as((select b_admin from _f));
select is(tests.run($q$select public.fn_close_day(0, '[]', null, 'day-close-key-b01')$q$), 'ok:1', 'tenant B closes its own day');
select tests.clear_auth();
select is(tests.a_state((select a from _f)), (select v from _n where k = 'astate'), 'tenant B''s close leaves tenant A''s tables and sessions untouched');
select ok(tests.a_state((select a from _f)) like '%occupied%', 'tenant A''s occupied table is still occupied');
select is(tests.ev((select a from _f), 'day.closed'), 1, 'audit: day.closed once (the replay wrote none)');
select is(tests.ev((select a from _f), 'day.opened'), 2, 'audit: day.opened twice');
select is((select (a.new_data ->> 'cash_variance')::numeric from public.audit_logs a where a.restaurant_id = (select a from _f) and a.event = 'day.closed'),
          -11.00, 'audit row carries the variance');
select ok((select bool_and(a.actor_id = (select a_admin from _f)) from public.audit_logs a where a.restaurant_id = (select a from _f)
           and a.event in ('day.closed', 'day.opened')), 'audit actor is the admin');

select * from finish();
rollback;
