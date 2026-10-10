-- H3/SL1/SM1/L1/SL7/H2: closed-day freeze on every day-bound table, service_role privilege cuts, audit writer,
-- default-privilege canary, last-admin guard (single session; the concurrent race is scripts/db/race-tests.sh).
begin;
select plan(43);

create temp table _f on commit drop as
select tests.tenant_id('central-cafe') a, tests.tenant_id('second-cafe') b,
       tests.user_id('selam', 'central-cafe') admin, tests.user_id('dawit', 'central-cafe') admin2,
       tests.user_id('yonas', 'central-cafe') waiter,
       (select id from public.payment_methods where restaurant_id = tests.tenant_id('central-cafe') and name = 'Cash') pm_cash,
       (select id from public.stations where restaurant_id = tests.tenant_id('central-cafe') and name = 'Kitchen') st_kitchen,
       (select id from public.menu_items where restaurant_id = tests.tenant_id('central-cafe') and name = 'Doro Wat') mi,
       (select id from public.ingredients where restaurant_id = tests.tenant_id('central-cafe') limit 1) ing,
       (select id from public.tables where restaurant_id = tests.tenant_id('central-cafe') and label = 'T01') tbl,
       (select id from public.day_sessions where restaurant_id = tests.tenant_id('central-cafe') and status = 'open') day1;
grant all on _f to public;
create temp table _c (order_id uuid, voucher_id uuid, pay1 uuid, pay2 uuid, inst1 uuid, inst2 uuid, ts uuid, cs uuid, day2 uuid, qr uuid);
grant all on _c to public;
insert into _c (qr) select id from public.qr_credentials where table_id = (select tbl from _f) and status = 'active';

-- fixture on the OPEN day 1 (owner)
insert into public.orders (restaurant_id, day_session_id, order_no, created_by, subtotal, vat_rate_snapshot, vat_amount, total)
  select a, day1, 'ORD-0001', waiter, 420, 15, 63, 483 from _f;
update _c set order_id = (select id from public.orders where order_no = 'ORD-0001' and restaurant_id = (select a from _f));
insert into public.order_items (restaurant_id, order_id, menu_item_id, name_snapshot, price_snapshot, qty, station_id, station_name_snapshot)
  select f.a, c.order_id, f.mi, 'Doro Wat', 420, 1, f.st_kitchen, 'Kitchen' from _f f, _c c;
insert into public.payments (restaurant_id, day_session_id, order_id, kind, amount, payment_method_id, method_name_snapshot, method_affects_drawer_snapshot, receipt_no)
  select f.a, f.day1, c.order_id, 'order_payment', 100, f.pm_cash, 'Cash', true, 'RCT-0001' from _f f, _c c;
update _c set pay1 = (select id from public.payments where receipt_no = 'RCT-0001' and restaurant_id = (select a from _f));
insert into public.vouchers (restaurant_id, voucher_no, order_id, customer_name, total, installment_count, interval_days)
  select f.a, 'VCH-0001', c.order_id, 'Customer', 383, 2, 30 from _f f, _c c;
update _c set voucher_id = (select id from public.vouchers where voucher_no = 'VCH-0001' and restaurant_id = (select a from _f));
insert into public.installments (restaurant_id, voucher_id, no, due_date, amount)
  select f.a, c.voucher_id, g, current_date + g * 30, 100 from _f f, _c c, generate_series(1, 2) g;
update _c set inst1 = (select id from public.installments where voucher_id = _c.voucher_id and no = 1),
              inst2 = (select id from public.installments where voucher_id = _c.voucher_id and no = 2);
insert into public.table_sessions (restaurant_id, table_id, day_session_id)
  select a, tbl, day1 from _f;
update _c set ts = (select id from public.table_sessions where day_session_id = (select day1 from _f) and table_id = (select tbl from _f));
insert into public.customer_sessions (restaurant_id, table_session_id, qr_credential_id, session_token_hash, expires_at)
  select f.a, c.ts, c.qr, repeat('a', 64), now() + interval '1 hour' from _f f, _c c;
update _c set cs = (select id from public.customer_sessions where session_token_hash = repeat('a', 64));

-- close day 1, open day 2
update public.day_sessions set status = 'closed', closed_at = now(), closed_by = (select admin from _f), order_count = 1, gross_collected = 100,
  cash_collected = 100, cash_expenses = 0, expenses_total = 0, expected_cash = 2600, counted_cash = 2600, cash_variance = 0, net_profit = 100,
  inventory_variance = 0, station_snapshot = '[]', expense_snapshot = '[]', payment_snapshot = '[]' where id = (select day1 from _f);
insert into public.day_sessions (restaurant_id, day_no, opened_by) select a, 2, admin from _f;
update _c set day2 = (select id from public.day_sessions where restaurant_id = (select a from _f) and status = 'open');
insert into public.payments (restaurant_id, day_session_id, order_id, kind, amount, payment_method_id, method_name_snapshot, method_affects_drawer_snapshot, receipt_no)
  select f.a, c.day2, c.order_id, 'order_payment', 100, f.pm_cash, 'Cash', true, 'RCT-0002' from _f f, _c c;
update _c set pay2 = (select id from public.payments where receipt_no = 'RCT-0002' and restaurant_id = (select a from _f));

-- ═════════ the freeze (owner) ═════════
select is(tests.run(format($q$insert into public.orders (restaurant_id, day_session_id, order_no, created_by, subtotal, vat_rate_snapshot, vat_amount, total) values (%L, %L, 'ORD-0099', %L, 1, 15, 0.15, 1.15)$q$, (select a from _f), (select day1 from _f), (select waiter from _f))),
          'P0001|day_closed|', 'orders: INSERT into a closed day refused');
select is(tests.run(format($q$update public.orders set customer_note = 'late' where id = %L$q$, (select order_id from _c))), 'P0001|day_closed|', 'orders: UPDATE of a closed-day order refused');
select is(tests.run(format($q$delete from public.orders where id = %L$q$, (select order_id from _c))), 'P0001|day_closed|', 'orders: DELETE of a closed-day order refused');
select is(tests.run(format($q$insert into public.order_items (restaurant_id, order_id, menu_item_id, name_snapshot, price_snapshot, qty, station_id, station_name_snapshot) values (%L, %L, %L, 'x', 1, 1, %L, 'Kitchen')$q$, (select a from _f), (select order_id from _c), (select mi from _f), (select st_kitchen from _f))),
          'P0001|day_closed|', 'order_items: INSERT into a closed-day order refused');
select is(tests.run(format($q$update public.order_items set item_status = 'ready' where order_id = %L$q$, (select order_id from _c))), 'P0001|day_closed|', 'order_items: UPDATE on a closed-day order refused');
select is(tests.run(format($q$insert into public.payments (restaurant_id, day_session_id, order_id, kind, amount, payment_method_id, method_name_snapshot, method_affects_drawer_snapshot, receipt_no) values (%L, %L, %L, 'order_payment', 5, %L, 'Cash', true, 'RCT-0090')$q$, (select a from _f), (select day1 from _f), (select order_id from _c), (select pm_cash from _f))),
          'P0001|day_closed|', 'payments: INSERT into a closed day refused');
select is(tests.run(format($q$insert into public.stock_movements (restaurant_id, ingredient_id, station_id, qty_delta, reason, day_session_id) select restaurant_id, id, station_id, 1, 'manual_adjustment', %L from public.ingredients where id = %L$q$, (select day1 from _f), (select ing from _f))),
          'P0001|day_closed|', 'stock_movements: INSERT into a closed day refused');
select is(tests.run(format($q$insert into public.vouchers (restaurant_id, voucher_no, order_id, customer_name, total, installment_count, interval_days) values (%L, 'VCH-0099', %L, 'x', 1, 1, 1)$q$, (select a from _f), (select order_id from _c))),
          'P0001|day_closed|', 'vouchers: INSERT for a closed-day order refused');
select is(tests.run(format($q$update public.vouchers set customer_name = 'x' where id = %L$q$, (select voucher_id from _c))), 'P0001|day_closed|', 'vouchers: UPDATE refused');
select is(tests.run(format($q$insert into public.installments (restaurant_id, voucher_id, no, due_date, amount) values (%L, %L, 3, current_date, 1)$q$, (select a from _f), (select voucher_id from _c))),
          'P0001|day_closed|', 'installments: INSERT into a closed-day voucher refused');
select is(tests.run(format($q$update public.installments set amount = 1 where id = %L$q$, (select inst1 from _c))), 'P0001|day_closed|', 'installments: changing the schedule (amount) refused');
select is(tests.run(format($q$update public.installments set paid = true, paid_at = now(), payment_id = %L where id = %L$q$, (select pay1 from _c), (select inst2 from _c))),
          'P0001|day_closed|', 'installments: collection against a payment of a CLOSED day refused');
select is(tests.run(format($q$update public.installments set paid = true, paid_at = now(), payment_id = %L where id = %L$q$, (select pay2 from _c), (select inst1 from _c))),
          'ok:1', 'installments: collection with a payment of the OPEN day is the one allowed compensating path');
select is(tests.run(format($q$insert into public.table_sessions (restaurant_id, table_id, day_session_id, status, closed_at) values (%L, %L, %L, 'closed', now())$q$, (select a from _f), (select tbl from _f), (select day1 from _f))),
          'P0001|day_closed|', 'table_sessions: INSERT into a closed day refused');
select is(tests.run(format($q$update public.table_sessions set guest_count = 3 where id = %L$q$, (select ts from _c))), 'P0001|day_closed|', 'table_sessions: UPDATE refused');
select is(tests.run(format($q$insert into public.customer_sessions (restaurant_id, table_session_id, qr_credential_id, session_token_hash, expires_at) values (%L, %L, %L, repeat('b', 64), now())$q$, (select a from _f), (select ts from _c), (select qr from _c))),
          'P0001|day_closed|', 'customer_sessions: INSERT on a closed-day table session refused');
select is(tests.run(format($q$update public.customer_sessions set customer_name = 'late' where id = %L$q$, (select cs from _c))), 'P0001|day_closed|', 'customer_sessions: data edit refused');
select is(tests.run(format($q$update public.customer_sessions set status = 'expired' where id = %L$q$, (select cs from _c))), 'ok:1', 'customer_sessions: status/last_seen_at hygiene stays allowed');

-- service_role is no exception
select tests.authenticate_as_service_role();
select is(tests.run(format($q$insert into public.orders (restaurant_id, day_session_id, order_no, created_by, subtotal, vat_rate_snapshot, vat_amount, total) values (%L, %L, 'ORD-0098', %L, 1, 15, 0.15, 1.15)$q$, (select a from _f), (select day1 from _f), (select waiter from _f))),
          'P0001|day_closed|', 'service_role: closed-day order INSERT refused');
select is(tests.run(format($q$insert into public.orders (restaurant_id, day_session_id, order_no, created_by, subtotal, vat_rate_snapshot, vat_amount, total) values (%L, %L, 'ORD-0097', %L, 1, 15, 0.15, 1.15)$q$, (select a from _f), (select day2 from _c), (select waiter from _f))),
          'ok:1', 'service_role: an order on the open day still works');
select tests.clear_auth();

-- ═════════ SL1 service_role privilege cuts ═════════
select is((select string_agg(c.relname || ':' || p, ',' order by c.relname) from pg_class c, unnest(array['truncate', 'references', 'trigger']) p
           where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and has_table_privilege('service_role', c.oid, p)),
          null, 'service_role holds no TRUNCATE / REFERENCES / TRIGGER on any public table');
select is((select string_agg(c.relname || ':' || p, ',') from pg_class c, unnest(array['insert', 'update', 'delete']) p
           where c.relname in ('audit_logs', 'admin_audit_log') and c.relnamespace = 'public'::regnamespace and has_table_privilege('service_role', c.oid, p)),
          null, 'service_role cannot write the audit tables (definer writers only)');
select tests.authenticate_as_service_role();
select is(tests.run($q$insert into public.audit_logs (restaurant_id, actor_type, event, action) select id, 'system', 'forged', 'event' from public.restaurants limit 1$q$),
          '42501|permission denied for table audit_logs|', 'service_role cannot forge an audit row');
select is(tests.run($q$insert into public.admin_audit_log (action) values ('forged')$q$), '42501|permission denied for table admin_audit_log|', 'service_role cannot forge an admin audit row');
select ok(tests.run($q$select count(*) from public.audit_logs$q$) = 'ok:1', 'service_role can still read the audit trail');
select is(tests.run('truncate public.orders'), '42501|permission denied for table orders|', 'service_role cannot TRUNCATE business tables');
select tests.clear_auth();

-- ═════════ L1 fn_write_audit: actor = auth.uid(), nothing else ═════════
select is((select pg_get_function_identity_arguments(p.oid) from pg_proc p where p.proname = 'fn_write_audit' and p.pronamespace = 'public'::regnamespace),
          'p_event text, p_record jsonb, p_restaurant_id uuid', 'fn_write_audit has no actor parameter');
select is((select count(*)::int from pg_proc p where p.proname = 'fn_write_audit' and p.pronamespace = 'public'::regnamespace), 1, 'exactly one fn_write_audit overload');
select set_config('request.jwt.claims', json_build_object('sub', (select admin from _f), 'role', 'authenticated')::text, true);
select public.fn_write_audit('test.own', '{"k": 1}'::jsonb);
select is((select actor_id from public.audit_logs where event = 'test.own'), (select admin from _f), 'audit actor is auth.uid()');
select is((select actor_type from public.audit_logs where event = 'test.own'), 'user', 'audit actor type derived from the identity');
select is(tests.run(format($q$select public.fn_write_audit('test.foreign', null, %L)$q$, (select b from _f))), 'P0001|permission_denied|', 'a tenant user cannot write another tenant''s trail');
select set_config('request.jwt.claims', '', true);
select public.fn_write_audit('test.job', null, (select a from _f));
select is((select actor_type from public.audit_logs where event = 'test.job'), 'system', 'no auth.uid() => system actor (and no way to name one)');

-- ═════════ SM1 default privileges canary ═════════
create function public.fn_canary_probe() returns int language sql set search_path = '' as 'select 1';
select ok(not has_function_privilege('anon', 'public.fn_canary_probe()', 'execute'), 'a NEW public function is not executable by anon');
select ok(not has_function_privilege('authenticated', 'public.fn_canary_probe()', 'execute'), 'a NEW public function is not executable by authenticated');
select ok(not has_function_privilege('public', 'public.fn_canary_probe()', 'execute'), 'a NEW public function is not executable by PUBLIC');
select ok(not has_function_privilege('service_role', 'public.fn_canary_probe()', 'execute'), 'a NEW public function is not executable by service_role until granted');
select is(tests.run('select public.fn_canary_probe()'), 'ok:1', 'the owner can of course run it');
select ok(not has_function_privilege('anon', 'public.fn_err(text, text)', 'execute') and has_function_privilege('authenticated', 'public.fn_err(text, text)', 'execute')
          and has_function_privilege('service_role', 'public.fn_err(text, text)', 'execute'), 'fn_err: not anon, still authenticated + service_role');

-- ═════════ H2 last tenant_admin (single session) ═════════
select tests.authenticate_as((select admin from _f));
select lives_ok(format($q$select public.fn_set_user_active(%L, false)$q$, (select admin2 from _f)), 'one of two admins can be deactivated');
select is(tests.run(format($q$select public.fn_set_user_active(%L, false)$q$, (select admin from _f))), 'P0001|permission_denied|cannot change your own account state', 'nobody deactivates itself through the RPC');
select is(tests.run(format($q$select public.fn_change_user_role(%L, %L)$q$, (select admin from _f), (select id from public.roles where restaurant_id = (select a from _f) and name = 'Waiter'))),
          'P0001|last_tenant_admin|', 'nor demoted through fn_change_user_role');
select tests.clear_auth();
select is(tests.run(format($q$update public.profiles set is_active = false where id = %L$q$, (select admin from _f))), 'P0001|last_tenant_admin|', 'the last active admin cannot be deactivated on any path (trigger)');
select is((select count(*)::int from public.profiles p join public.roles r on r.id = p.role_id where p.restaurant_id = (select a from _f) and p.is_active and r.system_key = 'tenant_admin'), 1, 'exactly one active admin remains');

select * from finish();
rollback;
