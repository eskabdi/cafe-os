-- Phase 7 (migration 0035): installments. fn_generate_voucher (server schedule, down payment, order -> installment), fn_confirm_installment
-- (next installment only, server amount, double payment / overpayment / settled / invalid number), computed status, fn_get_voucher /
-- fn_list_vouchers, receipts with the voucher block, cross-tenant / IDOR, audit. Gate: the installment lifecycle.
begin;
select plan(57);

create temp table _f on commit drop as
select tests.tenant_id('central-cafe') a, tests.tenant_id('second-cafe') b,
       tests.user_id('selam', 'central-cafe') a_admin, tests.user_id('yonas', 'central-cafe') a_waiter,
       tests.user_id('hanna', 'central-cafe') a_cashier, tests.user_id('owner', 'second-cafe') b_admin,
       tests.user_id('meron', 'central-cafe') a_waiter2;
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
create function tests.order_total(p_order uuid) returns numeric language sql stable security definer set search_path = '' as $$
  select total from public.orders where id = p_order $$;
create function tests.pay_status(p_order uuid) returns text language sql stable security definer set search_path = '' as $$
  select payment_status from public.orders where id = p_order $$;
create function tests.inst(p_voucher uuid) returns text language sql stable security definer set search_path = '' as $$
  select string_agg(no || ':' || amount || ':' || paid, ',' order by no) from public.installments where voucher_id = p_voucher $$;
create function tests.ev(p_rid uuid, p_event text) returns int language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.audit_logs a where a.restaurant_id = p_rid and a.event = p_event $$;
create function tests.today(p_rid uuid) returns date language sql stable security definer set search_path = '' as $$
  select public.fn_tenant_today(p_rid) $$;
grant execute on all functions in schema tests to public;

insert into _n select 'cash', tests.pm((select a from _f), 'Cash');
insert into _n select 'tele', tests.pm((select a from _f), 'Telebirr');
insert into _n select 'b_cash', tests.pm((select b from _f), 'Cash');

select tests.authenticate_as((select a_waiter from _f));
insert into _n select 'o1', public.fn_submit_order(tests.cart(array['Macchiato:4']), 'inst-order-0001') ->> 'id';
insert into _n select 'o2', public.fn_submit_order(tests.cart(array['Macchiato:1']), 'inst-order-0002') ->> 'id';
insert into _n select 'o3', public.fn_submit_order(tests.cart(array['Macchiato:1']), 'inst-order-0003') ->> 'id';
select is(tests.run(format($q$select public.fn_generate_voucher(%L, 'Abebe Kebede', null, 0, null, null, 3, 7, 'inst-key-waiter-01')$q$, tests.nv('o1'))),
          'P0001|permission_denied|', 'a waiter cannot issue vouchers');
select tests.clear_auth();

-- ═════════ structure ═════════
select is((select count(*)::int from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosecdef and p.proconfig @> array['search_path=""']
           and p.proname in ('fn_tenant_today','fn_voucher_json','fn_generate_voucher','fn_confirm_installment','fn_get_voucher','fn_list_vouchers')), 6,
          'all six: security definer, empty search_path');
select ok(not has_function_privilege('authenticated', 'public.fn_voucher_json(uuid)', 'execute')
          and not has_function_privilege('authenticated', 'public.fn_tenant_today(uuid)', 'execute'), 'the builders are internal');
select tests.authenticate_as((select a_admin from _f));
select is(tests.run($q$insert into public.vouchers (restaurant_id, voucher_no, order_id, customer_name, total, installment_count, interval_days) values (gen_random_uuid(), 'VCH-9999', gen_random_uuid(), 'x', 1, 1, 7)$q$),
          '42501|permission denied for table vouchers|', 'no client INSERT on vouchers (RPC only)');
select is(tests.run($q$update public.installments set paid = true$q$), '42501|permission denied for table installments|', 'no client UPDATE on installments');
select tests.clear_auth();

-- ═════════ generate ═════════
select tests.authenticate_as((select a_cashier from _f));
select is(tests.run(format($q$select public.fn_generate_voucher(%L, '', null, 0, null, null, 3, 7, 'inst-key-name-0001')$q$, tests.nv('o1'))),
          'P0001|invalid_input|customer_name', 'a customer name is required');
select is(tests.run(format($q$select public.fn_generate_voucher(%L, 'Abebe Kebede', 'call me <b>', 0, null, null, 3, 7, 'inst-key-phone-001')$q$, tests.nv('o1'))),
          'P0001|invalid_input|customer_phone', 'phone: digits, spaces, + ( ) - only');
select is(tests.run(format($q$select public.fn_generate_voucher(%L, 'Abebe Kebede', null, %s, %L, null, 3, 7, 'inst-key-down-0001')$q$, tests.nv('o1'), tests.order_total(tests.nv('o1')), tests.nv('cash'))),
          'P0001|invalid_input|down_payment', 'down payment must be below the total');
select is(tests.run(format($q$select public.fn_generate_voucher(%L, 'Abebe Kebede', null, -1, null, null, 3, 7, 'inst-key-down-0002')$q$, tests.nv('o1'))),
          'P0001|invalid_input|down_payment', 'no negative down payment');
select is(tests.run(format($q$select public.fn_generate_voucher(%L, 'Abebe Kebede', null, 10, null, null, 3, 7, 'inst-key-down-0003')$q$, tests.nv('o1'))),
          'P0001|invalid_input|down_method_id', 'a down payment needs a method');
select is(tests.run(format($q$select public.fn_generate_voucher(%L, 'Abebe Kebede', null, 10, %L, null, 3, 7, 'inst-key-down-0004')$q$, tests.nv('o1'), tests.nv('tele'))),
          'P0001|invalid_input|reference', 'the down method''s reference rule applies');
select is(tests.run(format($q$select public.fn_generate_voucher(%L, 'Abebe Kebede', null, 0, null, null, 61, 7, 'inst-key-count-001')$q$, tests.nv('o1'))),
          'P0001|invalid_input|installment_count', 'at most 60 installments');
select is(tests.run(format($q$select public.fn_generate_voucher(%L, 'Abebe Kebede', null, 10, %L, null, 3, 7, 'inst-key-xten-0001')$q$, tests.nv('o1'), tests.nv('b_cash'))),
          'P0001|invalid_input|down_method_id', 'another tenant''s payment method is refused');

insert into _n select 'v1', public.fn_generate_voucher(tests.nv('o1'), 'Abebe Kebede Alemu', '+251 911 000000', 10, tests.nv('cash'), null, 3, 7, 'inst-key-gen-00001')::text;
select is(tests.jv('v1') -> 'voucher' ->> 'status', 'active', 'issued: active');
select ok(tests.jv('v1') -> 'voucher' ->> 'voucher_no' ~ '^VCH-[0-9]{4,}$', 'VCH number');
select is((tests.jv('v1') -> 'voucher' ->> 'total')::numeric, tests.order_total(tests.nv('o1')), 'voucher total = server order total');
select is((tests.jv('v1') -> 'voucher' ->> 'outstanding')::numeric, tests.order_total(tests.nv('o1')) - 10, 'outstanding = total - down');
select is((select sum(amount) from public.installments where voucher_id = (tests.jv('v1') -> 'voucher' ->> 'id')::uuid),
          tests.order_total(tests.nv('o1')) - 10, 'the schedule sums to the balance exactly');
select is((select string_agg(amount::text, ',' order by no) from public.installments where voucher_id = (tests.jv('v1') -> 'voucher' ->> 'id')::uuid),
          (select format('%s,%s,%s', ceil((t - 10) / 3)::numeric(12,2), ceil((t - 10) / 3)::numeric(12,2), ((t - 10) - 2 * ceil((t - 10) / 3))::numeric(12,2)) from (select tests.order_total(tests.nv('o1')) t) x),
          'ceil whole birr per installment, the remainder in the last');
select is((select string_agg((due_date - tests.today((select a from _f)))::text, ',' order by no) from public.installments
           where voucher_id = (tests.jv('v1') -> 'voucher' ->> 'id')::uuid), '7,14,21', 'due every 7 days from the tenant''s today');
select is(tests.pay_status(tests.nv('o1')), 'installment', 'order -> installment');
select is(tests.jv('v1') -> 'down_receipt' ->> 'kind', 'down_payment', 'down payment receipt');
select is(tests.jv('v1') -> 'down_receipt' -> 'voucher' ->> 'voucher_no', tests.jv('v1') -> 'voucher' ->> 'voucher_no', 'the receipt names the voucher');
select is((public.fn_generate_voucher(tests.nv('o1'), 'Abebe Kebede Alemu', '+251 911 000000', 10, tests.nv('cash'), null, 3, 7, 'inst-key-gen-00001') ->> 'replayed'),
          'true', 'replay: same voucher');
select is(tests.run(format($q$select public.fn_generate_voucher(%L, 'Someone Else', null, 0, null, null, 2, 7, 'inst-key-gen-00002')$q$, tests.nv('o1'))),
          'P0001|order_not_payable|installment', 'an order already on a voucher cannot get a second one');
select is(tests.run(format($q$select public.fn_confirm_payment(%L, %L, null, 'inst-key-pay-00001')$q$, tests.nv('o1'), tests.nv('cash'))),
          'P0001|order_not_payable|installment', 'nor be paid in full at the cashier');
-- tiny balance: ceil would leave the last installment at 0, so the even split to the cent is used
insert into _n select 'v2', public.fn_generate_voucher(tests.nv('o2'), 'Sara Tadesse', null, tests.order_total(tests.nv('o2')) - 5, tests.nv('cash'), null, 6, 14, 'inst-key-gen-00003')::text;
select is((select count(*)::int from public.installments where voucher_id = (tests.jv('v2') -> 'voucher' ->> 'id')::uuid and amount > 0), 6,
          'balance 5 over 6 installments: every installment is positive');
select is((select sum(amount) from public.installments where voucher_id = (tests.jv('v2') -> 'voucher' ->> 'id')::uuid), 5.00, 'and they sum to 5');

-- ═════════ collect ═════════
insert into _n select 'v1id', tests.jv('v1') -> 'voucher' ->> 'id';
select is(tests.run(format($q$select public.fn_confirm_installment(%L, %L, null, 'inst-key-col-0000', 2)$q$, tests.nv('v1id'), tests.nv('cash'))),
          'P0001|invalid_installment_no|1', 'only the next installment can be collected');
select is(tests.run(format($q$select public.fn_confirm_installment(%L, %L, null, 'inst-key-col-0009', null, 1)$q$, tests.nv('v1id'), tests.nv('cash'))),
          'P0001|insufficient_tendered|', 'tendered below the installment is refused');
insert into _n select 'c1', public.fn_confirm_installment(tests.nv('v1id'), tests.nv('cash'), null, 'inst-key-col-0001', 1, 1000)::text;
select is((tests.jv('c1') ->> 'amount')::numeric, (select amount from public.installments where voucher_id = tests.nv('v1id') and no = 1), 'amount = the scheduled installment');
select is((tests.jv('c1') -> 'voucher' ->> 'installment_no')::int, 1, 'receipt: installment 1');
select is((tests.jv('c1') ->> 'change')::numeric, 1000 - (tests.jv('c1') ->> 'amount')::numeric, 'change');
select is((public.fn_confirm_installment(tests.nv('v1id'), tests.nv('cash'), null, 'inst-key-col-0001', 1, 1000) ->> 'replayed'), 'true',
          'double submit with the same key: same receipt, no second payment');
select is((select count(*)::int from public.payments where voucher_id = tests.nv('v1id') and kind = 'installment_payment'), 1, 'one installment payment');
select is(tests.run(format($q$select public.fn_confirm_installment(%L, %L, null, 'inst-key-col-0002', 1)$q$, tests.nv('v1id'), tests.nv('cash'))),
          'P0001|invalid_installment_no|2', 'a new key for an already-paid installment number is refused (double payment)');
select lives_ok(format($q$select public.fn_confirm_installment(%L, %L, 'TB-1', 'inst-key-col-0003')$q$, tests.nv('v1id'), tests.nv('tele')), 'installment 2 (next by default)');
select lives_ok(format($q$select public.fn_confirm_installment(%L, %L, null, 'inst-key-col-0004', 3)$q$, tests.nv('v1id'), tests.nv('cash')), 'installment 3');
select is(public.fn_get_voucher(tests.nv('v1id')) ->> 'status', 'settled', 'settled after the last installment');
select is((public.fn_get_voucher(tests.nv('v1id')) ->> 'outstanding')::numeric, 0::numeric, 'nothing outstanding');
select is(tests.run(format($q$select public.fn_confirm_installment(%L, %L, null, 'inst-key-col-0005')$q$, tests.nv('v1id'), tests.nv('cash'))),
          'P0001|voucher_already_settled|', 'a settled voucher takes no more payment (overpayment)');
select tests.clear_auth();

-- ═════════ overdue (computed) ═════════
update public.installments set due_date = tests.today((select a from _f)) - 1 where voucher_id = (tests.jv('v2') -> 'voucher' ->> 'id')::uuid and no = 1;
select tests.authenticate_as((select a_cashier from _f));
select is(public.fn_get_voucher((tests.jv('v2') -> 'voucher' ->> 'id')::uuid) ->> 'status', 'overdue', 'an unpaid installment past due: overdue');
select is((select jsonb_agg(j ->> 'voucher_no') from jsonb_array_elements(public.fn_list_vouchers('overdue')) j),
          jsonb_build_array(tests.jv('v2') -> 'voucher' ->> 'voucher_no'), 'list filtered by computed status');
select tests.clear_auth();

-- ═════════ cross-tenant / IDOR ═════════
select tests.authenticate_as((select b_admin from _f));
select is(tests.oracle($q$select public.fn_get_voucher({id})$q$, tests.nv('v1id')), 'P0001|not_found|', 'another tenant: not_found, same as an unknown id');
select is(tests.run(format($q$select public.fn_confirm_installment(%L, %L, null, 'inst-key-xten-0002')$q$, (tests.jv('v2') -> 'voucher' ->> 'id'), tests.nv('b_cash'))),
          'P0001|not_found|', 'another tenant cannot collect');
select is(tests.run(format($q$select public.fn_generate_voucher(%L, 'X Y', null, 0, null, null, 2, 7, 'inst-key-xten-0003')$q$, tests.nv('o3'))),
          'P0001|not_found|', 'another tenant cannot issue a voucher on our order');
select is((select count(*)::int from public.vouchers), 0, 'RLS: no foreign vouchers visible');
select tests.clear_auth();

-- ═════════ review: order visibility (a role without orders.view_all) ═════════
select tests.authenticate_as((select a_waiter2 from _f));
insert into _n select 'om', public.fn_submit_order(tests.cart(array['Macchiato:1']), 'inst-order-meron1') ->> 'id';
insert into _n select 'om2', public.fn_submit_order(tests.cart(array['Macchiato:1']), 'inst-order-meron2') ->> 'id';
select tests.clear_auth();
select tests.authenticate_as((select a_cashier from _f));
insert into _n select 'vm', public.fn_generate_voucher(tests.nv('om2'), 'Meron Guest Customer', null, 0, null, null, 2, 7, 'inst-key-gen-00020')::text;
select tests.clear_auth();
insert into public.role_permissions (role_id, permission_id, restaurant_id)
  select p.role_id, pm.id, p.restaurant_id from public.profiles p, public.permissions pm where p.id = (select a_waiter from _f) and pm.key = 'vouchers.manage';
select tests.authenticate_as((select a_waiter from _f));
select is(tests.oracle($q$select public.fn_generate_voucher({id}, 'X Y Z', null, 0, null, null, 2, 7, 'inst-key-vis-0001')$q$, tests.nv('om')),
          'P0001|not_found|', 'a voucher on an order the caller cannot see: not_found (same as an unknown id)');
select is(tests.run(format($q$select public.fn_confirm_installment(%L, %L, null, 'inst-key-vis-0002')$q$, (tests.jv('vm') -> 'voucher' ->> 'id'), tests.nv('cash'))),
          'P0001|not_found|', 'collecting on a voucher whose order the caller cannot see: not_found');
select tests.clear_auth();

-- ═════════ review: collection after the voucher's business day closed (0019 allowlist path, through the RPC) ═════════
select tests.authenticate_as((select a_cashier from _f));
insert into _n select 'v3', public.fn_generate_voucher(tests.nv('o3'), 'Tigist Haile Bekele', null, 0, null, null, 2, 7, 'inst-key-gen-00010')::text;
select tests.clear_auth();
update public.day_sessions set status = 'closed', closed_at = now(), closed_by = (select a_admin from _f), order_count = 0, gross_collected = 0, cash_collected = 0,
       cash_expenses = 0, expenses_total = 0, expected_cash = 0, counted_cash = 0, cash_variance = 0, net_profit = 0, inventory_variance = 0,
       station_snapshot = '[]', expense_snapshot = '[]', payment_snapshot = '[]'
where restaurant_id = (select a from _f) and status = 'open';
insert into public.day_sessions (restaurant_id, day_no, opened_by) select a, 99, a_admin from _f;
select tests.authenticate_as((select a_cashier from _f));
insert into _n select 'c3', public.fn_confirm_installment((tests.jv('v3') -> 'voucher' ->> 'id')::uuid, tests.nv('cash'), null, 'inst-key-col-0100')::text;
select is((select d.day_no from public.payments p join public.day_sessions d on d.id = p.day_session_id where p.id = (tests.jv('c3') ->> 'payment_id')::uuid), 99,
          'an installment of a closed-day voucher is collected into the NEW day');
select is(tests.run(format($q$select public.fn_generate_voucher(%L, 'X Y Z', null, 0, null, null, 2, 7, 'inst-key-gen-00011')$q$, tests.nv('om'))),
          'P0001|day_closed|order business day is closed', 'no voucher for an order of a closed day');
select tests.clear_auth();
select is(tests.run(format($q$update public.installments set paid = false, paid_at = null, payment_id = null where voucher_id = %L and no = 1$q$, tests.jv('v3') -> 'voucher' ->> 'id')),
          'P0001|day_closed|', 'a collected installment of a closed-day voucher cannot be un-paid (frozen)');
select is((tests.jv('c3') -> 'voucher' ->> 'outstanding')::numeric,
          (select sum(amount) from public.installments where voucher_id = (tests.jv('v3') -> 'voucher' ->> 'id')::uuid and no = 2),
          'receipt balance = the installments after this one');

-- ═════════ audit ═════════
select is(tests.ev((select a from _f), 'voucher.issued'), 4, 'audit: voucher.issued x4 (the replay wrote none)');
select is(tests.ev((select a from _f), 'installment.collected'), 4, 'audit: installment.collected x4');

-- ═════════ security review follow-ups ═════════
select is((select count(*)::int from public.audit_logs where new_data ? 'customer_phone' or old_data ? 'customer_phone'), 0,
          'the customer''s phone never reaches the immutable audit log');
select ok(exists (select 1 from pg_indexes where indexname = 'payments_one_installment_payment_idx')
          and exists (select 1 from pg_indexes where indexname = 'payments_one_down_payment_idx'), 'DB backstops: one payment per installment / down payment');

select * from finish();
rollback;
