-- Phase 4 (migration 0030) adversarial supplement to 32_orders_pos.test.sql.
-- Every order RPC x {anon, missing permission, PIN-restricted, past_due, suspended}; IDOR with real foreign vs unknown ids (no existence
-- oracle) in both tenant directions; another waiter's order; role escalation (station operator / cashier); direct DML and internal
-- pipeline bypass; payment guard; closed business day (submit, replay, cancel incl. an order of an EARLIER closed day after a new day
-- opened, KDS, serve) with no stock moving. Concurrency (same key, last unit of stock, opposite lock order, cancel vs start) is in
-- scripts/db/race-tests.sh (real concurrent sessions).
begin;
select plan(58);

create temp table _f on commit drop as
select tests.tenant_id('central-cafe') a, tests.tenant_id('second-cafe') b,
       tests.user_id('selam', 'central-cafe') a_admin, tests.user_id('yonas', 'central-cafe') a_waiter,
       tests.user_id('meron', 'central-cafe') a_waiter2, tests.user_id('hanna', 'central-cafe') a_cashier,
       tests.user_id('abebe', 'central-cafe') a_kitchen,
       tests.user_id('owner', 'second-cafe') b_admin, tests.user_id('waiter', 'second-cafe') b_waiter;
grant all on _f to public;
create temp table _n (k text primary key, v text);
grant all on _n to public;
create function tests.nv(p_k text) returns uuid language sql stable as $$ select v::uuid from _n where k = p_k $$;
create function tests.n_movs(p_rid uuid) returns int language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.stock_movements where restaurant_id = p_rid $$;
create function tests.n_orders(p_rid uuid) returns int language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.orders where restaurant_id = p_rid $$;
create function tests.cart(p_slug text, p_spec text[]) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_agg(jsonb_build_object('menu_item_id', m.id, 'qty', split_part(s, ':', 2)::int) order by o)
  from unnest(p_spec) with ordinality u(s, o)
  join public.menu_items m on m.name = split_part(s, ':', 1) and m.restaurant_id = (select id from public.restaurants where slug = p_slug) $$;
create function tests.open_day(p_rid uuid) returns uuid language sql stable security definer set search_path = '' as $$
  select id from public.day_sessions where restaurant_id = p_rid and status = 'open' $$;
-- runs the 4 order RPCs as the CURRENT role; 'all as expected' or the list of outcomes that did not start with the expected prefix
create function tests.order_matrix(p_expect text) returns text language plpgsql as $$
declare
  v_sql text[];
  v_bad text := '';
  v_res text;
  i int;
begin
  v_sql := array[
    format($q$select public.fn_submit_order(%L, 'adv-matrix-0001')$q$, tests.cart('central-cafe', array['Macchiato:1'])),
    format($q$select public.fn_cancel_order(%L)$q$, tests.nv('oa')),
    format($q$select public.fn_set_station_items_status(%L, %L, 'preparing')$q$, tests.nv('oa'), tests.nv('a_bar')),
    format($q$select public.fn_serve_order(%L)$q$, tests.nv('oa'))];
  for i in 1..array_length(v_sql, 1) loop
    v_res := tests.run(v_sql[i]);
    if v_res not like p_expect || '%' then v_bad := v_bad || i || '=' || v_res || '; '; end if;
  end loop;
  return case when v_bad = '' then 'all as expected' else v_bad end;
end $$;
grant execute on all functions in schema tests to public;

insert into _n select 'a_day', (select id::text from public.day_sessions where restaurant_id = (select a from _f) and status = 'open');
insert into _n select 'a_kit', (select id::text from public.stations where restaurant_id = (select a from _f) and name = 'Kitchen');
insert into _n select 'a_bar', (select id::text from public.stations where restaurant_id = (select a from _f) and name = 'Bar');
insert into _n select 'b_kit', (select id::text from public.stations where restaurant_id = (select b from _f) and name = 'Kitchen');

-- fixtures: one order per tenant through the real pipeline
select tests.authenticate_as((select a_waiter from _f));
insert into _n select 'oa', public.fn_submit_order(tests.cart('central-cafe', array['Doro Wat:1', 'Macchiato:1']), 'adv-order-a-0001') ->> 'id';
select tests.clear_auth();
select tests.authenticate_as((select b_waiter from _f));
insert into _n select 'ob', public.fn_submit_order(tests.cart('second-cafe', array['Second Cafe Special:1']), 'adv-order-b-0001') ->> 'id';
select tests.clear_auth();
create temp table _snap on commit drop as select tests.snapshot((select a from _f)) a, tests.snapshot((select b from _f)) b;
grant all on _snap to public;

-- ═════════ anon, internal functions, direct DML ═════════
select tests.as_anon();
select is(tests.order_matrix('42501|permission denied for function'), 'all as expected', 'anon: no EXECUTE on any order RPC');
select tests.clear_auth();
select tests.authenticate_as((select a_admin from _f));
select is(tests.run(format($q$select public.fn_order_create(%L, 'staff', %L, %L, 'adv-bypass-0001')$q$, (select b from _f), (select a_admin from _f), tests.cart('central-cafe', array['Macchiato:1']))),
          '42501|permission denied for function fn_order_create|', 'the internal pipeline (which takes a tenant id) is not client-callable, even for a tenant_admin');
select is(tests.run(format($q$select public.fn_order_json(%L)$q$, tests.nv('ob'))), '42501|permission denied for function fn_order_json|', 'the definer order JSON (bypasses RLS) is not client-callable');
select is(tests.run(format($q$select public.fn_apply_recipe_consumption(%L, %L, 1)$q$, tests.nv('oa'), (select id from public.menu_items where name = 'Doro Wat'))),
          '42501|permission denied for function fn_apply_recipe_consumption|', 'the consumption hook is not client-callable');
select is(tests.run(format($q$insert into public.orders (restaurant_id, day_session_id, order_no, created_by, subtotal, vat_rate_snapshot, vat_amount, total) values (%L, %L, 'ORD-7777', %L, 0, 0, 0, 0)$q$,
          (select a from _f), tests.nv('a_day'), (select a_admin from _f))), '42501|permission denied for table orders|', 'direct INSERT into orders refused (even tenant_admin)');
select is(tests.run(format($q$update public.orders set total = 1, subtotal = 1, vat_amount = 0 where id = %L$q$, tests.nv('oa'))), '42501|permission denied for table orders|', 'direct UPDATE of an order total refused');
select is(tests.run(format($q$update public.orders set status = 'cancelled', cancelled_at = now() where id = %L$q$, tests.nv('oa'))), '42501|permission denied for table orders|', 'direct status change refused');
select is(tests.run(format($q$update public.order_items set item_status = 'ready' where order_id = %L$q$, tests.nv('oa'))), '42501|permission denied for table order_items|', 'direct KDS status change refused');
select is(tests.run(format($q$delete from public.order_items where order_id = %L$q$, tests.nv('oa'))), '42501|permission denied for table order_items|', 'direct DELETE of lines refused');
select is(tests.run(format($q$insert into public.order_items (restaurant_id, order_id, menu_item_id, name_snapshot, price_snapshot, qty, station_id, station_name_snapshot) values (%L, %L, (select id from public.menu_items where name = 'Doro Wat'), 'x', 0, 1, %L, 'Kitchen')$q$,
          (select a from _f), tests.nv('oa'), tests.nv('a_kit'))), '42501|permission denied for table order_items|', 'direct INSERT of a zero-price line refused');
select tests.clear_auth();

-- ═════════ missing permission / escalation ═════════
select tests.authenticate_as((select a_kitchen from _f));
select is(tests.run(format($q$select public.fn_submit_order(%L, 'adv-perm-0001')$q$, tests.cart('central-cafe', array['Macchiato:1']))), 'P0001|permission_denied|', 'station operator: no submit');
select is(tests.run(format($q$select public.fn_cancel_order(%L)$q$, tests.nv('oa'))), 'P0001|permission_denied|', 'station operator without orders.cancel: no cancel, even of an order at its station');
select is(tests.run(format($q$select public.fn_serve_order(%L)$q$, tests.nv('oa'))), 'P0001|permission_denied|', 'station operator: no serve');
select is(tests.run(format($q$select public.fn_set_station_items_status(%L, %L, 'preparing')$q$, tests.nv('oa'), tests.nv('a_bar'))), 'P0001|permission_denied|station', 'station operator: not another station');
select tests.clear_auth();
select tests.authenticate_as((select a_cashier from _f));
select is(tests.run(format($q$select public.fn_cancel_order(%L)$q$, tests.nv('oa'))), 'P0001|permission_denied|', 'cashier (orders.view_all, no orders.cancel): no cancel');
select is(tests.run(format($q$select public.fn_set_station_items_status(%L, %L, 'ready')$q$, tests.nv('oa'), tests.nv('a_kit'))), 'P0001|permission_denied|station', 'cashier: no station, no KDS');
select tests.clear_auth();
-- a forced PIN change removes every permission (fn_pin_restricted)
update public.profile_secrets set must_change_pin = true where profile_id = (select a_waiter from _f);
select tests.authenticate_as((select a_waiter from _f));
select is(tests.order_matrix('P0001|permission_denied'), 'all as expected', 'PIN-restricted waiter (must change PIN): every order RPC permission_denied');
select tests.clear_auth();
update public.profile_secrets set must_change_pin = false where profile_id = (select a_waiter from _f);
update _snap set a = tests.snapshot((select a from _f));   -- (the flag flip touched profile_secrets.updated_at)
-- granting orders.view to a role does not make it able to write orders
select tests.authenticate_as((select a_waiter2 from _f));
select is(tests.oracle($q$select public.fn_cancel_order({id})$q$, tests.nv('oa')), 'P0001|not_found|', 'another waiter cancelling my order = same answer as an unknown id');
select is(tests.oracle($q$select public.fn_serve_order({id})$q$, tests.nv('oa')), 'P0001|not_found|', 'another waiter serving my order = same answer as an unknown id');
select tests.clear_auth();

-- ═════════ IDOR / cross-tenant: real foreign ids vs unknown ids ═════════
select tests.authenticate_as((select b_admin from _f));
select is(tests.oracle($q$select public.fn_cancel_order({id})$q$, tests.nv('oa')), 'P0001|not_found|', 'B admin -> cancel A order: not_found, no oracle');
select is(tests.oracle($q$select public.fn_serve_order({id})$q$, tests.nv('oa')), 'P0001|not_found|', 'B admin -> serve A order: no oracle');
select is(tests.oracle(format($q$select public.fn_set_station_items_status({id}, %L, 'preparing')$q$, tests.nv('b_kit')), tests.nv('oa')), 'P0001|not_found|',
          'B admin -> KDS on A order with its own station: no oracle');
select is(tests.oracle(format($q$select public.fn_set_station_items_status(%L, {id}, 'preparing')$q$, tests.nv('ob')), tests.nv('a_kit')), 'P0001|permission_denied|station',
          'B admin naming A''s station: permission_denied, same as an unknown station');
select is(tests.run(format($q$select public.fn_submit_order(%L, 'adv-idor-0001')$q$, tests.cart('central-cafe', array['Macchiato:1']))), 'P0001|invalid_input|menu_item_id',
          'B admin ordering A''s menu items: refused as unknown');
select is(tests.run(format($q$select public.fn_submit_order(%L, 'adv-order-a-0001')$q$, tests.cart('second-cafe', array['Second Cafe Special:1']))) like 'ok:%', true,
          'B reusing A''s idempotency key value gets its OWN order (keys are tenant-scoped, never A''s result)');
select is((select count(*)::int from public.orders where restaurant_id = (select a from _f)), 0, 'B admin sees no A order');
select tests.clear_auth();
select tests.authenticate_as((select a_admin from _f));
select is(tests.oracle($q$select public.fn_cancel_order({id})$q$, tests.nv('ob')), 'P0001|not_found|', 'A admin -> cancel B order: no oracle');
select is(tests.oracle(format($q$select public.fn_set_station_items_status({id}, %L, 'ready')$q$, tests.nv('a_kit')), tests.nv('ob')), 'P0001|not_found|', 'A admin -> KDS on B order: no oracle');
select is(tests.oracle($q$select public.fn_serve_order({id})$q$, tests.nv('ob')), 'P0001|not_found|', 'A admin -> serve B order: no oracle');
select tests.clear_auth();
select is(tests.snapshot((select a from _f)), (select a from _snap), 'tenant A unchanged by every refused cross-tenant / escalation attempt');

-- ═════════ payment guard ═════════
update public.orders set payment_status = 'paid' where id = tests.nv('oa');
select tests.authenticate_as((select a_waiter from _f));
select is(tests.run(format($q$select public.fn_cancel_order(%L)$q$, tests.nv('oa'))), 'P0001|order_not_cancellable|payment_recorded', 'a paid order cannot be cancelled');
select tests.clear_auth();
update public.orders set payment_status = 'installment' where id = tests.nv('oa');
select tests.authenticate_as((select a_waiter from _f));
select is(tests.run(format($q$select public.fn_cancel_order(%L)$q$, tests.nv('oa'))), 'P0001|order_not_cancellable|payment_recorded', 'an order on an installment voucher cannot be cancelled');
select tests.clear_auth();
update public.orders set payment_status = 'unpaid' where id = tests.nv('oa');

-- ═════════ tenant status ═════════
update public.restaurants set status = 'past_due' where id = (select a from _f);
select tests.authenticate_as((select a_waiter from _f));
select is(tests.order_matrix('P0001|tenant_read_only'), 'all as expected', 'past_due: every order RPC tenant_read_only');
select tests.clear_auth();
select tests.authenticate_as((select a_kitchen from _f));
select is(tests.order_matrix('P0001|tenant_read_only'), 'all as expected', 'past_due: also for a station operator');
select tests.clear_auth();
update public.restaurants set status = 'suspended' where id = (select a from _f);
select tests.authenticate_as((select a_waiter from _f));
select is(tests.order_matrix('P0001|tenant_suspended'), 'all as expected', 'suspended: every order RPC tenant_suspended');
select tests.clear_auth();
update public.restaurants set status = 'active' where id = (select a from _f);
select is(tests.snapshot((select b from _f)) <> (select b from _snap), true, '(B changed only through its own order above)');

-- ═════════ closed business day ═════════
-- order oc: submitted in day 1 with stock consumed; then day 1 closes and day 2 opens
select tests.authenticate_as((select a_waiter from _f));
insert into _n select 'oc', public.fn_submit_order(tests.cart('central-cafe', array['Shiro Wat:1']), 'adv-closed-0001') ->> 'id';
select tests.clear_auth();
update public.day_sessions set status = 'closed', closed_at = now(), closed_by = (select a_admin from _f), order_count = 0, gross_collected = 0, cash_collected = 0,
       cash_expenses = 0, expenses_total = 0, expected_cash = 0, counted_cash = 0, cash_variance = 0, net_profit = 0, inventory_variance = 0,
       station_snapshot = '[]', expense_snapshot = '[]', payment_snapshot = '[]'
where id = tests.nv('a_day');
create temp table _cnt on commit drop as select tests.n_movs((select a from _f)) m, tests.n_orders((select a from _f)) o;
grant all on _cnt to public;
select tests.authenticate_as((select a_waiter from _f));
select is(tests.run(format($q$select public.fn_submit_order(%L, 'adv-closed-0002')$q$, tests.cart('central-cafe', array['Macchiato:1']))), 'P0001|day_closed|no open business day', 'no open day: submit refused');
select is((public.fn_submit_order(tests.cart('central-cafe', array['Shiro Wat:1']), 'adv-closed-0001') ->> 'replayed'), 'true',
          'a retry of an order that was accepted BEFORE the close still returns it (idempotency is checked before the day)');
select is(tests.run(format($q$select public.fn_cancel_order(%L)$q$, tests.nv('oc'))), 'P0001|day_closed|order business day is closed', 'cancel of a closed-day order: day_closed (stock figures of a closed day are final)');
select is(tests.run(format($q$select public.fn_serve_order(%L)$q$, tests.nv('oc'))), 'P0001|day_closed|order business day is closed', 'serve on a closed day: day_closed');
select tests.clear_auth();
select tests.authenticate_as((select a_kitchen from _f));
select is(tests.run(format($q$select public.fn_set_station_items_status(%L, %L, 'preparing')$q$, tests.nv('oc'), tests.nv('a_kit'))), 'P0001|day_closed|order business day is closed', 'KDS on a closed day: day_closed');
select tests.clear_auth();
select is(tests.n_movs((select a from _f)) || '|' || tests.n_orders((select a from _f)), (select m || '|' || o from _cnt), 'closed day: no order and no stock movement written');
insert into public.day_sessions (restaurant_id, day_no, status, opened_by) select a, 2, 'open', a_admin from _f;
select tests.authenticate_as((select a_waiter from _f));
select is(tests.run(format($q$select public.fn_cancel_order(%L)$q$, tests.nv('oc'))), 'P0001|day_closed|order business day is closed',
          'a NEW day is open: cancelling an order of the EARLIER closed day is still refused (no silent stock rewrite of a closed day)');
select is((public.fn_submit_order(tests.cart('central-cafe', array['Macchiato:1']), 'adv-closed-0003') ->> 'day_session_id')::uuid,
          tests.open_day((select a from _f)), 'new orders go to the new day');
select tests.clear_auth();
select is((select status from public.orders where id = tests.nv('oc')), 'submitted', 'the closed-day order is unchanged');
select is((select count(*)::int from public.stock_movements where order_id = tests.nv('oc') and reason = 'reversal'), 0, 'and its consumption was not reversed');

-- ═════════ validation edge cases that must not reach a lock ═════════
select tests.authenticate_as((select a_waiter from _f));
select is(tests.run($q$select public.fn_cancel_order(null)$q$), 'P0001|invalid_input|order_id', 'cancel: null id');
select is(tests.run($q$select public.fn_serve_order(null)$q$), 'P0001|invalid_input|order_id', 'serve: null id');
select is(tests.run(format($q$select public.fn_set_station_items_status(null, %L, 'ready')$q$, tests.nv('a_kit'))), 'P0001|invalid_input|order_id', 'station: null order id');
select is(tests.run(format($q$select public.fn_set_station_items_status(%L, null, 'ready')$q$, tests.nv('oa'))), 'P0001|permission_denied|station', 'station: null station = no access');
select is(tests.run(format($q$select public.fn_set_station_items_status(%L, %L, null)$q$, tests.nv('oa'), tests.nv('a_kit'))), 'P0001|invalid_input|status', 'station: null status');
select is(tests.run(format($q$select public.fn_submit_order(%L, 'adv-val-0001', null)$q$, tests.cart('central-cafe', array['Macchiato:1']))), 'P0001|invalid_input|order_type', 'submit: null order type');
select is(tests.run(format($q$select public.fn_submit_order('[{"menu_item_id": "%s", "qty": 1}, 5]', 'adv-val-0002')$q$, (select id from public.menu_items where name = 'Macchiato'))), 'P0001|invalid_input|items', 'submit: a non-object line');
select is(tests.run(format($q$select public.fn_submit_order('[{"menu_item_id": "%s", "qty": 1e400}]', 'adv-val-0003')$q$, (select id from public.menu_items where name = 'Macchiato'))), 'P0001|invalid_input|qty', 'submit: absurd qty');
select is(tests.run(format($q$select public.fn_submit_order('[{"menu_item_id": "%s", "qty": -1}]', 'adv-val-0004')$q$, (select id from public.menu_items where name = 'Macchiato'))), 'P0001|invalid_input|qty', 'submit: negative qty');
select is(tests.run(format($q$select public.fn_submit_order('[{"menu_item_id": "%s"}]', 'adv-val-0005')$q$, (select id from public.menu_items where name = 'Macchiato'))), 'P0001|invalid_input|qty', 'submit: missing qty');
select is(tests.run(format($q$select public.fn_submit_order('[{"menu_item_id": "%s", "qty": 1}]', %L)$q$, (select id from public.menu_items where name = 'Macchiato'), repeat('k', 129))), 'P0001|invalid_input|idempotency_key', 'submit: key > 128');
select tests.clear_auth();

-- orders and their lines are never deleted (Realtime DELETE events bypass RLS): no client privilege, no definer body deletes them
select is((select string_agg(p.proname, ',' order by p.proname) from pg_proc p where p.pronamespace = 'public'::regnamespace
           and p.prosrc ~* 'delete\s+from\s+public\.(orders|order_items)\M'), null, 'no function deletes orders or order lines');
select * from finish();
rollback;
