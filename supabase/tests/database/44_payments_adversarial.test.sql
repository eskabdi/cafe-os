-- Phase 6 (migration 0034) adversarial supplement to 42_payments.test.sql.
-- fn_confirm_payment / fn_reverse_payment / fn_get_receipt x {anon, platform admin, foreign tenant, missing permission, custom roles,
-- past_due, suspended}; IDOR with real foreign vs unknown ids (no existence oracle) in both tenant directions; payments.create-only
-- reading someone else's receipt; payments / audit / idempotency rows not writable by any client role (tenant_admin included);
-- audit integrity (exactly one row per confirm / reverse, none on a replay or a refused attempt, actor = caller, never forgeable);
-- idempotency keys reused across users, across tenants and across commands.
begin;
select plan(82);

create temp table _f on commit drop as
select tests.tenant_id('central-cafe') a, tests.tenant_id('second-cafe') b,
       tests.user_id('selam', 'central-cafe') a_admin, tests.user_id('yonas', 'central-cafe') a_waiter,
       tests.user_id('hanna', 'central-cafe') a_cashier, tests.user_id('abebe', 'central-cafe') a_kitchen,
       tests.user_id('owner', 'second-cafe') b_admin, tests.user_id('waiter', 'second-cafe') b_waiter,
       '00000000-0000-4000-8000-0000000000c1'::uuid super_admin,
       '00000000-0000-4000-8000-0000000044a1'::uuid a_helper,   -- custom role: payments.create + orders.view (no orders.view_all)
       '00000000-0000-4000-8000-0000000044a2'::uuid a_payonly;  -- custom role: payments.create only
grant all on _f to public;
create temp table _n (k text primary key, v text);
grant all on _n to public;
create function tests.nv(p_k text) returns uuid language sql stable as $$ select v::uuid from _n where k = p_k $$;
create function tests.jv(p_k text) returns jsonb language sql stable as $$ select v::jsonb from _n where k = p_k $$;
create function tests.pid(p_k text) returns uuid language sql stable as $$ select (v::jsonb ->> 'payment_id')::uuid from _n where k = p_k $$;
create function tests.pm(p_rid uuid, p_name text) returns uuid language sql stable security definer set search_path = '' as $$
  select id from public.payment_methods where restaurant_id = p_rid and name = p_name $$;
create function tests.cart(p_slug text, p_spec text[]) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_agg(jsonb_build_object('menu_item_id', m.id, 'qty', split_part(s, ':', 2)::int) order by o)
  from unnest(p_spec) with ordinality u(s, o)
  join public.menu_items m on m.name = split_part(s, ':', 1) and m.restaurant_id = (select id from public.restaurants where slug = p_slug) $$;
create function tests.n_pay(p_rid uuid) returns int language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.payments where restaurant_id = p_rid $$;
create function tests.pay_status(p_order uuid) returns text language sql stable security definer set search_path = '' as $$
  select payment_status from public.orders where id = p_order $$;
create function tests.ev(p_rid uuid, p_event text) returns int language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.audit_logs a where a.restaurant_id = p_rid and a.event = p_event $$;
create function tests.ev_pay(p_event text, p_payment uuid) returns int language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.audit_logs a where a.event = p_event and a.new_data ->> 'payment_id' = p_payment::text $$;
create function tests.ev_actor(p_event text, p_payment uuid) returns text language sql stable security definer set search_path = '' as $$
  select string_agg(a.restaurant_id || '|' || coalesce(a.actor_id::text, '-') || '|' || a.actor_type, ',')
  from public.audit_logs a where a.event = p_event and a.new_data ->> 'payment_id' = p_payment::text $$;
create function tests.pay_row(p_payment uuid) returns text language sql stable security definer set search_path = '' as $$
  select p::text from public.payments p where p.id = p_payment $$;
grant execute on all functions in schema tests to public;

insert into _n select 'a_cash', tests.pm((select a from _f), 'Cash');
insert into _n select 'a_tele', tests.pm((select a from _f), 'Telebirr');
insert into _n select 'b_cash', tests.pm((select b from _f), 'Cash');

-- custom roles (dynamic rows, UUID-keyed) and one staff profile on each
do $$ begin
  declare v_a uuid := tests.tenant_id('central-cafe'); v_helper uuid; v_payonly uuid;
  begin
    insert into public.roles (restaurant_id, name) values (v_a, 'Till Helper') returning id into v_helper;
    insert into public.roles (restaurant_id, name) values (v_a, 'Pay Only') returning id into v_payonly;
    insert into public.role_permissions (role_id, permission_id, restaurant_id)
      select v_helper, id, v_a from public.permissions where key in ('payments.create', 'orders.view');
    insert into public.role_permissions (role_id, permission_id, restaurant_id)
      select v_payonly, id, v_a from public.permissions where key = 'payments.create';
    perform tests.create_auth_user('00000000-0000-4000-8000-0000000044a1', 'tillhelper@central-cafe.staff.cafeos.invalid');
    perform tests.create_auth_user('00000000-0000-4000-8000-0000000044a2', 'payonly@central-cafe.staff.cafeos.invalid');
    insert into public.profiles (id, restaurant_id, first_name, username, role_id, auth_method) values
      ('00000000-0000-4000-8000-0000000044a1', v_a, 'Till', 'tillhelper', v_helper, 'pin'),
      ('00000000-0000-4000-8000-0000000044a2', v_a, 'Pay', 'payonly', v_payonly, 'pin');
  end;
end $$;

-- fixtures through the real pipeline: orders by A's waiter and B's waiter, one payment per tenant
select tests.authenticate_as((select a_waiter from _f));
insert into _n select 'oa1', public.fn_submit_order(tests.cart('central-cafe', array['Macchiato:2']), 'adv-pay-order-0001') ->> 'id';
insert into _n select 'oa2', public.fn_submit_order(tests.cart('central-cafe', array['Macchiato:1']), 'adv-pay-order-0002') ->> 'id';
insert into _n select 'oa3', public.fn_submit_order(tests.cart('central-cafe', array['Macchiato:1']), 'adv-pay-order-0003') ->> 'id';
insert into _n select 'oa4', public.fn_submit_order(tests.cart('central-cafe', array['Macchiato:1']), 'adv-pay-order-0004') ->> 'id';
select tests.clear_auth();
select tests.authenticate_as((select b_waiter from _f));
insert into _n select 'ob1', public.fn_submit_order(tests.cart('second-cafe', array['Second Cafe Special:1']), 'adv-pay-order-b001') ->> 'id';
insert into _n select 'ob2', public.fn_submit_order(tests.cart('second-cafe', array['Second Cafe Special:1']), 'adv-pay-order-b002') ->> 'id';
select tests.clear_auth();
select tests.authenticate_as((select a_cashier from _f));
insert into _n select 'pa1', public.fn_confirm_payment(tests.nv('oa1'), tests.nv('a_cash'), null, 'adv-pay-key-0001')::text;
select tests.clear_auth();
create temp table _snap on commit drop as select tests.snapshot((select a from _f)) a, tests.pay_row(tests.pid('pa1')) pa1;
grant all on _snap to public;

-- ═════════ anon, platform admin, internal builder ═════════
select tests.as_anon();
select is(tests.run(format($q$select public.fn_confirm_payment(%L, %L, null, 'adv-anon-key-01')$q$, tests.nv('oa2'), tests.nv('a_cash'))),
          '42501|permission denied for function fn_confirm_payment|', 'anon: no EXECUTE on fn_confirm_payment');
select is(tests.run(format($q$select public.fn_reverse_payment(%L, 'anon reverse', 'adv-anon-key-02')$q$, tests.pid('pa1'))),
          '42501|permission denied for function fn_reverse_payment|', 'anon: no EXECUTE on fn_reverse_payment');
select is(tests.run(format($q$select public.fn_get_receipt(%L)$q$, tests.pid('pa1'))),
          '42501|permission denied for function fn_get_receipt|', 'anon: no EXECUTE on fn_get_receipt');
select tests.clear_auth();
select tests.authenticate_as_service_role();
select is(tests.run(format($q$select public.fn_receipt_json(%L, %L)$q$, tests.pid('pa1'), (select a from _f))),
          '42501|permission denied for function fn_receipt_json|', 'service_role cannot call the tenant-id-taking receipt builder either');
select tests.clear_auth();
select tests.aal2((select super_admin from _f));
select is(tests.oracle($q$select public.fn_get_receipt({id})$q$, tests.pid('pa1')), 'P0001|permission_denied|',
          'platform super admin (no tenant profile): fn_get_receipt permission_denied, real id = unknown id');
select is(tests.oracle(format($q$select public.fn_confirm_payment({id}, %L, null, 'adv-plat-key-01')$q$, tests.nv('a_cash')), tests.nv('oa2')), 'P0001|permission_denied|',
          'platform super admin cannot take a tenant payment (no oracle)');
select is(tests.oracle($q$select public.fn_reverse_payment({id}, 'platform reverse', 'adv-plat-key-02')$q$, tests.pid('pa1')), 'P0001|permission_denied|',
          'platform super admin cannot reverse a tenant payment (no oracle)');
select tests.clear_auth();
select tests.authenticate_as((select a_admin from _f));
select matches(tests.run($q$select public.fn_write_audit('payment.confirmed', '{}'::jsonb)$q$), '^42501\|', 'the audit writer is not client-callable (no forged payment.confirmed)');
select tests.clear_auth();

-- ═════════ IDOR B -> A (real foreign ids vs unknown ids) ═════════
select tests.aal2((select b_admin from _f));
select is(tests.oracle(format($q$select public.fn_confirm_payment({id}, %L, null, 'adv-idor-key-b01')$q$, tests.nv('b_cash')), tests.nv('oa2')), 'P0001|not_found|',
          'B admin paying A''s order with its own method: not_found, no oracle');
select is(tests.oracle(format($q$select public.fn_confirm_payment(%L, {id}, null, 'adv-idor-key-b02')$q$, tests.nv('ob2')), tests.nv('a_cash')), 'P0001|invalid_input|payment_method_id',
          'B admin paying its own order with A''s payment method: same answer as an unknown method');
select is(tests.oracle($q$select public.fn_reverse_payment({id}, 'cross tenant', 'adv-idor-key-b03')$q$, tests.pid('pa1')), 'P0001|not_found|',
          'B admin (aal2) reversing A''s payment: not_found, no oracle');
select is(tests.oracle($q$select public.fn_get_receipt({id})$q$, tests.pid('pa1')), 'P0001|not_found|', 'B admin reading A''s receipt: not_found, no oracle');
select is((select count(*)::int from public.payments where id = tests.pid('pa1')), 0, 'B admin selects no A payment row (RLS)');
-- idempotency key reuse ACROSS TENANTS: B uses A's key value and gets its own payment, never A's receipt
insert into _n select 'pb1', public.fn_confirm_payment(tests.nv('ob1'), tests.nv('b_cash'), null, 'adv-pay-key-0001')::text;
select is((tests.jv('pb1') ->> 'replayed'), 'false', 'B reusing A''s idempotency key value: a fresh execution, not a replay of A');
select is(tests.jv('pb1') -> 'order' ->> 'id', tests.nv('ob1')::text, '... for B''s own order');
select is(tests.jv('pb1') -> 'restaurant' ->> 'name', (select name from public.restaurants where id = (select b from _f)), '... with B''s identity on the receipt');
select tests.clear_auth();
select is((select restaurant_id from public.payments where id = tests.pid('pb1')), (select b from _f), 'the B payment row belongs to B');
select is(tests.pay_row(tests.pid('pa1')), (select pa1 from _snap), 'A''s payment is untouched by B''s key reuse');
select is(tests.snapshot((select a from _f)), (select a from _snap), 'tenant A unchanged by every refused B attempt');
select tests.authenticate_as((select b_waiter from _f));
select is(tests.oracle($q$select public.fn_get_receipt({id})$q$, tests.pid('pa1')), 'P0001|permission_denied|', 'B waiter (no payments rights) on A''s receipt: permission_denied, no oracle');
select tests.clear_auth();

-- ═════════ IDOR A -> B ═════════
create temp table _snapb on commit drop as select tests.snapshot((select b from _f)) b;
grant all on _snapb to public;
select tests.aal2((select a_admin from _f));
select is(tests.oracle(format($q$select public.fn_confirm_payment({id}, %L, null, 'adv-idor-key-a01')$q$, tests.nv('a_cash')), tests.nv('ob2')), 'P0001|not_found|',
          'A admin paying B''s order: not_found, no oracle');
select is(tests.oracle($q$select public.fn_reverse_payment({id}, 'cross tenant', 'adv-idor-key-a02')$q$, tests.pid('pb1')), 'P0001|not_found|',
          'A admin reversing B''s payment: not_found, no oracle');
select is(tests.oracle($q$select public.fn_get_receipt({id})$q$, tests.pid('pb1')), 'P0001|not_found|', 'A admin reading B''s receipt: not_found, no oracle');
select tests.clear_auth();
select is(tests.snapshot((select b from _f)), (select b from _snapb), 'tenant B unchanged by every refused A attempt');
select is(tests.ev_pay('payment.receipt_viewed', tests.pid('pb1')) + tests.ev_pay('payment.receipt_viewed', tests.pid('pa1')), 0,
          'refused cross-tenant receipt reads leave no reprint audit row anywhere');

-- ═════════ role escalation ═════════
select tests.authenticate_as((select a_waiter from _f));
select is(tests.run(format($q$select public.fn_reverse_payment(%L, 'waiter reverse', 'adv-esc-key-w01')$q$, tests.pid('pa1'))), 'P0001|permission_denied|',
          'waiter: no reversal');
select is(tests.run(format($q$select public.fn_get_receipt(%L)$q$, tests.pid('pa1'))), 'P0001|permission_denied|',
          'waiter: no receipt even for the payment of an order the waiter took');
select tests.clear_auth();
select tests.authenticate_as((select a_kitchen from _f));
select is(tests.run(format($q$select public.fn_confirm_payment(%L, %L, null, 'adv-esc-key-k01')$q$, tests.nv('oa2'), tests.nv('a_cash'))), 'P0001|permission_denied|',
          'station operator (orders.view only): no payment');
select is(tests.run(format($q$select public.fn_get_receipt(%L)$q$, tests.pid('pa1'))), 'P0001|permission_denied|', 'station operator: no receipt');
select tests.clear_auth();
-- payments.create WITHOUT orders.view
select tests.authenticate_as((select a_payonly from _f));
select is(tests.run(format($q$select public.fn_confirm_payment(%L, %L, null, 'adv-esc-key-p01')$q$, tests.nv('oa2'), tests.nv('a_cash'))), 'P0001|permission_denied|',
          'custom role with payments.create but no orders.view: cannot take a payment');
select is(tests.oracle($q$select public.fn_get_receipt({id})$q$, tests.pid('pa1')), 'P0001|not_found|',
          'payments.create only: someone else''s receipt = not_found, same as an unknown id');
select is((select count(*)::int from public.payments), 0, 'payments.create only: reads no payment rows (RLS needs payments.view)');
select tests.clear_auth();
-- payments.create + orders.view WITHOUT orders.view_all: may it pay (and read the lines of) an order it cannot see?
select tests.authenticate_as((select a_helper from _f));
select is((select count(*)::int from public.orders where id = tests.nv('oa2')), 0, 'premise: the Till Helper cannot see the waiter''s order (no orders.view_all)');
select is(tests.oracle(format($q$select public.fn_confirm_payment({id}, %L, null, 'adv-esc-key-h01')$q$, tests.nv('a_cash')), tests.nv('oa2')), 'P0001|not_found|',
          'payments.create + orders.view (own orders only): paying an order it cannot see = not_found, same as an unknown id');
select is(tests.oracle($q$select public.fn_get_receipt({id})$q$, tests.pid('pa1')), 'P0001|not_found|',
          'Till Helper: the cashier''s receipt = not_found, same as an unknown id');
select is(tests.run(format($q$select public.fn_reverse_payment(%L, 'helper reverse', 'adv-esc-key-h02')$q$, tests.pid('pa1'))), 'P0001|permission_denied|',
          'Till Helper: no reversal');
select is(tests.run(format($q$insert into public.role_permissions (role_id, permission_id, restaurant_id) select ro.id, pm.id, ro.restaurant_id from public.roles ro, public.permissions pm where ro.name = 'Till Helper' and pm.key in ('orders.view_all', 'payments.view', 'payments.reverse')$q$)),
          '42501|permission denied for table role_permissions|', 'Till Helper cannot grant itself orders.view_all / payments.view / payments.reverse');
select tests.clear_auth();
select is(tests.pay_status(tests.nv('oa2')) || '|' || (select count(*)::int from public.payments where order_id = tests.nv('oa2')), 'unpaid|0',
          'the refused escalation attempts wrote no payment on oa2');
-- a deactivated custom role keeps nothing
update public.roles set is_active = false where restaurant_id = (select a from _f) and name = 'Till Helper';
select tests.authenticate_as((select a_helper from _f));
select is(tests.run(format($q$select public.fn_confirm_payment(%L, %L, null, 'adv-esc-key-h03')$q$, tests.nv('oa3'), tests.nv('a_cash'))), 'P0001|permission_denied|',
          'a deactivated custom role cannot take payments');
select tests.clear_auth();
update public.roles set is_active = true where restaurant_id = (select a from _f) and name = 'Till Helper';
-- a deactivated cashier profile
update public.profiles set is_active = false where id = (select a_cashier from _f);
select tests.authenticate_as((select a_cashier from _f));
select is(tests.run(format($q$select public.fn_confirm_payment(%L, %L, null, 'adv-esc-key-c01')$q$, tests.nv('oa3'), tests.nv('a_cash'))), 'P0001|permission_denied|',
          'a deactivated cashier cannot take payments');
select is(tests.run(format($q$select public.fn_get_receipt(%L)$q$, tests.pid('pa1'))), 'P0001|permission_denied|', '... nor reprint its own receipt');
select tests.clear_auth();
update public.profiles set is_active = true where id = (select a_cashier from _f);

-- ═════════ tenant status ═════════
create temp table _cnt on commit drop as select tests.n_pay((select a from _f)) p, tests.ev((select a from _f), 'payment.confirmed') c,
                                               tests.ev((select a from _f), 'payment.reversed') r;
grant all on _cnt to public;
update public.restaurants set status = 'past_due' where id = (select a from _f);
select tests.authenticate_as((select a_cashier from _f));
select is(tests.run(format($q$select public.fn_confirm_payment(%L, %L, null, 'adv-st-key-0001')$q$, tests.nv('oa3'), tests.nv('a_cash'))), 'P0001|tenant_read_only|',
          'past_due: no new payment');
select is(tests.run(format($q$select public.fn_confirm_payment(%L, %L, null, 'adv-pay-key-0001')$q$, tests.nv('oa1'), tests.nv('a_cash'))), 'P0001|tenant_read_only|',
          'past_due: not even a replay of an accepted key (the guard runs first)');
select is(tests.run(format($q$select public.fn_get_receipt(%L)$q$, tests.pid('pa1'))), 'ok:1', 'past_due: receipts stay readable (read-only, not locked out)');
select tests.clear_auth();
select tests.aal2((select a_admin from _f));
select is(tests.run(format($q$select public.fn_reverse_payment(%L, 'read only reverse', 'adv-st-key-0002')$q$, tests.pid('pa1'))), 'P0001|tenant_read_only|',
          'past_due: no reversal, even for the tenant admin with aal2');
select tests.clear_auth();
update public.restaurants set status = 'suspended' where id = (select a from _f);
select tests.authenticate_as((select a_cashier from _f));
select is(tests.run(format($q$select public.fn_confirm_payment(%L, %L, null, 'adv-st-key-0003')$q$, tests.nv('oa3'), tests.nv('a_cash'))), 'P0001|tenant_suspended|',
          'suspended: no payment');
select is(tests.run(format($q$select public.fn_confirm_payment(%L, %L, null, 'adv-pay-key-0001')$q$, tests.nv('oa1'), tests.nv('a_cash'))), 'P0001|tenant_suspended|',
          'suspended: no replay either');
select is(tests.run(format($q$select public.fn_get_receipt(%L)$q$, tests.pid('pa1'))), 'P0001|tenant_suspended|', 'suspended: no receipt');
select tests.clear_auth();
select tests.aal2((select a_admin from _f));
select is(tests.run(format($q$select public.fn_reverse_payment(%L, 'suspended reverse', 'adv-st-key-0004')$q$, tests.pid('pa1'))), 'P0001|tenant_suspended|',
          'suspended: no reversal');
select is(tests.run(format($q$select public.fn_get_receipt(%L)$q$, tests.pid('pa1'))), 'P0001|tenant_suspended|', 'suspended: no receipt for the tenant admin either');
select tests.clear_auth();
update public.restaurants set status = 'active' where id = (select a from _f);
select is(tests.n_pay((select a from _f)) || '|' || tests.ev((select a from _f), 'payment.confirmed') || '|' || tests.ev((select a from _f), 'payment.reversed')
          || '|' || tests.pay_status(tests.nv('oa3')), (select p || '|' || c || '|' || r || '|unpaid' from _cnt),
          'past_due / suspended: no payment, no audit row, the order still unpaid');

-- ═════════ immutability (rows written by the RPC) ═════════
select tests.authenticate_as((select a_cashier from _f));
select is(tests.run(format($q$update public.payments set amount = 1 where id = %L$q$, tests.pid('pa1'))), '42501|permission denied for table payments|', 'cashier cannot UPDATE its payment');
select is(tests.run(format($q$delete from public.payments where id = %L$q$, tests.pid('pa1'))), '42501|permission denied for table payments|', 'cashier cannot DELETE its payment');
select tests.clear_auth();
select tests.aal2((select a_admin from _f));
select is(tests.run(format($q$update public.payments set amount = 1, method_name_snapshot = 'x' where id = %L$q$, tests.pid('pa1'))), '42501|permission denied for table payments|',
          'tenant admin (aal2) cannot UPDATE a payment');
select is(tests.run(format($q$delete from public.payments where id = %L$q$, tests.pid('pa1'))), '42501|permission denied for table payments|', 'tenant admin (aal2) cannot DELETE a payment');
select is(tests.run(format($q$insert into public.payments (restaurant_id, day_session_id, order_id, kind, amount, payment_method_id, method_name_snapshot, method_affects_drawer_snapshot, receipt_no, reversed_payment_id) select restaurant_id, day_session_id, order_id, 'reversal', amount, payment_method_id, method_name_snapshot, method_affects_drawer_snapshot, 'RCT-8888', id from public.payments where id = %L$q$, tests.pid('pa1'))),
          '42501|permission denied for table payments|', 'tenant admin cannot hand-craft a reversal row (bypassing step-up and audit)');
select is(tests.run(format($q$update public.orders set payment_status = 'paid' where id = %L$q$, tests.nv('oa3'))), '42501|permission denied for table orders|',
          'tenant admin cannot mark an order paid without a payment');
select is(tests.run($q$select count(*) from public.idempotency_keys$q$), '42501|permission denied for table idempotency_keys|', 'idempotency results are not client-readable');
select is(tests.run($q$update public.idempotency_keys set result = '{}'::jsonb$q$), '42501|permission denied for table idempotency_keys|',
          'nor client-writable (no forged replay answer)');
select tests.clear_auth();
select is(tests.run(format($q$update public.payments set amount = 1 where id = %L$q$, tests.pid('pa1'))), 'P0001|immutable_record|payments', 'the owner role cannot UPDATE it either');
select is(tests.run(format($q$delete from public.payments where id = %L$q$, tests.pid('pa1'))), 'P0001|immutable_record|payments', 'nor DELETE it');
select is(tests.pay_row(tests.pid('pa1')), (select pa1 from _snap), 'the payment row is byte-for-byte unchanged');

-- ═════════ audit integrity + idempotency across users / commands ═════════
select is(tests.ev_pay('payment.confirmed', tests.pid('pa1')), 1, 'exactly one payment.confirmed row for the payment');
select is(tests.ev_actor('payment.confirmed', tests.pid('pa1')), (select a || '|' || a_cashier || '|user' from _f), 'in tenant A, actor = the cashier (from identity)');
select tests.authenticate_as((select a_cashier from _f));
select is((public.fn_confirm_payment(tests.nv('oa1'), tests.nv('a_cash'), null, 'adv-pay-key-0001') ->> 'replayed'), 'true', 'the cashier replays its own key');
select is(tests.run(format($q$select public.fn_confirm_payment(%L, %L, null, 'adv-pay-key-0099')$q$, tests.nv('oa1'), tests.nv('a_cash'))), 'P0001|order_not_payable|paid',
          'a second payment of the same order with a new key is refused');
select tests.clear_auth();
-- the same key value, the SAME payload, ANOTHER user of the same tenant: the fingerprint includes the actor
select tests.authenticate_as((select a_admin from _f));
select is(tests.run(format($q$select public.fn_confirm_payment(%L, %L, null, 'adv-pay-key-0001')$q$, tests.nv('oa1'), tests.nv('a_cash'))), 'P0001|idempotency_conflict|',
          'another user reusing the cashier''s key (same payload) gets a conflict, never the cashier''s receipt');
select is(tests.run(format($q$select public.fn_confirm_payment(%L, %L, null, 'adv-pay-key-0001')$q$, tests.nv('oa3'), tests.nv('a_cash'))), 'P0001|idempotency_conflict|',
          '... and cannot use it for another order either');
select tests.clear_auth();
select is(tests.ev_pay('payment.confirmed', tests.pid('pa1')) || '|' || (select count(*)::int from public.payments where order_id = tests.nv('oa1')), '1|1',
          'replay, refused second payment and conflicting reuse: still one payment and one audit row');
-- a key value already used by ANOTHER command (fn_submit_order) is a separate namespace: a fresh payment, not the order's replay
select tests.authenticate_as((select a_cashier from _f));
insert into _n select 'pa4', public.fn_confirm_payment(tests.nv('oa4'), tests.nv('a_cash'), null, 'adv-pay-order-0004')::text;
select is(tests.jv('pa4') ->> 'kind' || '|' || (tests.jv('pa4') ->> 'replayed') || '|' || (tests.jv('pa4') -> 'order' ->> 'id'), 'order_payment|false|' || tests.nv('oa4'),
          'a payment key equal to an order-submission key: a fresh payment of the right order');
select tests.clear_auth();
-- reverse: one audit row, the replay writes none
select tests.aal2((select a_admin from _f));
insert into _n select 'ra1', public.fn_reverse_payment(tests.pid('pa1'), 'wrong order paid', 'adv-rev-key-0001')::text;
select is((public.fn_reverse_payment(tests.pid('pa1'), 'wrong order paid', 'adv-rev-key-0001') ->> 'replayed'), 'true', 'a reversal replay returns the stored reversal');
select is(tests.run(format($q$select public.fn_reverse_payment(%L, 'wrong order paid', 'adv-rev-key-0001')$q$, tests.pid('pa4'))), 'P0001|idempotency_conflict|',
          'the reversal key reused for another payment is a conflict');
select tests.clear_auth();
select is(tests.ev_pay('payment.reversed', tests.pid('pa1')) || '|' || (select count(*)::int from public.payments where reversed_payment_id = tests.pid('pa1')), '1|1',
          'exactly one reversal row and one payment.reversed audit row (replay / conflict wrote none)');
select is(tests.ev_actor('payment.reversed', tests.pid('pa1')), (select a || '|' || a_admin || '|user' from _f), 'reversal audit: tenant A, actor = the admin');
-- a reprint by someone else is audited once with the reader as actor; the issuer's own read is not
create temp table _rv on commit drop as select tests.ev_pay('payment.receipt_viewed', tests.pid('pa4')) n;
grant all on _rv to public;
select tests.authenticate_as((select a_cashier from _f));
select is(tests.run(format($q$select public.fn_get_receipt(%L)$q$, tests.pid('pa4'))), 'ok:1', 'the issuer reads its own receipt');
select tests.clear_auth();
select tests.authenticate_as((select a_admin from _f));
select is(tests.run(format($q$select public.fn_get_receipt(%L)$q$, tests.pid('pa4'))), 'ok:1', 'the admin reprints it');
select tests.clear_auth();
select is(tests.ev_pay('payment.receipt_viewed', tests.pid('pa4')) - (select n from _rv), 1, 'one reprint audit row (the issuer''s own read writes none)');
select is(tests.ev_actor('payment.receipt_viewed', tests.pid('pa4')), (select a || '|' || a_admin || '|user' from _f), 'reprint audit: actor = the reader');
-- audit rows cannot be forged, edited or deleted by the tenant admin
select tests.aal2((select a_admin from _f));
select is(tests.run(format($q$insert into public.audit_logs (restaurant_id, actor_id, actor_type, event, action, new_data) values (%L, %L, 'user', 'payment.reversed', 'event', jsonb_build_object('payment_id', %L::text))$q$,
          (select a from _f), (select a_cashier from _f), tests.pid('pa4'))), '42501|permission denied for table audit_logs|', 'tenant admin cannot forge a payment.reversed audit row');
select is(tests.run(format($q$update public.audit_logs set new_data = new_data || '{"amount": 1}' where new_data ->> 'payment_id' = %L$q$, tests.pid('pa1'))),
          '42501|permission denied for table audit_logs|', 'nor edit a payment audit row');
select is(tests.run(format($q$delete from public.audit_logs where new_data ->> 'payment_id' = %L$q$, tests.pid('pa1'))),
          '42501|permission denied for table audit_logs|', 'nor delete one');
select tests.clear_auth();
select is((select count(*)::int from public.audit_logs where restaurant_id = (select b from _f)
           and new_data ->> 'payment_id' in (tests.pid('pa1')::text, tests.pid('pa4')::text)), 0, 'no audit row about A''s payments lands in tenant B');

select * from finish();
rollback;
