-- M4 audit coverage, M5/SL4 validation, expense date + category snapshot, L4 idempotency, L6, L7 invariants,
-- M9 foreign-key indexes, SL3 non-escalation, SL5 column exposure.
begin;
select plan(60);

create temp table _f on commit drop as
select tests.tenant_id('central-cafe') a, tests.tenant_id('second-cafe') b,
       tests.user_id('selam', 'central-cafe') admin, tests.user_id('yonas', 'central-cafe') waiter,
       tests.user_id('hanna', 'central-cafe') cashier, tests.user_id('abebe', 'central-cafe') kitchen,
       tests.user_id('owner', 'second-cafe') b_admin,
       (select id from public.payment_methods where restaurant_id = tests.tenant_id('central-cafe') and name = 'Cash') pm_cash,
       (select id from public.payment_methods where restaurant_id = tests.tenant_id('central-cafe') and name = 'Telebirr') pm_tele,
       (select id from public.expense_categories where restaurant_id = tests.tenant_id('central-cafe') and name = 'Rent') ec_rent,
       (select id from public.stations where restaurant_id = tests.tenant_id('central-cafe') and name = 'Kitchen') st_kitchen,
       (select id from public.stations where restaurant_id = tests.tenant_id('central-cafe') and name = 'Bar') st_bar,
       (select id from public.menu_items where restaurant_id = tests.tenant_id('central-cafe') and name = 'Doro Wat') mi_kitchen,
       (select id from public.menu_items where restaurant_id = tests.tenant_id('central-cafe') and name = 'Macchiato') mi_bar,
       (select id from public.tables where restaurant_id = tests.tenant_id('central-cafe') and label = 'T02') t2,
       (select id from public.tables where restaurant_id = tests.tenant_id('central-cafe') and label = 'T03') t3,
       (select id from public.ingredients where restaurant_id = tests.tenant_id('central-cafe') limit 1) ing,
       (select id from public.recipe_lines where restaurant_id = tests.tenant_id('central-cafe') limit 1) rl,
       (select id from public.day_sessions where restaurant_id = tests.tenant_id('central-cafe') and status = 'open') day1;
grant all on _f to public;
grant execute on all functions in schema tests to public;

-- ═════════ M4 audit coverage ═════════
update public.ingredients set min_level = min_level + 1 where id = (select ing from _f);
update public.recipe_lines set qty_per_serving = qty_per_serving + 0.001 where id = (select rl from _f);
insert into public.tables (restaurant_id, table_area_id, label) select a, (select id from public.table_areas where restaurant_id = a limit 1), 'Z99' from _f;
select is((select count(*)::int from public.audit_logs where event = 'ingredients.update'), 1, 'ingredients are audited');
select is((select count(*)::int from public.audit_logs where event = 'recipe_lines.update'), 1, 'recipe_lines are audited');
select is((select count(*)::int from public.audit_logs where event = 'tables.insert' and new_data ->> 'label' = 'Z99'), 1, 'tables are audited');
select is((select string_agg(distinct c.relname, ',' order by c.relname) from pg_trigger g join pg_class c on c.oid = g.tgrelid
           where g.tgname = 'trg_audit' and c.relname in ('vouchers', 'installments', 'ingredients', 'recipe_lines', 'tables')),
          'ingredients,installments,recipe_lines,tables,vouchers', 'audit triggers exist on vouchers and installments too');

-- ═════════ M5 / SL4 validation ═════════
select is(tests.run(format($q$update public.restaurants set timezone = 'Mars/Olympus' where id = %L$q$, (select a from _f))), 'P0001|invalid_timezone|', 'unknown timezone refused');
select is(tests.run(format($q$update public.restaurants set timezone = 'Africa/Nairobi' where id = %L$q$, (select a from _f))), 'ok:1', 'a real tz database name is accepted');
update public.restaurants set timezone = 'Africa/Addis_Ababa' where id = (select a from _f);
select matches(tests.run(format($q$update public.restaurants set vat_rate = 101 where id = %L$q$, (select a from _f))), '^23514\|', 'vat_rate > 100 refused');
select matches(tests.run(format($q$update public.restaurants set vat_rate = -1 where id = %L$q$, (select a from _f))), '^23514\|', 'vat_rate < 0 refused');
select matches(tests.run(format($q$update public.restaurants set opening_float = -5 where id = %L$q$, (select a from _f))), '^23514\|', 'negative opening_float refused');
select tests.authenticate_as((select admin from _f));
select is(tests.run($q$update public.restaurants set timezone = 'Nowhere/City'$q$), 'P0001|invalid_timezone|', 'tenant admin cannot set a bogus timezone either');
select tests.clear_auth();

-- ═════════ expense date / category snapshot ═════════
select tests.authenticate_as((select admin from _f));
select is(tests.run(format($q$insert into public.expenses (restaurant_id, expense_category_id, payment_method_id, amount, description) values (%L, %L, %L, 50, 'e1')$q$, (select a from _f), (select ec_rent from _f), (select pm_cash from _f))), 'ok:1', 'expense without a date is accepted');
select is(tests.run(format($q$insert into public.expenses (restaurant_id, expense_category_id, payment_method_id, amount, expense_date) values (%L, %L, %L, 50, date '2001-01-01')$q$, (select a from _f), (select ec_rent from _f), (select pm_cash from _f))), 'P0001|invalid_expense_date|', 'a client-supplied date that is not the business date is refused');
select tests.clear_auth();
select is((select expense_date from public.expenses where description = 'e1'),
          (select (d.opened_at at time zone r.timezone)::date from public.day_sessions d join public.restaurants r on r.id = d.restaurant_id where d.id = (select day1 from _f)),
          'expense_date = the open day''s business date in the tenant timezone');
select is((select category_name_snapshot from public.expenses where description = 'e1'), 'Rent', 'category name snapshot is stored');
update public.expense_categories set name = 'Premises' where id = (select ec_rent from _f);
update public.expenses set amount = 51 where description = 'e1';
select is((select category_name_snapshot from public.expenses where description = 'e1'), 'Rent', 'a category rename does not rewrite the snapshot (even on a later edit)');
select is(tests.run($q$update public.expenses set expense_date = date '2001-01-01' where description = 'e1'$q$), 'P0001|invalid_expense_date|', 'the date of an expense cannot be moved');
-- timezone drives the business date (day opened 23:30 UTC)
alter table public.day_sessions disable trigger trg_guard_day_session;
update public.day_sessions set opened_at = timestamptz '2026-10-03 23:30:00+00' where id = (select day1 from _f);
alter table public.day_sessions enable trigger trg_guard_day_session;
insert into public.expenses (restaurant_id, expense_category_id, payment_method_id, amount, description) select a, ec_rent, pm_cash, 5, 'tz-addis' from _f;
update public.restaurants set timezone = 'Pacific/Honolulu' where id = (select a from _f);
insert into public.expenses (restaurant_id, expense_category_id, payment_method_id, amount, description) select a, ec_rent, pm_cash, 5, 'tz-honolulu' from _f;
update public.restaurants set timezone = 'Africa/Addis_Ababa' where id = (select a from _f);
select is((select expense_date from public.expenses where description = 'tz-addis'), date '2026-10-04', 'Addis Ababa (UTC+3): 23:30 UTC is already the 4th');
select is((select expense_date from public.expenses where description = 'tz-honolulu'), date '2026-10-03', 'Honolulu (UTC-10): still the 3rd');

-- ═════════ L6 closed-day consistency ═════════
select matches(tests.run(format($q$update public.day_sessions set status = 'closed', closed_at = now(), closed_by = %L, order_count = 0, gross_collected = 0, cash_collected = 0, cash_expenses = 0, expenses_total = 0, expected_cash = 0, counted_cash = 0, cash_variance = 0, net_profit = 0, station_snapshot = '[]', expense_snapshot = '[]' where id = %L$q$, (select admin from _f), (select day1 from _f))),
               '^23514\|', 'closing without payment_snapshot / inventory_variance is refused');

-- ═════════ L4 idempotency ═════════
select set_config('request.jwt.claims', json_build_object('sub', (select admin from _f), 'role', 'authenticated')::text, true);
select is(tests.run($q$select public.fn_idempotency_begin('key-0000001', 'submit_order', null)$q$), 'P0001|invalid_input|request_hash', 'null payload hash refused');
select is(tests.run($q$select public.fn_idempotency_begin('key-0000001', 'submit_order', '   ')$q$), 'P0001|invalid_input|request_hash', 'blank payload hash refused');
select is(public.fn_idempotency_begin('key-0000001', 'submit_order', 'hash-A'), null::jsonb, 'first execution proceeds');
select is((public.fn_idempotency_begin('key-0000001', 'submit_order', 'hash-A') ->> 'replay')::boolean, true, 'same key + command + payload is a replay');
select is(tests.run($q$select public.fn_idempotency_begin('key-0000001', 'submit_order', 'hash-B')$q$), 'P0001|idempotency_conflict|', 'same key, different payload: conflict');
select is(public.fn_idempotency_begin('key-0000001', 'confirm_payment', 'hash-B'), null::jsonb, 'keys are scoped by command: the same key under another command is independent');
select public.fn_idempotency_complete('key-0000001', 'submit_order', '{"ok": true}');
select is(public.fn_idempotency_begin('key-0000001', 'submit_order', 'hash-A') -> 'result', '{"ok": true}'::jsonb, 'replay returns the stored result of THAT command');
select is(public.fn_idempotency_begin('key-0000001', 'confirm_payment', 'hash-B') -> 'result', 'null'::jsonb, 'and not the other command''s');
select set_config('request.jwt.claims', '', true);

-- ═════════ L7 invariants ═════════
insert into public.orders (restaurant_id, day_session_id, order_no, created_by, subtotal, vat_rate_snapshot, vat_amount, total)
  select a, day1, 'ORD-0001', waiter, 420, 15, 63, 483 from _f;
create temp table _o on commit drop as select id from public.orders where order_no = 'ORD-0001' and restaurant_id = (select a from _f);
grant all on _o to public;
-- station snapshot
select is(tests.run(format($q$insert into public.order_items (restaurant_id, order_id, menu_item_id, name_snapshot, price_snapshot, qty, station_id, station_name_snapshot) values (%L, %L, %L, 'x', 1, 1, %L, 'Bar')$q$, (select a from _f), (select id from _o), (select mi_kitchen from _f), (select st_bar from _f))),
          'P0001|station_mismatch|order_items.station_id must equal menu_items.station_id', 'order_items.station_id must be the menu item''s station');
select is(tests.run(format($q$insert into public.order_items (restaurant_id, order_id, menu_item_id, name_snapshot, price_snapshot, qty, station_id, station_name_snapshot) values (%L, %L, %L, 'x', 1, 1, %L, 'Kitchen')$q$, (select a from _f), (select id from _o), (select mi_kitchen from _f), (select st_kitchen from _f))), 'ok:1', 'matching station is accepted');
select is((select station_ids from public.orders where id = (select id from _o)), array[(select st_kitchen from _f)], 'orders.station_ids follows the first item');
select is(tests.run(format($q$insert into public.order_items (restaurant_id, order_id, menu_item_id, name_snapshot, price_snapshot, qty, station_id, station_name_snapshot) values (%L, %L, %L, 'm', 1, 1, %L, 'Bar')$q$, (select a from _f), (select id from _o), (select mi_bar from _f), (select st_bar from _f))), 'ok:1', 'a Bar item is added to the same order');
select is((select cardinality(station_ids) from public.orders where id = (select id from _o)), 2, 'a second station is added');
delete from public.order_items where menu_item_id = (select mi_bar from _f) and order_id = (select id from _o);
select is((select station_ids from public.orders where id = (select id from _o)), array[(select st_kitchen from _f)], 'and removed again when its last item goes');
-- table / session
insert into public.table_sessions (restaurant_id, table_id, day_session_id) select a, t2, day1 from _f;
select is(tests.run(format($q$insert into public.orders (restaurant_id, day_session_id, order_no, created_by, table_id, table_session_id, subtotal, vat_rate_snapshot, vat_amount, total) values (%L, %L, 'ORD-0002', %L, %L, (select id from public.table_sessions where table_id = %L), 1, 15, 0.15, 1.15)$q$, (select a from _f), (select day1 from _f), (select waiter from _f), (select t3 from _f), (select t2 from _f))),
          'P0001|table_mismatch|orders.table_id must be the table of its table session', 'orders.table_id must match its table session');
select is(tests.run(format($q$insert into public.orders (restaurant_id, day_session_id, order_no, created_by, table_id, table_session_id, subtotal, vat_rate_snapshot, vat_amount, total) values (%L, %L, 'ORD-0003', %L, %L, (select id from public.table_sessions where table_id = %L), 1, 15, 0.15, 1.15)$q$, (select a from _f), (select day1 from _f), (select waiter from _f), (select t2 from _f), (select t2 from _f))), 'ok:1', 'consistent table + session accepted');
-- payment reversal
insert into public.payments (restaurant_id, day_session_id, order_id, kind, amount, payment_method_id, method_name_snapshot, method_affects_drawer_snapshot, receipt_no)
  select f.a, f.day1, o.id, 'order_payment', 100, f.pm_cash, 'Cash', true, 'RCT-0001' from _f f, _o o;
create temp table _p on commit drop as select id from public.payments where receipt_no = 'RCT-0001' and restaurant_id = (select a from _f);
grant all on _p to public;
select is(tests.run(format($q$insert into public.payments (restaurant_id, day_session_id, order_id, kind, amount, payment_method_id, method_name_snapshot, method_affects_drawer_snapshot, receipt_no, reversed_payment_id) values (%L, %L, %L, 'reversal', 101, %L, 'Cash', true, 'RCT-0002', %L)$q$, (select a from _f), (select day1 from _f), (select id from _o), (select pm_cash from _f), (select id from _p))),
          'P0001|invalid_reversal|amount exceeds the original', 'a reversal cannot exceed the original amount');
select is(tests.run(format($q$insert into public.payments (restaurant_id, day_session_id, order_id, kind, amount, payment_method_id, method_name_snapshot, method_affects_drawer_snapshot, receipt_no, reversed_payment_id) values (%L, %L, %L, 'reversal', 50, %L, 'Telebirr', false, 'RCT-0003', %L)$q$, (select a from _f), (select day1 from _f), (select id from _o), (select pm_tele from _f), (select id from _p))),
          'P0001|invalid_reversal|order / voucher / method must match the original', 'a reversal must use the original method');
select is(tests.run(format($q$insert into public.payments (restaurant_id, day_session_id, order_id, kind, amount, payment_method_id, method_name_snapshot, method_affects_drawer_snapshot, receipt_no, reversed_payment_id) values (%L, %L, null, 'reversal', 50, %L, 'Cash', true, 'RCT-0004', %L)$q$, (select a from _f), (select day1 from _f), (select pm_cash from _f), (select id from _p))),
          'P0001|invalid_reversal|order / voucher / method must match the original', 'a reversal must reference the same order');
select is(tests.run(format($q$insert into public.payments (restaurant_id, day_session_id, order_id, kind, amount, payment_method_id, method_name_snapshot, method_affects_drawer_snapshot, receipt_no, reversed_payment_id) values (%L, %L, %L, 'reversal', 100, %L, 'Cash', true, 'RCT-0005', %L)$q$, (select a from _f), (select day1 from _f), (select id from _o), (select pm_cash from _f), (select id from _p))), 'ok:1', 'an exact, matching reversal is accepted');
select is(tests.run(format($q$insert into public.payments (restaurant_id, day_session_id, order_id, kind, amount, payment_method_id, method_name_snapshot, method_affects_drawer_snapshot, receipt_no, reversed_payment_id) values (%L, %L, %L, 'reversal', 10, %L, 'Cash', true, 'RCT-0006', (select id from public.payments where receipt_no = 'RCT-0005'))$q$, (select a from _f), (select day1 from _f), (select id from _o), (select pm_cash from _f))),
          'P0001|invalid_reversal|cannot reverse a reversal', 'a reversal cannot be reversed');

-- ═════════ M9 foreign-key indexes ═════════
select is((select string_agg(c.conrelid::regclass || '.' || c.conname, ',' order by c.conrelid::regclass::text, c.conname)
           from pg_constraint c
           where c.contype = 'f' and c.connamespace = 'public'::regnamespace
             -- reviewed exceptions: tenant-root FKs (restaurants are never deleted) and actor columns (profiles are
             -- deactivated, never deleted; indexing them would tax every write of the busiest tables)
             and c.confrelid <> 'public.restaurants'::regclass
             and c.conname !~ '_(created|opened|closed|issued|revoked|cancelled)_by_fk$'
             and not exists (
               select 1 from pg_index i
               where i.indrelid = c.conrelid and i.indisvalid
                 and (
                   -- leading columns = the FK columns (any order)
                   ((i.indkey::int2[])[0:cardinality(c.conkey) - 1] @> c.conkey::int2[] and cardinality(c.conkey) <= i.indnkeyatts)
                   -- or the leading column(s) cover the non-tenant part of a (restaurant_id, x) composite FK
                   or (cardinality(c.conkey) = 2
                       and (i.indkey::int2[])[0] = (select k from unnest(c.conkey) k where k <> (select a.attnum from pg_attribute a where a.attrelid = c.conrelid and a.attname = 'restaurant_id'))))
             )),
          null, 'every foreign key is backed by an index (reviewed exceptions only)');
select ok(exists (select 1 from pg_indexes where indexname = 'stock_movements_day_idx')
          and exists (select 1 from pg_indexes where indexname = 'orders_table_session_idx')
          and exists (select 1 from pg_indexes where indexname = 'orders_customer_session_idx')
          and exists (select 1 from pg_indexes where indexname = 'table_sessions_day_idx')
          and exists (select 1 from pg_indexes where indexname = 'installments_payment_idx'), 'the five indexes from review M9 exist');

-- ═════════ SL3 non-escalation on user lifecycle ═════════
do $$
declare v_a uuid := tests.tenant_id('central-cafe'); v_role uuid; v_lead uuid; v_greeter uuid;
begin
  insert into public.roles (restaurant_id, name) values (v_a, 'Shift Lead') returning id into v_lead;
  insert into public.roles (restaurant_id, name) values (v_a, 'Greeter') returning id into v_greeter;
  insert into public.role_permissions (role_id, permission_id, restaurant_id)
    select v_lead, id, v_a from public.permissions where key in ('users.manage', 'users.view', 'orders.view');
  insert into public.role_permissions (role_id, permission_id, restaurant_id)
    select v_greeter, id, v_a from public.permissions where key in ('orders.view');
  perform tests.create_auth_user('00000000-0000-4000-8000-0000000000f1', 'lead@central-cafe.staff.cafeos.invalid');
  perform tests.create_auth_user('00000000-0000-4000-8000-0000000000f2', 'greeter@central-cafe.staff.cafeos.invalid');
  insert into public.profiles (id, restaurant_id, first_name, username, role_id, auth_method) values
    ('00000000-0000-4000-8000-0000000000f1', v_a, 'Lead', 'lead', v_lead, 'pin'),
    ('00000000-0000-4000-8000-0000000000f2', v_a, 'Greeter', 'greeter', v_greeter, 'pin');
end $$;
select tests.authenticate_as('00000000-0000-4000-8000-0000000000f1');
select is(tests.run(format($q$update public.profiles set is_active = false where id = %L$q$, (select cashier from _f))), 'P0001|permission_escalation|target holds rights the caller does not', 'users.manage cannot deactivate a user whose role holds rights the caller lacks');
select is(tests.run(format($q$update public.profiles set is_active = false where id = %L$q$, (select kitchen from _f))), 'P0001|permission_escalation|target holds rights the caller does not', '... nor a station user it has no station for');
select is(tests.run($q$update public.profiles set is_active = false where username = 'greeter'$q$), 'ok:1', 'but it can deactivate a user whose role it fully covers');
select is(tests.run($q$update public.profiles set first_name = 'Renamed' where username = 'greeter'$q$), 'ok:1', 'renaming is not gated by the rights comparison');
select tests.clear_auth();
select tests.authenticate_as((select admin from _f));
select is(tests.run(format($q$update public.profiles set is_active = false where id = %L$q$, (select cashier from _f))), 'ok:1', 'tenant_admin holds everything and may deactivate anyone (except the last admin)');
select tests.clear_auth();

-- ═════════ SL5 column / row exposure ═════════
select tests.authenticate_as((select waiter from _f));
select is(tests.run('select tin from public.restaurants'), '42501|permission denied for table restaurants|', 'restaurants.tin is not selectable');
select is(tests.run('select opening_float from public.restaurants'), '42501|permission denied for table restaurants|', 'restaurants.opening_float is not selectable');
select is(tests.run('select name, vat_rate, timezone from public.restaurants'), 'ok:1', 'the columns the app needs still are');
select is(tests.run('select public.fn_get_restaurant_settings()'), 'P0001|permission_denied|', 'waiter: fn_get_restaurant_settings denied');
select is((select count(*)::int from public.subscriptions), 0, 'waiter reads no subscription');
select is((select count(*)::int from public.day_sessions), 0, 'waiter reads no day_sessions row (cash float, snapshots)');
select is((select public.fn_get_open_day() ->> 'day_no'), '1', 'but gets the open day (id, day_no, opened_at) through fn_get_open_day');
select is((select (public.fn_get_open_day() - 'id' - 'day_no' - 'opened_at')::text), '{}', 'and nothing else');
select is((select public.fn_get_session_context() -> 'open_day' ->> 'day_no'), '1', 'session context carries the open day');
select tests.clear_auth();
update public.profiles set is_active = true where id = (select cashier from _f);
select tests.authenticate_as((select cashier from _f));
select is((select (public.fn_get_restaurant_settings() ->> 'opening_float')::numeric), 2500::numeric, 'cashier (reports.view): settings RPC returns opening_float');
select is((select public.fn_get_restaurant_settings() ->> 'tin'), '0032918475', 'and the TIN');
select is((select count(*)::int from public.day_sessions), 1, 'cashier (reports.view) reads day_sessions');
select tests.clear_auth();
select tests.authenticate_as((select admin from _f));
select is((select count(*)::int from public.subscriptions), 1, 'tenant admin (settings.manage) reads the subscription');
select tests.clear_auth();

select * from finish();
rollback;
