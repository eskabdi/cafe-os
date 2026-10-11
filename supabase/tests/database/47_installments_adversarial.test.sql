-- Phase 7 (migration 0035) adversarial supplement to 43_installments.test.sql.
-- fn_generate_voucher / fn_confirm_installment / fn_get_voucher / fn_list_vouchers (+ fn_get_receipt on voucher payments) x {anon,
-- platform admin, foreign tenant, waiter, station operator, custom roles: vouchers.view only, vouchers.manage without orders.view,
-- vouchers.manage + orders.view(_all) without vouchers.view, payments.view without vouchers.view; past_due, suspended, cancelled};
-- IDOR with real foreign vs unknown ids (tests.oracle, no existence oracle) in both tenant directions; client UPDATE / DELETE / INSERT
-- on vouchers / installments refused for every role; owner-level edits blocked where guards apply (closed day, restaurant_id lock,
-- payments append-only, ON DELETE RESTRICT) and the 0035 backstop unique indexes; audit integrity (one voucher.issued /
-- installment.collected per action, none on a replay / refusal, actor from identity, no customer_phone anywhere, not forgeable);
-- idempotency keys reused across users, tenants and commands; overpayment / double-collection sequences.
begin;
select plan(147);

create temp table _f on commit drop as
select tests.tenant_id('central-cafe') a, tests.tenant_id('second-cafe') b,
       tests.user_id('selam', 'central-cafe') a_admin, tests.user_id('yonas', 'central-cafe') a_waiter,
       tests.user_id('hanna', 'central-cafe') a_cashier, tests.user_id('abebe', 'central-cafe') a_kitchen,
       tests.user_id('owner', 'second-cafe') b_admin, tests.user_id('waiter', 'second-cafe') b_waiter,
       '00000000-0000-4000-8000-0000000000c1'::uuid super_admin,
       '00000000-0000-4000-8000-0000000047a1'::uuid a_vview,     -- custom role: vouchers.view only
       '00000000-0000-4000-8000-0000000047a2'::uuid a_vmanage,   -- custom role: vouchers.manage only (no orders.view)
       '00000000-0000-4000-8000-0000000047a3'::uuid a_collect,   -- custom role: vouchers.manage + orders.view + orders.view_all (no vouchers.view)
       '00000000-0000-4000-8000-0000000047a4'::uuid a_payview;   -- custom role: payments.view only (no vouchers.view)
grant all on _f to public;
create temp table _n (k text primary key, v text);
grant all on _n to public;
create function tests.nv(p_k text) returns uuid language sql stable as $$ select v::uuid from _n where k = p_k $$;
create function tests.jv(p_k text) returns jsonb language sql stable as $$ select v::jsonb from _n where k = p_k $$;
create function tests.vid(p_k text) returns uuid language sql stable as $$ select (v::jsonb -> 'voucher' ->> 'id')::uuid from _n where k = p_k $$;
create function tests.dpid(p_k text) returns uuid language sql stable as $$ select (v::jsonb -> 'down_receipt' ->> 'payment_id')::uuid from _n where k = p_k $$;
create function tests.pid(p_k text) returns uuid language sql stable as $$ select (v::jsonb ->> 'payment_id')::uuid from _n where k = p_k $$;
create function tests.pm(p_rid uuid, p_name text) returns uuid language sql stable security definer set search_path = '' as $$
  select id from public.payment_methods where restaurant_id = p_rid and name = p_name $$;
create function tests.cart(p_slug text, p_spec text[]) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_agg(jsonb_build_object('menu_item_id', m.id, 'qty', split_part(s, ':', 2)::int) order by o)
  from unnest(p_spec) with ordinality u(s, o)
  join public.menu_items m on m.name = split_part(s, ':', 1) and m.restaurant_id = (select id from public.restaurants where slug = p_slug) $$;
create function tests.pay_status(p_order uuid) returns text language sql stable security definer set search_path = '' as $$
  select payment_status from public.orders where id = p_order $$;
create function tests.order_total(p_order uuid) returns numeric language sql stable security definer set search_path = '' as $$
  select total from public.orders where id = p_order $$;
-- per-tenant counters (definer: independent of the caller's RLS)
create function tests.counts(p_rid uuid) returns text language sql stable security definer set search_path = '' as $$
  select (select count(*) from public.vouchers where restaurant_id = p_rid) || '|' ||
         (select count(*) from public.installments where restaurant_id = p_rid and paid) || '|' ||
         (select count(*) from public.payments where restaurant_id = p_rid) || '|' ||
         (select count(*) from public.audit_logs where restaurant_id = p_rid and event in ('voucher.issued', 'installment.collected')) $$;
create function tests.ev_v(p_event text, p_voucher uuid) returns int language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.audit_logs a where a.event = p_event and a.new_data ->> 'voucher_id' = p_voucher::text $$;
create function tests.ev_p(p_event text, p_payment uuid) returns int language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.audit_logs a where a.event = p_event and a.new_data ->> 'payment_id' = p_payment::text $$;
create function tests.ev_actor(p_event text, p_voucher uuid) returns text language sql stable security definer set search_path = '' as $$
  select string_agg(a.restaurant_id || '|' || coalesce(a.actor_id::text, '-') || '|' || a.actor_type, ',')
  from public.audit_logs a where a.event = p_event and a.new_data ->> 'voucher_id' = p_voucher::text $$;
create function tests.ev_n(p_rid uuid, p_event text) returns int language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.audit_logs a where a.restaurant_id = p_rid and a.event = p_event $$;
create function tests.n_kind(p_rid uuid, p_kind text) returns int language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.payments where restaurant_id = p_rid and kind = p_kind $$;
create function tests.inst(p_voucher uuid) returns text language sql stable security definer set search_path = '' as $$
  select string_agg(no || ':' || amount || ':' || paid, ',' order by no) from public.installments where voucher_id = p_voucher $$;
create function tests.inst_id(p_voucher uuid, p_no int) returns uuid language sql stable security definer set search_path = '' as $$
  select id from public.installments where voucher_id = p_voucher and no = p_no $$;
create function tests.inst_pay(p_voucher uuid, p_no int) returns uuid language sql stable security definer set search_path = '' as $$
  select payment_id from public.installments where voucher_id = p_voucher and no = p_no $$;
create function tests.v_row(p_voucher uuid) returns text language sql stable security definer set search_path = '' as $$
  select v::text || '#' || (select string_agg(i::text, ';' order by i.no) from public.installments i where i.voucher_id = v.id)
  from public.vouchers v where v.id = p_voucher $$;
-- every client write a role could try on vouchers / installments (security invoker: runs as the CURRENT role)
create function tests.write_probe(p_voucher uuid) returns text language plpgsql as $$
begin
  return tests.run(format($q$update public.vouchers set total = 1, customer_name = 'x' where id = %L$q$, p_voucher)) || ' / ' ||
         tests.run(format($q$update public.vouchers set restaurant_id = gen_random_uuid() where id = %L$q$, p_voucher)) || ' / ' ||
         tests.run(format($q$delete from public.vouchers where id = %L$q$, p_voucher)) || ' / ' ||
         tests.run(format($q$update public.installments set paid = true, paid_at = now(), amount = 0.01 where voucher_id = %L$q$, p_voucher)) || ' / ' ||
         tests.run(format($q$delete from public.installments where voucher_id = %L$q$, p_voucher)) || ' / ' ||
         tests.run(format($q$insert into public.installments (restaurant_id, voucher_id, no, due_date, amount) values (gen_random_uuid(), %L, 59, current_date, 1)$q$, p_voucher));
end $$;
grant execute on all functions in schema tests to public;

insert into _n select 'a_cash', tests.pm((select a from _f), 'Cash');
insert into _n select 'a_tele', tests.pm((select a from _f), 'Telebirr');
insert into _n select 'b_cash', tests.pm((select b from _f), 'Cash');

-- custom roles (dynamic rows, UUID-keyed) and one staff profile on each
do $$ begin
  declare v_a uuid := tests.tenant_id('central-cafe'); v_r uuid; v_spec record;
  begin
    for v_spec in select * from (values
        ('00000000-0000-4000-8000-0000000047a1'::uuid, 'Voucher Viewer', 'vview',   array['vouchers.view']),
        ('00000000-0000-4000-8000-0000000047a2'::uuid, 'Voucher Clerk',  'vmanage', array['vouchers.manage']),
        ('00000000-0000-4000-8000-0000000047a3'::uuid, 'Collector',      'collect', array['vouchers.manage', 'orders.view', 'orders.view_all']),
        ('00000000-0000-4000-8000-0000000047a4'::uuid, 'Pay Viewer',     'payview', array['payments.view'])) s(uid, rname, uname, perms)
    loop
      insert into public.roles (restaurant_id, name) values (v_a, v_spec.rname) returning id into v_r;
      insert into public.role_permissions (role_id, permission_id, restaurant_id)
        select v_r, id, v_a from public.permissions where key = any (v_spec.perms);
      perform tests.create_auth_user(v_spec.uid, v_spec.uname || '@central-cafe.staff.cafeos.invalid');
      insert into public.profiles (id, restaurant_id, first_name, username, role_id, auth_method)
        values (v_spec.uid, v_a, initcap(v_spec.uname), v_spec.uname, v_r, 'pin');
    end loop;
  end;
end $$;

-- fixtures through the real pipeline
select tests.authenticate_as((select a_waiter from _f));
insert into _n select 'oa1', public.fn_submit_order(tests.cart('central-cafe', array['Macchiato:4']), 'adv-inst-order-0001') ->> 'id';
insert into _n select 'oa2', public.fn_submit_order(tests.cart('central-cafe', array['Macchiato:2']), 'adv-inst-order-0002') ->> 'id';
insert into _n select 'oa3', public.fn_submit_order(tests.cart('central-cafe', array['Macchiato:1']), 'adv-inst-order-0003') ->> 'id';
insert into _n select 'oa4', public.fn_submit_order(tests.cart('central-cafe', array['Macchiato:1']), 'adv-inst-order-0004') ->> 'id';
insert into _n select 'oa5', public.fn_submit_order(tests.cart('central-cafe', array['Macchiato:3']), 'adv-inst-order-0005') ->> 'id';
select tests.clear_auth();
select tests.authenticate_as((select b_waiter from _f));
insert into _n select 'ob1', public.fn_submit_order(tests.cart('second-cafe', array['Second Cafe Special:3']), 'adv-inst-order-b001') ->> 'id';
insert into _n select 'ob2', public.fn_submit_order(tests.cart('second-cafe', array['Second Cafe Special:1']), 'adv-inst-order-b002') ->> 'id';
insert into _n select 'ob3', public.fn_submit_order(tests.cart('second-cafe', array['Second Cafe Special:2']), 'adv-inst-order-b003') ->> 'id';
select tests.clear_auth();
select tests.authenticate_as((select a_cashier from _f));
insert into _n select 'va1', public.fn_generate_voucher(tests.nv('oa1'), 'Almaz Tesfaye Bekele', '+251 911 470001', 10, tests.nv('a_cash'), null, 3, 7, 'adv-inst-gen-a001')::text;
insert into _n select 'va2', public.fn_generate_voucher(tests.nv('oa2'), 'Dawit Girma Haile', null, 0, null, null, 2, 7, 'adv-inst-gen-a002')::text;
insert into _n select 'ca21', public.fn_confirm_installment(tests.vid('va2'), tests.nv('a_cash'), null, 'adv-inst-col-a001', 1)::text;
insert into _n select 'pa4', public.fn_confirm_payment(tests.nv('oa4'), tests.nv('a_cash'), null, 'adv-inst-pay-a004')::text;
select tests.clear_auth();
-- B runs on the Starter plan (features.installments = false); the cross-tenant fixtures need B vouchers, so B is on Growth until the
-- plan-gate test below
update public.subscriptions set plan_id = (select id from public.plans where name = 'Growth') where restaurant_id = (select b from _f);
select tests.authenticate_as((select b_admin from _f));
insert into _n select 'vb1', public.fn_generate_voucher(tests.nv('ob1'), 'Second Customer Name', '+251 922 470002', 5, tests.nv('b_cash'), null, 2, 7, 'adv-inst-gen-b001')::text;
select tests.clear_auth();
create temp table _snap on commit drop as select tests.snapshot((select a from _f)) a, tests.counts((select a from _f)) ac, tests.counts((select b from _f)) bc;
grant all on _snap to public;

-- ═════════ anon, service_role, platform admin, internal builders ═════════
select tests.as_anon();
select is(tests.run(format($q$select public.fn_generate_voucher(%L, 'Anon Person', null, 0, null, null, 2, 7, 'adv-anon-gen-01')$q$, tests.nv('oa3'))),
          '42501|permission denied for function fn_generate_voucher|', 'anon: no EXECUTE on fn_generate_voucher');
select is(tests.run(format($q$select public.fn_confirm_installment(%L, %L, null, 'adv-anon-col-01')$q$, tests.vid('va1'), tests.nv('a_cash'))),
          '42501|permission denied for function fn_confirm_installment|', 'anon: no EXECUTE on fn_confirm_installment');
select is(tests.run(format($q$select public.fn_get_voucher(%L)$q$, tests.vid('va1'))),
          '42501|permission denied for function fn_get_voucher|', 'anon: no EXECUTE on fn_get_voucher');
select is(tests.run($q$select public.fn_list_vouchers()$q$), '42501|permission denied for function fn_list_vouchers|', 'anon: no EXECUTE on fn_list_vouchers');
select is(tests.run($q$select count(*) from public.vouchers$q$) || ' ' || tests.run($q$select count(*) from public.installments$q$),
          '42501|permission denied for table vouchers| 42501|permission denied for table installments|', 'anon: no SELECT on vouchers / installments');
select tests.clear_auth();
select ok(not has_function_privilege('anon', 'public.fn_voucher_json(uuid, uuid)', 'execute')
          and not has_function_privilege('service_role', 'public.fn_voucher_json(uuid, uuid)', 'execute')
          and not has_function_privilege('anon', 'public.fn_tenant_today(uuid)', 'execute')
          and not has_function_privilege('service_role', 'public.fn_tenant_today(uuid)', 'execute')
          and not has_function_privilege('authenticated', 'public.fn_receipt_json(uuid, uuid)', 'execute')
          and not has_function_privilege('anon', 'public.fn_audit_row()', 'execute'),
          'the voucher / receipt builders and the tenant clock are internal (anon, authenticated, service_role)');
select tests.authenticate_as_service_role();
select is(tests.run(format($q$select public.fn_voucher_json(%L, %L)$q$, tests.vid('va1'), (select a from _f))), '42501|permission denied for function fn_voucher_json|',
          'service_role cannot call the internal voucher builder');
select is(tests.run(format($q$select public.fn_get_voucher(%L)$q$, tests.vid('va1'))), '42501|permission denied for function fn_get_voucher|',
          'service_role: no EXECUTE on fn_get_voucher (granted to authenticated only)');
select tests.clear_auth();
select tests.aal2((select super_admin from _f));
select is(tests.oracle($q$select public.fn_get_voucher({id})$q$, tests.vid('va1')), 'P0001|permission_denied|',
          'platform super admin (no tenant profile): fn_get_voucher permission_denied, real id = unknown id');
select is(tests.oracle(format($q$select public.fn_confirm_installment({id}, %L, null, 'adv-plat-col-01')$q$, tests.nv('a_cash')), tests.vid('va1')), 'P0001|permission_denied|',
          'platform super admin cannot collect an installment (no oracle)');
select is(tests.oracle($q$select public.fn_generate_voucher({id}, 'Platform Person', null, 0, null, null, 2, 7, 'adv-plat-gen-01')$q$, tests.nv('oa3')), 'P0001|permission_denied|',
          'platform super admin cannot issue a tenant voucher (no oracle)');
select is(tests.run($q$select public.fn_list_vouchers()$q$), 'P0001|permission_denied|', 'platform super admin cannot list tenant vouchers');
select is(tests.oracle($q$select public.fn_get_receipt({id})$q$, tests.dpid('va1')), 'P0001|permission_denied|',
          'platform super admin cannot read a down-payment receipt (no oracle)');
select is((select count(*)::int from public.vouchers) + (select count(*)::int from public.installments), 0, 'platform super admin selects no voucher / installment row');
select tests.clear_auth();

-- ═════════ IDOR B -> A (real foreign ids vs unknown ids) ═════════
select tests.authenticate_as((select b_admin from _f));
select is(tests.oracle($q$select public.fn_get_voucher({id})$q$, tests.vid('va1')), 'P0001|not_found|', 'B admin reading A''s voucher: not_found, no oracle');
select is(tests.oracle(format($q$select public.fn_confirm_installment({id}, %L, null, 'adv-idor-col-b01')$q$, tests.nv('b_cash')), tests.vid('va1')), 'P0001|not_found|',
          'B admin collecting on A''s voucher with its own method: not_found, no oracle');
select is(tests.oracle(format($q$select public.fn_confirm_installment(%L, {id}, null, 'adv-idor-col-b02')$q$, tests.vid('vb1')), tests.nv('a_cash')), 'P0001|invalid_input|payment_method_id',
          'B admin collecting its own voucher with A''s payment method: same answer as an unknown method');
select is(tests.oracle($q$select public.fn_generate_voucher({id}, 'Cross Tenant', null, 0, null, null, 2, 7, 'adv-idor-gen-b01')$q$, tests.nv('oa3')), 'P0001|not_found|',
          'B admin issuing a voucher on A''s order: not_found, no oracle');
select is(tests.oracle(format($q$select public.fn_generate_voucher(%L, 'Cross Tenant', null, 5, {id}, null, 2, 7, 'adv-idor-gen-b02')$q$, tests.nv('ob2')), tests.nv('a_cash')), 'P0001|invalid_input|down_method_id',
          'B admin using A''s payment method as its down method: same answer as an unknown method');
select is(tests.oracle($q$select public.fn_get_receipt({id})$q$, tests.dpid('va1')), 'P0001|not_found|', 'B admin reading A''s down-payment receipt: not_found, no oracle');
select is(tests.oracle($q$select public.fn_get_receipt({id})$q$, tests.pid('ca21')), 'P0001|not_found|', 'B admin reading A''s installment receipt: not_found, no oracle');
select is((select count(*)::int from jsonb_array_elements(public.fn_list_vouchers()) j where (j ->> 'id')::uuid in (tests.vid('va1'), tests.vid('va2'))), 0,
          'fn_list_vouchers for B lists none of A''s vouchers');
select is((select count(*)::int from public.vouchers where restaurant_id = (select a from _f)) + (select count(*)::int from public.installments where restaurant_id = (select a from _f)), 0,
          'B admin selects no A voucher / installment row (RLS, also the Realtime filter)');
-- idempotency key values reused ACROSS TENANTS: fresh executions in B, never A's documents
insert into _n select 'vb3', public.fn_generate_voucher(tests.nv('ob3'), 'Key Reuse Customer', null, 0, null, null, 2, 7, 'adv-inst-gen-a001')::text;
select is((tests.jv('vb3') ->> 'replayed') || '|' || (tests.jv('vb3') -> 'voucher' ->> 'order_id'), 'false|' || tests.nv('ob3'),
          'B reusing A''s voucher key value: a fresh voucher for B''s own order, not a replay of A''s');
insert into _n select 'cb11', public.fn_confirm_installment(tests.vid('vb1'), tests.nv('b_cash'), null, 'adv-inst-col-a001', 1)::text;
select is((tests.jv('cb11') ->> 'replayed') || '|' || (tests.jv('cb11') -> 'voucher' ->> 'voucher_no') || '|' || (tests.jv('cb11') -> 'restaurant' ->> 'name'),
          'false|' || (tests.jv('vb1') -> 'voucher' ->> 'voucher_no') || '|' || (select name from public.restaurants where id = (select b from _f)),
          'B reusing A''s installment key value: B''s own collection with B''s identity on the receipt');
select tests.clear_auth();
select is((select restaurant_id from public.vouchers where id = tests.vid('vb3')), (select b from _f), 'the key-reuse voucher belongs to B');
select is(tests.snapshot((select a from _f)), (select a from _snap), 'tenant A unchanged by every refused B attempt and by B''s key reuse');
select tests.authenticate_as((select b_waiter from _f));
select is(tests.oracle($q$select public.fn_get_voucher({id})$q$, tests.vid('va1')), 'P0001|permission_denied|', 'B waiter (no vouchers rights) on A''s voucher: permission_denied, no oracle');
select tests.clear_auth();

-- ═════════ IDOR A -> B ═════════
create temp table _snapb on commit drop as select tests.snapshot((select b from _f)) b;
grant all on _snapb to public;
select tests.aal2((select a_admin from _f));
select is(tests.oracle($q$select public.fn_get_voucher({id})$q$, tests.vid('vb1')), 'P0001|not_found|', 'A admin reading B''s voucher: not_found, no oracle');
select is(tests.oracle(format($q$select public.fn_confirm_installment({id}, %L, null, 'adv-idor-col-a01')$q$, tests.nv('a_cash')), tests.vid('vb1')), 'P0001|not_found|',
          'A admin collecting on B''s voucher: not_found, no oracle');
select is(tests.oracle($q$select public.fn_generate_voucher({id}, 'Cross Tenant', null, 0, null, null, 2, 7, 'adv-idor-gen-a01')$q$, tests.nv('ob2')), 'P0001|not_found|',
          'A admin issuing a voucher on B''s order: not_found, no oracle');
select is(tests.oracle($q$select public.fn_get_receipt({id})$q$, tests.dpid('vb1')), 'P0001|not_found|', 'A admin reading B''s down-payment receipt: not_found, no oracle');
select is(tests.oracle($q$select public.fn_reverse_payment({id}, 'cross tenant', 'adv-idor-rev-a01')$q$, tests.pid('cb11')), 'P0001|not_found|',
          'A admin (aal2) reversing B''s installment payment: not_found, no oracle');
select is(tests.oracle(format($q$select public.fn_confirm_installment({id}, %L, null, 'adv-inst-col-a001', 1)$q$, tests.nv('a_cash')), tests.vid('vb1')), 'P0001|idempotency_conflict|',
          'A admin reusing an A key against B''s voucher: conflict, the same answer as for an unknown voucher (neither A''s nor B''s receipt)');
select tests.clear_auth();
select is(tests.snapshot((select b from _f)), (select b from _snapb), 'tenant B unchanged by every refused A attempt');

-- ═════════ plan entitlement: a plan without installments issues no voucher (server-side, not just hidden in the UI) ═════════
update public.subscriptions set plan_id = (select id from public.plans where name = 'Starter') where restaurant_id = (select b from _f);
select tests.authenticate_as((select b_admin from _f));
select ok(tests.run(format($q$select public.fn_generate_voucher(%L, 'Starter Plan Customer', null, 0, null, null, 2, 7, 'adv-plan-gen-b001')$q$, tests.nv('ob2'))) = 'P0001|plan_feature_unavailable|installments',
          'Starter plan (plans.features.installments = false): fn_generate_voucher refuses');
select tests.clear_auth();
select is(tests.pay_status(tests.nv('ob2')), 'unpaid', '... and the order is not turned into an installment order');
update public.subscriptions set plan_id = (select id from public.plans where name = 'Growth') where restaurant_id = (select b from _f);

-- ═════════ role escalation ═════════
select tests.authenticate_as((select a_waiter from _f));
select is(tests.run(format($q$select public.fn_confirm_installment(%L, %L, null, 'adv-esc-col-w01')$q$, tests.vid('va1'), tests.nv('a_cash'))), 'P0001|permission_denied|',
          'waiter: no collection');
select is(tests.run(format($q$select public.fn_get_voucher(%L)$q$, tests.vid('va1'))) || ' ' || tests.run($q$select public.fn_list_vouchers()$q$),
          'P0001|permission_denied| P0001|permission_denied|', 'waiter: no voucher read, not even for the order the waiter took');
select is((select count(*)::int from public.vouchers) + (select count(*)::int from public.installments), 0, 'waiter: selects no voucher / installment row');
select is(tests.run(format($q$select public.fn_get_receipt(%L)$q$, tests.dpid('va1'))), 'P0001|permission_denied|', 'waiter: no down-payment receipt');
select tests.clear_auth();
select tests.authenticate_as((select a_kitchen from _f));
select is(tests.run(format($q$select public.fn_generate_voucher(%L, 'Kitchen Person', null, 0, null, null, 2, 7, 'adv-esc-gen-k01')$q$, tests.nv('oa3'))), 'P0001|permission_denied|',
          'station operator (orders.view only): no voucher');
select is(tests.run(format($q$select public.fn_confirm_installment(%L, %L, null, 'adv-esc-col-k01')$q$, tests.vid('va1'), tests.nv('a_cash'))) || ' ' ||
          tests.run(format($q$select public.fn_get_voucher(%L)$q$, tests.vid('va1'))), 'P0001|permission_denied| P0001|permission_denied|',
          'station operator: no collection, no voucher read');
select tests.clear_auth();
-- vouchers.view only: reads, never writes
select tests.authenticate_as((select a_vview from _f));
select is(public.fn_get_voucher(tests.vid('va1')) ->> 'voucher_no', tests.jv('va1') -> 'voucher' ->> 'voucher_no', 'vouchers.view only: reads a voucher');
select ok(jsonb_array_length(public.fn_list_vouchers()) >= 2, 'vouchers.view only: lists vouchers');
select is(tests.run(format($q$select public.fn_generate_voucher(%L, 'Viewer Person', null, 0, null, null, 2, 7, 'adv-esc-gen-v01')$q$, tests.nv('oa3'))), 'P0001|permission_denied|',
          'vouchers.view only: cannot issue a voucher');
select is(tests.run(format($q$select public.fn_confirm_installment(%L, %L, null, 'adv-esc-col-v01')$q$, tests.vid('va1'), tests.nv('a_cash'))), 'P0001|permission_denied|',
          'vouchers.view only: cannot collect');
select is(tests.run(format($q$select public.fn_get_receipt(%L)$q$, tests.dpid('va1'))), 'P0001|permission_denied|', 'vouchers.view only: no receipt (payments rights needed)');
select is((select count(*)::int from public.payments), 0, 'vouchers.view only: selects no payment row');
select is(tests.oracle($q$select public.fn_get_voucher({id})$q$, tests.vid('vb1')), 'P0001|not_found|', 'vouchers.view only: B''s voucher = not_found, no oracle');
select is(tests.run($q$insert into public.role_permissions (role_id, permission_id, restaurant_id) select ro.id, pm.id, ro.restaurant_id from public.roles ro, public.permissions pm where ro.name = 'Voucher Viewer' and pm.key in ('vouchers.manage', 'orders.view', 'orders.view_all')$q$),
          '42501|permission denied for table role_permissions|', 'vouchers.view only cannot grant itself vouchers.manage / orders.view');
select is(tests.run(format($q$update public.profiles set role_id = %L where id = auth.uid()$q$, tests.role_id('Cashier', 'central-cafe'))) !~ '^ok:[1-9]'
          and (select role_id from public.profiles where id = (select a_vview from _f)) = tests.role_id('Voucher Viewer', 'central-cafe'), true,
          'vouchers.view only cannot move itself to the Cashier role (still on its own role)');
select tests.clear_auth();
-- vouchers.manage WITHOUT orders.view
select tests.authenticate_as((select a_vmanage from _f));
select is(tests.run(format($q$select public.fn_generate_voucher(%L, 'Clerk Person', null, 0, null, null, 2, 7, 'adv-esc-gen-m01')$q$, tests.nv('oa3'))), 'P0001|permission_denied|',
          'vouchers.manage without orders.view: cannot issue a voucher');
select is(tests.run(format($q$select public.fn_confirm_installment(%L, %L, null, 'adv-esc-col-m01')$q$, tests.vid('va1'), tests.nv('a_cash'))), 'P0001|permission_denied|',
          'vouchers.manage without orders.view: cannot collect');
select is(tests.oracle($q$select public.fn_get_receipt({id})$q$, tests.dpid('va1')), 'P0001|not_found|',
          'vouchers.manage without orders.view: a voucher receipt = not_found, same as an unknown id');
select is(tests.run(format($q$select public.fn_get_voucher(%L)$q$, tests.vid('va1'))), 'P0001|permission_denied|', 'vouchers.manage without vouchers.view: no voucher read');
select is((select count(*)::int from public.vouchers), 0, 'vouchers.manage without vouchers.view: selects no voucher row');
select tests.clear_auth();
-- vouchers.manage + orders.view(_all) WITHOUT vouchers.view: collects, but never learns the customer's name or phone
select tests.authenticate_as((select a_collect from _f));
insert into _n select 'cc11', public.fn_confirm_installment(tests.vid('va1'), tests.nv('a_cash'), null, 'adv-esc-col-c01')::text;
select is((tests.jv('cc11') -> 'voucher' ->> 'installment_no') || '|' || coalesce(tests.jv('cc11') -> 'voucher' ->> 'customer_name', 'NULL'), '1|NULL',
          'collector without vouchers.view: collects installment 1, the receipt hides the customer''s name');
select ok(position('470001' in tests.jv('cc11')::text) = 0, '... and never carries the customer''s phone');
select is(public.fn_get_receipt(tests.pid('cc11')) -> 'voucher' ->> 'customer_name', null, 'collector reprints its own installment receipt: still no name');
select is(tests.oracle($q$select public.fn_get_receipt({id})$q$, tests.dpid('va1')), 'P0001|not_found|',
          'collector: the cashier''s down-payment receipt = not_found (only its own voucher payments)');
select is(tests.run(format($q$select public.fn_get_voucher(%L)$q$, tests.vid('va1'))) || ' ' || tests.run($q$select public.fn_list_vouchers()$q$),
          'P0001|permission_denied| P0001|permission_denied|', 'collector: no voucher read / list');
select is((select count(*)::int from public.vouchers) + (select count(*)::int from public.installments) + (select count(*)::int from public.payments), 0,
          'collector: selects no voucher / installment / payment row');
select tests.clear_auth();
-- payments.view WITHOUT vouchers.view
select tests.authenticate_as((select a_payview from _f));
select is((select (j -> 'voucher' ->> 'voucher_no') || '|' || coalesce(j -> 'voucher' ->> 'customer_name', 'NULL') from (select public.fn_get_receipt(tests.dpid('va1')) j) x),
          (tests.jv('va1') -> 'voucher' ->> 'voucher_no') || '|NULL', 'payments.view without vouchers.view: a voucher receipt shows the voucher number, customer_name null');
select ok(position('470001' in public.fn_get_receipt(tests.dpid('va1'))::text) = 0, '... and no phone');
select is(tests.run(format($q$select public.fn_get_voucher(%L)$q$, tests.vid('va1'))), 'P0001|permission_denied|', 'payments.view only: no voucher read');
select is((select count(*)::int from public.vouchers) + (select count(*)::int from public.installments), 0, 'payments.view only: selects no voucher / installment row');
select is(tests.run(format($q$select public.fn_confirm_installment(%L, %L, null, 'adv-esc-col-p01')$q$, tests.vid('va1'), tests.nv('a_cash'))), 'P0001|permission_denied|',
          'payments.view only: cannot collect');
select tests.clear_auth();
-- a voucher reader sees the name on the same receipt (the gate is the permission, not the receipt)
select tests.authenticate_as((select a_cashier from _f));
select is(public.fn_get_receipt(tests.dpid('va1')) -> 'voucher' ->> 'customer_name', 'Almaz Tesfaye Bekele', 'cashier (vouchers.view): the name is on the receipt');
select tests.clear_auth();
-- deactivated custom role / deactivated profile keep nothing
update public.roles set is_active = false where restaurant_id = (select a from _f) and name = 'Voucher Viewer';
select tests.authenticate_as((select a_vview from _f));
select is(tests.run(format($q$select public.fn_get_voucher(%L)$q$, tests.vid('va1'))) || ' ' || (select count(*)::int from public.vouchers),
          'P0001|permission_denied| 0', 'a deactivated custom role reads no voucher (RPC or table)');
select tests.clear_auth();
update public.roles set is_active = true where restaurant_id = (select a from _f) and name = 'Voucher Viewer';
update public.profiles set is_active = false where id = (select a_cashier from _f);
select tests.authenticate_as((select a_cashier from _f));
select is(tests.run(format($q$select public.fn_confirm_installment(%L, %L, null, 'adv-esc-col-c09')$q$, tests.vid('va1'), tests.nv('a_cash'))) || ' ' ||
          tests.run(format($q$select public.fn_generate_voucher(%L, 'Inactive Person', null, 0, null, null, 2, 7, 'adv-inst-gen-a001')$q$, tests.nv('oa1'))),
          'P0001|permission_denied| P0001|permission_denied|', 'a deactivated cashier can neither collect nor reuse its voucher key');
select tests.clear_auth();
update public.profiles set is_active = true where id = (select a_cashier from _f);

-- ═════════ tenant status ═════════
create temp table _cnt on commit drop as select tests.counts((select a from _f)) c;
grant all on _cnt to public;
update public.restaurants set status = 'past_due' where id = (select a from _f);
select tests.authenticate_as((select a_cashier from _f));
select is(tests.run(format($q$select public.fn_generate_voucher(%L, 'Past Due', null, 0, null, null, 2, 7, 'adv-st-gen-0001')$q$, tests.nv('oa5'))), 'P0001|tenant_read_only|',
          'past_due: no new voucher');
select is(tests.run(format($q$select public.fn_confirm_installment(%L, %L, null, 'adv-st-col-0001')$q$, tests.vid('va1'), tests.nv('a_cash'))), 'P0001|tenant_read_only|',
          'past_due: no collection');
select is(tests.run(format($q$select public.fn_generate_voucher(%L, 'Almaz Tesfaye Bekele', '+251 911 470001', 10, %L, null, 3, 7, 'adv-inst-gen-a001')$q$, tests.nv('oa1'), tests.nv('a_cash'))),
          'P0001|tenant_read_only|', 'past_due: not even a replay of an accepted voucher key (the guard runs first)');
select is(tests.run(format($q$select public.fn_get_voucher(%L)$q$, tests.vid('va1'))) || ' ' || tests.run($q$select public.fn_list_vouchers()$q$) || ' ' ||
          tests.run(format($q$select public.fn_get_receipt(%L)$q$, tests.dpid('va1'))), 'ok:1 ok:1 ok:1', 'past_due: vouchers and receipts stay readable');
select tests.clear_auth();
update public.restaurants set status = 'suspended' where id = (select a from _f);
select tests.authenticate_as((select a_cashier from _f));
select is(tests.run(format($q$select public.fn_generate_voucher(%L, 'Suspended', null, 0, null, null, 2, 7, 'adv-st-gen-0002')$q$, tests.nv('oa5'))) || ' ' ||
          tests.run(format($q$select public.fn_confirm_installment(%L, %L, null, 'adv-st-col-0002')$q$, tests.vid('va1'), tests.nv('a_cash'))),
          'P0001|tenant_suspended| P0001|tenant_suspended|', 'suspended: no voucher, no collection');
select is(tests.run(format($q$select public.fn_get_voucher(%L)$q$, tests.vid('va1'))) || ' ' || tests.run($q$select public.fn_list_vouchers()$q$) || ' ' ||
          tests.run(format($q$select public.fn_get_receipt(%L)$q$, tests.dpid('va1'))), 'P0001|tenant_suspended| P0001|tenant_suspended| P0001|tenant_suspended|',
          'suspended: no voucher read, no list, no receipt');
select tests.clear_auth();
select tests.authenticate_as((select a_admin from _f));
select is(tests.run($q$select public.fn_list_vouchers()$q$), 'P0001|tenant_suspended|', 'suspended: the tenant admin is locked out too');
select tests.clear_auth();
update public.restaurants set status = 'cancelled' where id = (select a from _f);
select tests.authenticate_as((select a_cashier from _f));
select is(tests.run(format($q$select public.fn_get_voucher(%L)$q$, tests.vid('va1'))), 'P0001|tenant_suspended|', 'cancelled: no voucher read');
select tests.clear_auth();
update public.restaurants set status = 'active' where id = (select a from _f);
select is(tests.counts((select a from _f)), (select c from _cnt), 'past_due / suspended / cancelled: no voucher, payment, installment or audit row written');

-- ═════════ overpayment / double collection (va2: 2 installments, #1 collected in the fixtures) ═════════
select tests.authenticate_as((select a_cashier from _f));
select is(tests.run(format($q$select public.fn_confirm_installment(%L, %L, null, 'adv-seq-col-0001', 1)$q$, tests.vid('va2'), tests.nv('a_cash'))), 'P0001|invalid_installment_no|2',
          'an already-collected installment number with a new key: refused (double payment)');
select is(tests.run(format($q$select public.fn_confirm_installment(%L, %L, null, 'adv-seq-col-0002', 3)$q$, tests.vid('va2'), tests.nv('a_cash'))), 'P0001|invalid_installment_no|2',
          'a later installment out of order: refused');
select is(tests.run(format($q$select public.fn_confirm_installment(%L, %L, null, 'adv-seq-col-0003', 0)$q$, tests.vid('va2'), tests.nv('a_cash'))) || ' ' ||
          tests.run(format($q$select public.fn_confirm_installment(%L, %L, null, 'adv-seq-col-0004', 61)$q$, tests.vid('va2'), tests.nv('a_cash'))),
          'P0001|invalid_installment_no| P0001|invalid_installment_no|', 'installment numbers out of range: refused');
select is(tests.run(format($q$select public.fn_confirm_installment(%L, %L, 'TB-47', 'adv-seq-col-0005', null, 100000)$q$, tests.vid('va2'), tests.nv('a_tele'))), 'P0001|invalid_input|tendered',
          'tendered on a non-drawer method: refused');
select is(tests.run(format($q$select public.fn_confirm_installment(%L, %L, null, 'adv-seq-col-0006', null, 0)$q$, tests.vid('va2'), tests.nv('a_cash'))) || ' ' ||
          tests.run(format($q$select public.fn_confirm_installment(%L, %L, null, 'adv-seq-col-0007', null, 100.001)$q$, tests.vid('va2'), tests.nv('a_cash'))) || ' ' ||
          tests.run(format($q$select public.fn_confirm_installment(%L, %L, null, 'adv-seq-col-0008', null, -5)$q$, tests.vid('va2'), tests.nv('a_cash'))),
          'P0001|invalid_input|tendered P0001|invalid_input|tendered P0001|invalid_input|tendered', 'zero / sub-cent / negative tendered: refused');
select is(tests.run(format($q$select public.fn_confirm_installment(%L, %L, null, 'adv-seq-col-0009')$q$, tests.vid('va2'), gen_random_uuid())), 'P0001|invalid_input|payment_method_id',
          'an unknown payment method: refused');
select is((select string_agg(no || ':' || paid, ',' order by no) from public.installments where voucher_id = tests.vid('va2')) || '|' ||
          (select count(*)::int from public.payments where voucher_id = tests.vid('va2')), '1:true,2:false|1', 'the refused attempts changed no installment and wrote no payment');
insert into _n select 'ca22', public.fn_confirm_installment(tests.vid('va2'), tests.nv('a_cash'), null, 'adv-seq-col-0010', 2, 100000)::text;
select is((tests.jv('ca22') ->> 'amount')::numeric || '|' || (tests.jv('ca22') ->> 'change')::numeric || '|' || (tests.jv('ca22') ->> 'voucher_status'),
          (select amount || '|' || (100000 - amount) || '|settled' from public.installments where voucher_id = tests.vid('va2') and no = 2),
          'a large tendered amount: the scheduled amount is charged, the rest is change, the voucher is settled');
select is(tests.run(format($q$select public.fn_confirm_installment(%L, %L, null, 'adv-seq-col-0011')$q$, tests.vid('va2'), tests.nv('a_cash'))) || ' ' ||
          tests.run(format($q$select public.fn_confirm_installment(%L, %L, null, 'adv-seq-col-0012', 2)$q$, tests.vid('va2'), tests.nv('a_cash'))) || ' ' ||
          tests.run(format($q$select public.fn_confirm_installment(%L, %L, 'TB-48', 'adv-seq-col-0013')$q$, tests.vid('va2'), tests.nv('a_tele'))),
          'P0001|voucher_already_settled| P0001|voucher_already_settled| P0001|voucher_already_settled|', 'a settled voucher takes no further payment (any key, number or method)');
select is((select (j ->> 'replayed') || '|' || (j ->> 'payment_id') || '|' || (j ->> 'voucher_status')
           from (select public.fn_confirm_installment(tests.vid('va2'), tests.nv('a_cash'), null, 'adv-inst-col-a001', 1) j) x),
          'true|' || tests.pid('ca21') || '|settled', 'replaying installment 1''s key after settlement: the same payment, the current status, nothing new');
select is((select count(*)::int || '|' || sum(amount) from public.payments where voucher_id = tests.vid('va2') and kind = 'installment_payment'),
          '2|' || tests.order_total(tests.nv('oa2')), 'exactly two installment payments summing to the order total (no overpayment)');
select is((select (j ->> 'outstanding')::numeric || '|' || (j ->> 'paid_amount')::numeric from (select public.fn_get_voucher(tests.vid('va2')) j) x),
          '0|' || tests.order_total(tests.nv('oa2')), 'voucher: nothing outstanding, paid = total');
select is(tests.run(format($q$select public.fn_confirm_payment(%L, %L, null, 'adv-seq-pay-0001')$q$, tests.nv('oa2'), tests.nv('a_cash'))) || ' ' ||
          tests.run(format($q$select public.fn_generate_voucher(%L, 'Second Voucher', null, 0, null, null, 2, 7, 'adv-seq-gen-0001')$q$, tests.nv('oa2'))),
          'P0001|order_not_payable|installment P0001|order_not_payable|installment', 'a settled voucher''s order cannot be paid again nor get a second voucher');
select is(tests.run(format($q$select public.fn_generate_voucher(%L, 'Paid Order', null, 0, null, null, 2, 7, 'adv-seq-gen-0002')$q$, tests.nv('oa4'))), 'P0001|order_not_payable|paid',
          'an order already paid in full cannot be turned into a voucher (double collection)');
select is(tests.run(format($q$select public.fn_generate_voucher(%L, 'Sub Cent', null, 1.001, %L, null, 2, 7, 'adv-seq-gen-0003')$q$, tests.nv('oa5'), tests.nv('a_cash'))),
          'P0001|invalid_input|down_payment', 'a sub-cent down payment is refused');
select is(tests.run(format($q$select public.fn_generate_voucher(%L, 'Over Down', null, %s, %L, null, 2, 7, 'adv-seq-gen-0004')$q$, tests.nv('oa5'), tests.order_total(tests.nv('oa5')) + 1, tests.nv('a_cash'))),
          'P0001|invalid_input|down_payment', 'a down payment above the total is refused (overpayment)');
select tests.clear_auth();
select is((select count(*)::int from pg_proc p where p.oid = 'public.fn_confirm_installment'::regproc
           and not ('p_amount' = any (coalesce(p.proargnames, '{}')))) || '|' ||
          (select count(*)::int from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'fn_confirm_installment'),
          '1|1', 'fn_confirm_installment has exactly one signature and no client amount argument');
select tests.aal2((select a_admin from _f));
select is(tests.run(format($q$select public.fn_reverse_payment(%L, 'refund installment', 'adv-seq-rev-0001')$q$, tests.pid('ca22'))) || ' ' ||
          tests.run(format($q$select public.fn_reverse_payment(%L, 'refund down payment', 'adv-seq-rev-0002')$q$, tests.dpid('va1'))),
          'P0001|invalid_state|not_an_order_payment P0001|invalid_state|not_an_order_payment',
          'installment / down payments cannot be reversed through the order-payment reversal (the installment would stay paid)');
select tests.clear_auth();

-- ═════════ idempotency across users / tenants / commands ═════════
select tests.authenticate_as((select a_cashier from _f));
select is((select (j ->> 'replayed') || '|' || (j -> 'voucher' ->> 'id') || '|' || (j -> 'down_receipt' ->> 'payment_id')
           from (select public.fn_generate_voucher(tests.nv('oa1'), 'Almaz Tesfaye Bekele', '+251 911 470001', 10, tests.nv('a_cash'), null, 3, 7, 'adv-inst-gen-a001') j) x),
          'true|' || tests.vid('va1') || '|' || tests.dpid('va1'), 'the cashier replays its own voucher key: same voucher, same down receipt');
select is(tests.run(format($q$select public.fn_generate_voucher(%L, 'Almaz T Bekele', '+251 911 470001', 10, %L, null, 3, 7, 'adv-inst-gen-a001')$q$, tests.nv('oa1'), tests.nv('a_cash'))),
          'P0001|idempotency_conflict|', 'the same key with a different payload: conflict');
select tests.clear_auth();
select tests.authenticate_as((select a_admin from _f));
select is(tests.run(format($q$select public.fn_generate_voucher(%L, 'Almaz Tesfaye Bekele', '+251 911 470001', 10, %L, null, 3, 7, 'adv-inst-gen-a001')$q$, tests.nv('oa1'), tests.nv('a_cash'))),
          'P0001|idempotency_conflict|', 'another user reusing the cashier''s voucher key (same payload): conflict, never the cashier''s voucher');
select is(tests.run(format($q$select public.fn_generate_voucher(%L, 'Almaz Tesfaye Bekele', null, 0, null, null, 3, 7, 'adv-inst-gen-a001')$q$, tests.nv('oa5'))),
          'P0001|idempotency_conflict|', '... nor use it for another order');
select is(tests.run(format($q$select public.fn_confirm_installment(%L, %L, null, 'adv-inst-col-a001', 1)$q$, tests.vid('va2'), tests.nv('a_cash'))),
          'P0001|idempotency_conflict|', 'another user replaying the cashier''s installment key: conflict, never the cashier''s receipt');
select tests.clear_auth();
select tests.authenticate_as((select a_cashier from _f));
-- a key value already used by other commands (an order submission, a payment) is a separate namespace
insert into _n select 'va5', public.fn_generate_voucher(tests.nv('oa5'), 'Namespace Customer', '+251 911 470005', 0, null, null, 2, 7, 'adv-inst-order-0005')::text;
select is((tests.jv('va5') ->> 'replayed') || '|' || (tests.jv('va5') -> 'voucher' ->> 'order_id'), 'false|' || tests.nv('oa5'),
          'a voucher key equal to an order-submission key: a fresh voucher of the right order');
insert into _n select 'ca51', public.fn_confirm_installment(tests.vid('va5'), tests.nv('a_cash'), null, 'adv-inst-gen-a001')::text;
select is((tests.jv('ca51') ->> 'replayed') || '|' || (tests.jv('ca51') ->> 'kind') || '|' || (tests.jv('ca51') -> 'voucher' ->> 'installment_no'),
          'false|installment_payment|1', 'an installment key equal to a voucher key: a fresh collection, not the voucher''s replay');
select is(tests.run(format($q$select public.fn_confirm_installment(%L, %L, null, 'adv-inst-gen-a001')$q$, tests.vid('va1'), tests.nv('a_cash'))),
          'P0001|idempotency_conflict|', 'that installment key reused for another voucher: conflict (no collection on va1)');
select tests.clear_auth();
select is(tests.n_kind((select a from _f), 'down_payment') || '|' || (select count(*)::int from public.payments where voucher_id = tests.vid('va1')),
          '1|2', 'replays and conflicts wrote no second down payment and no extra va1 payment');

-- ═════════ audit integrity ═════════
select is(tests.ev_v('voucher.issued', tests.vid('va1')), 1, 'exactly one voucher.issued row for va1 (replays / conflicts / refusals wrote none)');
select is(tests.ev_actor('voucher.issued', tests.vid('va1')), (select a || '|' || a_cashier || '|user' from _f), 'voucher.issued: tenant A, actor = the cashier (from identity)');
select is(tests.ev_p('installment.collected', tests.pid('ca21')) || '|' || tests.ev_p('installment.collected', tests.pid('ca22')) || '|' || tests.ev_p('installment.collected', tests.pid('cc11')),
          '1|1|1', 'exactly one installment.collected row per collection (the replay wrote none)');
select is((select a.actor_id from public.audit_logs a where a.event = 'installment.collected' and a.new_data ->> 'payment_id' = tests.pid('cc11')::text), (select a_collect from _f),
          'installment.collected actor = the collector who took it');
select is(tests.ev_n((select a from _f), 'voucher.issued') || '|' || tests.ev_n((select a from _f), 'installment.collected'),
          (select count(*)::int from public.vouchers where restaurant_id = (select a from _f)) || '|' || tests.n_kind((select a from _f), 'installment_payment'),
          'tenant A: one voucher.issued per voucher and one installment.collected per installment payment');
select is(tests.ev_n((select b from _f), 'voucher.issued') || '|' || tests.ev_n((select b from _f), 'installment.collected'),
          (select count(*)::int from public.vouchers where restaurant_id = (select b from _f)) || '|' || tests.n_kind((select b from _f), 'installment_payment'),
          'tenant B: the same invariant (the key reuse wrote B rows only)');
select is((select count(*)::int from public.audit_logs where restaurant_id = (select b from _f)
           and (new_data ->> 'voucher_id' in (tests.vid('va1')::text, tests.vid('va2')::text) or record_id in (tests.vid('va1')::text, tests.vid('va2')::text))), 0,
          'no audit row about A''s vouchers lands in tenant B');
select is((select count(*)::int from public.audit_logs where audit_logs::text like '%470001%' or audit_logs::text like '%470002%' or audit_logs::text like '%470005%'
           or new_data ? 'customer_phone' or old_data ? 'customer_phone'), 0, 'no customer phone anywhere in audit_logs (event or row audit)');
select is((select count(*)::int from public.audit_logs where event = 'vouchers.insert' and record_id = tests.vid('va1')::text and new_data ->> 'customer_name' = 'Almaz Tesfaye Bekele'), 1,
          'the row audit of va1 exists (once) without its phone');
-- an owner-level phone change is not written to the immutable log either (only the stripped column changed)
update public.vouchers set customer_phone = '+251 911 479999' where id = tests.vid('va5');
select is((select count(*)::int from public.audit_logs where audit_logs::text like '%479999%'), 0, 'a phone correction leaves no phone in the audit log');
select tests.aal2((select a_admin from _f));
select is(tests.run(format($q$insert into public.audit_logs (restaurant_id, actor_id, actor_type, event, action, new_data) values (%L, %L, 'user', 'installment.collected', 'event', jsonb_build_object('voucher_id', %L::text))$q$,
          (select a from _f), (select a_cashier from _f), tests.vid('va1'))), '42501|permission denied for table audit_logs|', 'tenant admin cannot forge an installment.collected row');
select is(tests.run(format($q$update public.audit_logs set new_data = new_data || '{"amount": 1}' where new_data ->> 'voucher_id' = %L$q$, tests.vid('va1'))) || ' ' ||
          tests.run(format($q$delete from public.audit_logs where new_data ->> 'voucher_id' = %L$q$, tests.vid('va1'))),
          '42501|permission denied for table audit_logs| 42501|permission denied for table audit_logs|', 'nor edit or delete a voucher audit row');
select is(tests.run($q$select public.fn_write_audit('voucher.issued', '{}'::jsonb)$q$) ~ '^42501\|', true, 'the audit writer is not client-callable (no forged voucher.issued)');
select tests.clear_auth();
select is(tests.run(format($q$update public.audit_logs set new_data = '{}' where event = 'voucher.issued' and new_data ->> 'voucher_id' = %L$q$, tests.vid('va1'))) || ' ' ||
          tests.run(format($q$delete from public.audit_logs where event = 'voucher.issued' and new_data ->> 'voucher_id' = %L$q$, tests.vid('va1'))),
          'P0001|immutable_record|audit_logs P0001|immutable_record|audit_logs', 'the owner role cannot edit or delete a voucher audit row either');

-- ═════════ client writes on vouchers / installments: refused for every role ═════════
create temp table _probe on commit drop as select
  '42501|permission denied for table vouchers| / 42501|permission denied for table vouchers| / 42501|permission denied for table vouchers| / '
  || '42501|permission denied for table installments| / 42501|permission denied for table installments| / 42501|permission denied for table installments|' e,
  tests.v_row(tests.vid('va1')) va1, tests.v_row(tests.vid('va2')) va2;
grant all on _probe to public;
select tests.authenticate_as((select a_waiter from _f));
select is(tests.write_probe(tests.vid('va1')), (select e from _probe), 'waiter: no UPDATE / DELETE / INSERT on vouchers or installments');
select tests.clear_auth();
select tests.authenticate_as((select a_cashier from _f));
select is(tests.write_probe(tests.vid('va1')), (select e from _probe), 'cashier (vouchers.manage): no direct write, RPC only');
select tests.clear_auth();
select tests.authenticate_as((select a_vview from _f));
select is(tests.write_probe(tests.vid('va1')), (select e from _probe), 'vouchers.view only: no direct write');
select tests.clear_auth();
select tests.authenticate_as((select a_collect from _f));
select is(tests.write_probe(tests.vid('va2')), (select e from _probe), 'collector: no direct write');
select tests.clear_auth();
select tests.aal2((select a_admin from _f));
select is(tests.write_probe(tests.vid('va2')), (select e from _probe), 'tenant admin (aal2): no direct write');
select tests.clear_auth();
select tests.aal2((select b_admin from _f));
select is(tests.write_probe(tests.vid('va1')), (select e from _probe), 'foreign tenant admin (aal2): no direct write on A''s voucher');
select tests.clear_auth();
select is(tests.v_row(tests.vid('va1')) || tests.v_row(tests.vid('va2')), (select va1 || va2 from _probe), 'va1 / va2 and their schedules are byte-for-byte unchanged');

-- ═════════ owner level: backstops, append-only payments, restricted deletes, tenant lock ═════════
select matches(tests.run(format($q$insert into public.payments (restaurant_id, day_session_id, order_id, voucher_id, installment_no, kind, amount, payment_method_id, method_name_snapshot, method_affects_drawer_snapshot, receipt_no, created_by) select restaurant_id, day_session_id, order_id, voucher_id, installment_no, kind, amount, payment_method_id, method_name_snapshot, method_affects_drawer_snapshot, 'RCT-947001', created_by from public.payments where id = %L$q$, tests.pid('ca21'))),
               '^23505\|duplicate key value violates unique constraint "payments_one_installment_payment_idx"\|', 'backstop: a second payment row for the same installment is refused even at owner level');
select matches(tests.run(format($q$insert into public.payments (restaurant_id, day_session_id, order_id, voucher_id, kind, amount, payment_method_id, method_name_snapshot, method_affects_drawer_snapshot, receipt_no, created_by) select restaurant_id, day_session_id, order_id, voucher_id, kind, amount, payment_method_id, method_name_snapshot, method_affects_drawer_snapshot, 'RCT-947002', created_by from public.payments where id = %L$q$, tests.dpid('va1'))),
               '^23505\|duplicate key value violates unique constraint "payments_one_down_payment_idx"\|', 'backstop: a second down payment row for the same voucher is refused even at owner level');
select is(tests.run(format($q$update public.payments set amount = 0.01 where id = %L$q$, tests.pid('ca21'))) || ' ' ||
          tests.run(format($q$delete from public.payments where id = %L$q$, tests.dpid('va1'))),
          'P0001|immutable_record|payments P0001|immutable_record|payments', 'installment / down payments are append-only at owner level');
select matches(tests.run(format($q$delete from public.vouchers where id = %L$q$, tests.vid('va1'))), '^23503\|update or delete on table "vouchers" violates foreign key constraint "(payments|installments)_voucher_fk"',
               'deleting a voucher with a schedule and payments: a dependency error (ON DELETE RESTRICT, no cascade)');
select matches(tests.run(format($q$delete from public.orders where id = %L$q$, tests.nv('oa1'))), '^23503\|', 'deleting an order on a voucher: a dependency error');
select matches(tests.run(format($q$delete from public.payment_methods where id = %L$q$, tests.nv('a_cash'))), '^23503\|.*violates foreign key constraint "(vouchers_down_method_fk|payments_[a-z_]+)"',
               'deleting the down-payment method: a dependency error');
select is(tests.run(format($q$update public.vouchers set restaurant_id = %L where id = %L$q$, (select b from _f), tests.vid('va1'))), 'P0001|tenant_change_forbidden|vouchers',
          'a voucher cannot be moved to another tenant, even at owner level');
select is(tests.run(format($q$update public.installments set restaurant_id = %L where voucher_id = %L$q$, (select b from _f), tests.vid('va1'))), 'P0001|tenant_change_forbidden|installments',
          'nor its installments');
select is(tests.v_row(tests.vid('va1')), (select va1 from _probe), 'va1 unchanged by the refused owner-level attempts');

-- ═════════ owner level after the day closes: the voucher freezes with its order's day ═════════
update public.day_sessions set status = 'closed', closed_at = now(), closed_by = (select a_admin from _f), order_count = 0, gross_collected = 0, cash_collected = 0,
       cash_expenses = 0, expenses_total = 0, expected_cash = 0, counted_cash = 0, cash_variance = 0, net_profit = 0, inventory_variance = 0,
       station_snapshot = '[]', expense_snapshot = '[]', payment_snapshot = '[]'
where restaurant_id = (select a from _f) and status = 'open';
select is(tests.run(format($q$update public.vouchers set customer_name = 'Edited After Close', total = 1 where id = %L$q$, tests.vid('va1'))), 'P0001|day_closed|',
          'closed day: the voucher cannot be edited');
select is(tests.run(format($q$update public.installments set amount = 0.01 where voucher_id = %L and no = 3$q$, tests.vid('va1'))) || ' ' ||
          tests.run(format($q$delete from public.installments where voucher_id = %L and no = 3$q$, tests.vid('va1'))),
          'P0001|day_closed| P0001|day_closed|', 'closed day: an unpaid installment cannot be re-priced or deleted');
select is(tests.run(format($q$update public.installments set paid = false, paid_at = null, payment_id = null where voucher_id = %L and no = 2$q$, tests.vid('va2'))),
          'P0001|day_closed|', 'closed day: a collected installment cannot be un-paid');
select is(tests.run(format($q$update public.installments set paid = true, paid_at = now(), payment_id = %L where voucher_id = %L and no = 3$q$, tests.dpid('va1'), tests.vid('va1'))),
          'P0001|day_closed|', 'closed day: an unpaid installment cannot be marked paid with a payment of the closed day (only a new open-day payment settles it)');
select is(tests.run(format($q$update public.installments set payment_id = %L where voucher_id = %L and no = 1$q$, tests.pid('ca22'), tests.vid('va2'))),
          'P0001|day_closed|', 'closed day: a collected installment cannot be re-pointed to another payment');
select tests.authenticate_as((select a_cashier from _f));
select is(tests.run(format($q$select public.fn_confirm_installment(%L, %L, null, 'adv-cls-col-0001')$q$, tests.vid('va1'), tests.nv('a_cash'))) || ' ' ||
          tests.run(format($q$select public.fn_generate_voucher(%L, 'No Day', null, 0, null, null, 2, 7, 'adv-cls-gen-0001')$q$, tests.nv('oa3'))),
          'P0001|day_closed|no open business day P0001|day_closed|no open business day', 'no open day: no collection, no voucher');
select is((select (j ->> 'voucher_no') || '|' || (j ->> 'paid_installments')
           from (select public.fn_get_voucher(tests.vid('va1')) j) x), (tests.jv('va1') -> 'voucher' ->> 'voucher_no') || '|1', 'no open day: the voucher stays readable');
select tests.clear_auth();
select is(tests.v_row(tests.vid('va1')) || tests.v_row(tests.vid('va2')), (select va1 || va2 from _probe), 'va1 / va2 unchanged after the close');

-- ═════════ Realtime ═════════
select is((select string_agg(relname || ':' || relreplident::text, ',' order by relname) from pg_class
           where oid in ('public.vouchers'::regclass, 'public.installments'::regclass)), 'installments:f,vouchers:f',
          'Realtime: vouchers / installments publish full rows (tenant filter on restaurant_id works on UPDATE)');
select is((select count(*)::int from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename in ('vouchers', 'installments')), 2,
          'Realtime: both tables are published (delivery is filtered by the vouchers.view RLS policies proven above)');

select * from finish();
rollback;
