-- Phase 6 (migration 0034): payments. fn_confirm_payment (full payment, server amount, receipt numbers, method snapshots, reference
-- rules, tendered / change, idempotency, open day, order state), fn_reverse_payment (compensating row, step-up, once only),
-- fn_get_receipt, RLS reads, cross-tenant / IDOR, audit. Gate: the complete order-to-payment flow.
begin;
select plan(46);

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
create function tests.cart(p_spec text[]) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_agg(jsonb_build_object('menu_item_id', m.id, 'qty', split_part(s, ':', 2)::int) order by o)
  from unnest(p_spec) with ordinality u(s, o)
  join public.menu_items m on m.name = split_part(s, ':', 1)
   and m.restaurant_id = (select id from public.restaurants where slug = 'central-cafe') $$;
create function tests.pay_status(p_order uuid) returns text language sql stable security definer set search_path = '' as $$
  select payment_status from public.orders where id = p_order $$;
create function tests.n_pay(p_order uuid) returns int language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.payments where order_id = p_order $$;
create function tests.ev(p_rid uuid, p_event text) returns int language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.audit_logs a where a.restaurant_id = p_rid and a.event = p_event $$;
grant execute on all functions in schema tests to public;

insert into _n select 'cash', tests.pm((select a from _f), 'Cash');
insert into _n select 'tele', tests.pm((select a from _f), 'Telebirr');
insert into _n select 'b_cash', tests.pm((select b from _f), 'Cash');

-- two orders by the waiter
select tests.authenticate_as((select a_waiter from _f));
insert into _n select 'o1', public.fn_submit_order(tests.cart(array['Macchiato:2']), 'pay-order-0001') ->> 'id';
insert into _n select 'o2', public.fn_submit_order(tests.cart(array['Macchiato:1']), 'pay-order-0002') ->> 'id';
insert into _n select 'o3', public.fn_submit_order(tests.cart(array['Macchiato:1']), 'pay-order-0003') ->> 'id';
select is(tests.run(format($q$select public.fn_confirm_payment(%L, %L, null, 'pay-key-waiter-01')$q$, tests.nv('o1'), tests.nv('cash'))),
          'P0001|permission_denied|', 'a waiter cannot take payments');
select tests.clear_auth();

-- ═════════ structure ═════════
select is((select count(*)::int from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosecdef and p.proconfig @> array['search_path=""']
           and p.proname in ('fn_receipt_json','fn_confirm_payment','fn_reverse_payment','fn_get_receipt')), 4, 'all four: security definer, empty search_path');
select ok(not has_function_privilege('authenticated', 'public.fn_receipt_json(uuid)', 'execute'), 'the receipt builder is internal');
select tests.authenticate_as((select a_admin from _f));
select is(tests.run($q$insert into public.payments (restaurant_id, day_session_id, kind, amount, payment_method_id, method_name_snapshot, method_affects_drawer_snapshot, receipt_no) values (gen_random_uuid(), gen_random_uuid(), 'order_payment', 1, gen_random_uuid(), 'x', true, 'RCT-9999')$q$),
          '42501|permission denied for table payments|', 'no client INSERT on payments (RPC only)');
select tests.clear_auth();

-- ═════════ confirm ═════════
select tests.authenticate_as((select a_cashier from _f));
select is(tests.run(format($q$select public.fn_confirm_payment(%L, %L, null, 'short')$q$, tests.nv('o1'), tests.nv('cash'))), 'P0001|invalid_input|idempotency_key', 'idempotency key is required');
select is(tests.run(format($q$select public.fn_confirm_payment(%L, %L, null, 'pay-key-tele-0001')$q$, tests.nv('o1'), tests.nv('tele'))), 'P0001|invalid_input|reference',
          'a method that requires a reference refuses an empty one');
select is(tests.run(format($q$select public.fn_confirm_payment(%L, %L, 'TX1', 'pay-key-tele-0002', 1000)$q$, tests.nv('o1'), tests.nv('tele'))), 'P0001|invalid_input|tendered',
          'tendered cash only with a cash-drawer method');
select is(tests.run(format($q$select public.fn_confirm_payment(%L, %L, null, 'pay-key-cash-0001', 1)$q$, tests.nv('o1'), tests.nv('cash'))), 'P0001|insufficient_tendered|',
          'tendered below the total is refused');
select is(tests.run(format($q$select public.fn_confirm_payment(%L, %L, null, 'pay-key-bcash-001')$q$, tests.nv('o1'), tests.nv('b_cash'))), 'P0001|invalid_input|payment_method_id',
          'another tenant''s payment method = unknown method');
select is(tests.run(format($q$select public.fn_confirm_payment(gen_random_uuid(), %L, null, 'pay-key-unknown01')$q$, tests.nv('cash'))), 'P0001|not_found|', 'unknown order');
insert into _n select 'r1', public.fn_confirm_payment(tests.nv('o1'), tests.nv('cash'), null, 'pay-key-cash-0002', 500)::text;
select is((tests.jv('r1') ->> 'amount')::numeric, (select total from public.orders where id = tests.nv('o1')), 'amount = the order total (server-side)');
select ok((tests.jv('r1') ->> 'receipt_no') ~ '^RCT-[0-9]{4,}$', 'receipt number issued');
select is((tests.jv('r1') ->> 'change')::numeric, 500 - (select total from public.orders where id = tests.nv('o1')), 'change = tendered - total');
select is(tests.jv('r1') ->> 'method', 'Cash', 'method name snapshot on the receipt');
select is(jsonb_array_length(tests.jv('r1') -> 'order' -> 'items'), 1, 'receipt lists the order lines');
select is(tests.jv('r1') -> 'restaurant' ->> 'name', (select name from public.restaurants where id = (select a from _f)), 'restaurant identity on the receipt');
select is(tests.pay_status(tests.nv('o1')), 'paid', 'order is paid');
select is((select public.fn_confirm_payment(tests.nv('o1'), tests.nv('cash'), null, 'pay-key-cash-0002', 500) ->> 'replayed'), 'true',
          'replay of the same key returns the same receipt');
select is(tests.n_pay(tests.nv('o1')), 1, 'and creates no second payment');
select is(tests.run(format($q$select public.fn_confirm_payment(%L, %L, null, 'pay-key-cash-0003')$q$, tests.nv('o1'), tests.nv('cash'))), 'P0001|order_not_payable|paid',
          'a paid order cannot be paid again with a new key');
select is(tests.run(format($q$select public.fn_confirm_payment(%L, %L, 'TX', 'pay-key-cash-0002', 500)$q$, tests.nv('o1'), tests.nv('cash'))), 'P0001|idempotency_conflict|',
          'the same key with a different payload is a conflict');
insert into _n select 'r2', public.fn_confirm_payment(tests.nv('o2'), tests.nv('tele'), ' TX-778899 ', 'pay-key-tele-0003')::text;
select is(tests.jv('r2') ->> 'reference', 'TX-778899', 'reference trimmed and kept');
select ok((tests.jv('r2') ->> 'receipt_no') <> (tests.jv('r1') ->> 'receipt_no'), 'receipt numbers are unique');
select is((select method_affects_drawer_snapshot from public.payments where id = (tests.jv('r2') ->> 'payment_id')::uuid), false, 'drawer flag snapshotted');
select tests.clear_auth();

-- cancelled order
select tests.authenticate_as((select a_admin from _f));
select lives_ok(format($q$select public.fn_cancel_order(%L, 'customer left')$q$, tests.nv('o3')), 'cancel an unpaid order');
select is(tests.run(format($q$select public.fn_confirm_payment(%L, %L, null, 'pay-key-cancel-01')$q$, tests.nv('o3'), tests.nv('cash'))), 'P0001|order_not_payable|cancelled',
          'a cancelled order cannot be paid');
select is(tests.run(format($q$select public.fn_cancel_order(%L, 'nope')$q$, tests.nv('o2'))), 'P0001|order_not_cancellable|payment_recorded', 'a paid order cannot be cancelled');
select tests.clear_auth();

-- ═════════ receipts and reads ═════════
select tests.authenticate_as((select a_cashier from _f));
select is((select public.fn_get_receipt((tests.jv('r1') ->> 'payment_id')::uuid) ->> 'receipt_no'), tests.jv('r1') ->> 'receipt_no', 'receipt re-read');
select tests.clear_auth();
select tests.authenticate_as((select a_waiter from _f));
select is(tests.run(format($q$select public.fn_get_receipt(%L)$q$, tests.jv('r1') ->> 'payment_id')), 'P0001|permission_denied|', 'a waiter cannot read receipts');
select is((select count(*)::int from public.payments), 0, 'nor payments (RLS)');
select tests.clear_auth();
select tests.aal2((select b_admin from _f));
select is(tests.run(format($q$select public.fn_get_receipt(%L)$q$, tests.jv('r1') ->> 'payment_id')), 'P0001|not_found|', 'another tenant: not_found');
select is((select count(*)::int from public.payments where order_id = tests.nv('o1')), 0, 'another tenant reads none of A''s payments');
select is(tests.run(format($q$select public.fn_confirm_payment(%L, %L, null, 'pay-key-b-000001')$q$, tests.nv('o2'), tests.nv('b_cash'))), 'P0001|not_found|',
          'another tenant cannot pay A''s order');
select is(tests.run(format($q$select public.fn_reverse_payment(%L, 'mistake', 'rev-key-b-000001')$q$, tests.jv('r1') ->> 'payment_id')), 'P0001|not_found|',
          'nor reverse A''s payment');
select tests.clear_auth();

-- ═════════ reverse ═════════
select tests.authenticate_as((select a_cashier from _f));
select is(tests.run(format($q$select public.fn_reverse_payment(%L, 'mistake', 'rev-key-cash-001')$q$, tests.jv('r1') ->> 'payment_id')), 'P0001|permission_denied|',
          'reversal needs payments.reverse');
select tests.clear_auth();
select tests.aal2((select a_admin from _f));
select is(tests.run(format($q$select public.fn_reverse_payment(%L, 'x', 'rev-key-adm-0001')$q$, tests.jv('r1') ->> 'payment_id')), 'P0001|invalid_input|reason', 'a reason is required');
insert into _n select 'rev', public.fn_reverse_payment((tests.jv('r1') ->> 'payment_id')::uuid, 'wrong order paid', 'rev-key-adm-0002')::text;
select is(tests.jv('rev') ->> 'kind', 'reversal', 'a compensating reversal row');
select is((tests.jv('rev') ->> 'amount')::numeric, (tests.jv('r1') ->> 'amount')::numeric, 'same amount');
select is(tests.pay_status(tests.nv('o1')), 'unpaid', 'the order is unpaid again');
select is((select count(*)::int from public.payments where id = (tests.jv('r1') ->> 'payment_id')::uuid and kind = 'order_payment'), 1, 'the original payment is untouched');
select is(tests.run(format($q$select public.fn_reverse_payment(%L, 'again please', 'rev-key-adm-0003')$q$, tests.jv('r1') ->> 'payment_id')), 'P0001|invalid_state|already_reversed',
          'a payment is reversed at most once');
select is(tests.run(format($q$select public.fn_reverse_payment(%L, 'reverse a reversal', 'rev-key-adm-0004')$q$, tests.jv('rev') ->> 'payment_id')), 'P0001|invalid_state|not_an_order_payment',
          'a reversal cannot be reversed');
select is((select public.fn_confirm_payment(tests.nv('o1'), tests.nv('tele'), 'TX-2', 'pay-key-repay-01') ->> 'kind'), 'order_payment', 'the order can be paid again after a reversal');
select tests.clear_auth();

-- ═════════ audit + gate ═════════
select is(tests.ev((select a from _f), 'payment.confirmed'), 3, 'three confirmations audited (o1, o2, o1 again)');
select is(tests.ev((select a from _f), 'payment.reversed'), 1, 'one reversal audited');
select is((select string_agg(kind || ':' || amount::text, ',' order by created_at, receipt_no) from public.payments where order_id = tests.nv('o1')),
          (select format('order_payment:%s,reversal:%s,order_payment:%s', total, total, total) from public.orders where id = tests.nv('o1')),
          'gate: the full order-to-payment history of o1 is consistent');

select * from finish();
rollback;
