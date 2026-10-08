-- Gap audit (pgTAP coverage review of migrations 0001-0020). Everything here was missing from files 00-23:
--   S1  forged JWT claims never influence tenant / role / platform identity
--   S2  an INACTIVE platform admin holds no platform power
--   S3  behavioural delete-restriction sweep over EVERY foreign key (dependency error, never a silent delete)
--   S4  exact client privilege matrix (table + column INSERT/UPDATE grants for anon / authenticated) is pinned
--   S5  every client-writable table is audited on INSERT, UPDATE and DELETE (tenant -> audit_logs, platform -> admin_audit_log)
--   S6  Storage policy guard (every policy must be tenant-prefix scoped; no public bucket)
--   S7  delegated users.manage cannot escalate through staff creation or PIN-lockout reset
--   S8  PIN lock-tier boundaries (3/6/9) and fn_pin_eligible truth table
begin;
select plan(61);

create temp table _f on commit drop as
select tests.tenant_id('central-cafe') a, tests.tenant_id('second-cafe') b,
       tests.user_id('selam', 'central-cafe') a_admin, tests.user_id('yonas', 'central-cafe') a_waiter,
       tests.user_id('meron', 'central-cafe') a_deleg, tests.user_id('hanna', 'central-cafe') a_cashier,
       tests.user_id('abebe', 'central-cafe') a_kitchen,
       tests.user_id('owner', 'second-cafe') b_admin, tests.user_id('waiter', 'second-cafe') b_waiter,
       tests.admin_role_id('central-cafe') a_admin_role, tests.admin_role_id('second-cafe') b_admin_role,
       tests.role_id('Waiter', 'central-cafe') a_waiter_role, tests.role_id('Cashier', 'central-cafe') a_cashier_role,
       tests.role_id('Kitchen', 'central-cafe') a_kitchen_role,
       (select id from public.stations where restaurant_id = tests.tenant_id('second-cafe') and name = 'Kitchen') b_station,
       (select id from public.stations where restaurant_id = tests.tenant_id('central-cafe') and name = 'Kitchen') a_station,
       '00000000-0000-4000-8000-0000000000c1'::uuid su1,
       '00000000-0000-4000-8000-0000000000c4'::uuid su_off,
       '00000000-0000-4000-8000-0000000000c5'::uuid sup_off;
grant all on _f to public;
grant execute on all functions in schema tests to public;

-- ═════════ S1: forged claims ═════════
-- A real JWT is signed, but a client can still ASK for anything through user_metadata at signup and a misconfigured hook could
-- copy it into the token. The database must decide tenant, role and platform standing from profiles / platform_admins only.
create function tests.forge_claims(p_uid uuid, p_extra jsonb) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    (jsonb_build_object('sub', p_uid, 'role', 'authenticated', 'aud', 'authenticated') || p_extra)::text, true);
end $$;
grant execute on function tests.forge_claims(uuid, jsonb) to public;

select tests.authenticate_as((select a_waiter from _f));
select tests.forge_claims((select a_waiter from _f), jsonb_build_object(
  'restaurant_id', (select b from _f), 'tenant_id', (select b from _f), 'role_id', (select b_admin_role from _f),
  'is_admin', true, 'is_tenant_admin', true, 'platform_role', 'platform_super_admin', 'aal', 'aal2',
  'app_metadata', jsonb_build_object('restaurant_id', (select b from _f), 'role', 'platform_super_admin',
                                     'role_id', (select b_admin_role from _f), 'is_platform_admin', true),
  'user_metadata', jsonb_build_object('restaurant_id', (select b from _f), 'role', 'tenant_admin')));
select is(public.current_restaurant_id(), (select a from _f), 'forged restaurant_id claims: tenant is still the profile''s own');
select is(public.current_role_id(), (select a_waiter_role from _f), 'forged role_id claims: role is still the profile''s own');
select ok(not public.is_tenant_admin() and not public.is_platform_admin() and not public.is_platform_super_admin(),
          'forged admin / platform claims grant neither tenant_admin nor platform standing');
select ok(not public.has_permission('settings.manage'), 'forged claims grant no permission');
select is((select count(*)::int from public.stations where restaurant_id = (select b from _f)), 0, 'forged claims: tenant B stations stay invisible');
select is((select count(*)::int from public.restaurants), 1, 'forged claims: only the own restaurants row is visible');
select is(tests.run(format($q$update public.stations set name = 'forged' where restaurant_id = %L$q$, (select b from _f))), 'ok:0', 'forged claims: writes into B change nothing');
select is(tests.run(format($q$select public.fn_suspend_tenant(%L, 'forged platform claim')$q$, (select b from _f))), 'P0001|permission_denied|', 'forged platform_role claim: fn_suspend_tenant refused');
select is((select public.fn_get_session_context() #>> '{restaurant,id}'), (select a::text from _f), 'forged claims: session context reports the real tenant');
select ok((select not (public.fn_get_session_context() ? 'platform_role')), 'forged claims: session context carries no platform_role');
select tests.clear_auth();

-- ═════════ S2: inactive platform admins ═════════
do $$ begin
  perform tests.create_auth_user('00000000-0000-4000-8000-0000000000c4', 'inactive.super@cafeos.example.com');
  perform tests.create_auth_user('00000000-0000-4000-8000-0000000000c5', 'inactive.support@cafeos.example.com');
end $$;
insert into public.platform_admins (id, full_name, role, is_active) values
  ('00000000-0000-4000-8000-0000000000c4', 'Former Super', 'platform_super_admin', false),
  ('00000000-0000-4000-8000-0000000000c5', 'Former Support', 'platform_support', false);

select tests.authenticate_as((select su1 from _f));
select ok((select count(*) from public.restaurants) >= 2 and public.is_platform_super_admin(), 'control: the ACTIVE super admin lists every tenant');
select tests.clear_auth();
select tests.authenticate_as((select su_off from _f));
select ok(not public.is_platform_admin() and not public.is_platform_super_admin(), 'inactive super admin: not a platform admin');
select is((select count(*)::int from public.restaurants), 0, 'inactive super admin lists no tenant');
select is((select count(*)::int from public.platform_admins where id <> (select su_off from _f)) + (select count(*)::int from public.admin_audit_log) + (select count(*)::int from public.subscriptions), 0,
          'inactive super admin reads no roster (only its own row, by design), no admin audit, no subscription');
select is(tests.run(format($q$select public.fn_suspend_tenant(%L, 'inactive platform admin')$q$, (select a from _f))), 'P0001|permission_denied|', 'inactive super admin cannot suspend');
select is(tests.run(format($q$select public.fn_reactivate_tenant(%L, 'inactive platform admin')$q$, (select a from _f))), 'P0001|permission_denied|', 'inactive super admin cannot reactivate');
select matches(tests.run($q$insert into public.plans (name, price_etb_monthly, max_staff, max_menu_items) values ('Forged', 1, 1, 1)$q$), '^42501\|', 'inactive super admin cannot create plans');
select is((select public.fn_get_session_context()), null, 'inactive super admin gets no session context (no platform_role)');
select tests.clear_auth();
select tests.authenticate_as((select sup_off from _f));
select ok(not public.is_platform_admin(), 'inactive support admin: not a platform admin');
select is((select count(*)::int from public.restaurants), 0, 'inactive support admin lists no tenant');
select tests.clear_auth();

-- ═════════ S3: delete restriction sweep over every FK ═════════
-- fixtures: make sure tenant B owns at least one row in EVERY tenant table (same shape as 10_idor_bola)
insert into public.ingredients (restaurant_id, name, station_id, unit, stock) select b, 'Flour B', b_station, 'kg', 5 from _f;
-- a menu item that ONLY the recipe uses (no order items), so recipe_lines_menu_fk is the single constraint in the way of deleting it
insert into public.menu_items (restaurant_id, name, category_id, station_id, price)
  select f.b, 'Recipe-only B', (select id from public.categories where restaurant_id = f.b limit 1), f.b_station, 5 from _f f;
insert into public.recipe_lines (restaurant_id, menu_item_id, ingredient_id, qty_per_serving)
  select f.b, (select id from public.menu_items where restaurant_id = f.b and name = 'Recipe-only B'), i.id, 1 from _f f join public.ingredients i on i.restaurant_id = f.b;
insert into public.table_sessions (restaurant_id, table_id, day_session_id, opened_by)
  select b, (select id from public.tables where restaurant_id = f.b limit 1), (select id from public.day_sessions where restaurant_id = f.b and status = 'open'), b_waiter from _f f;
insert into public.qr_credentials (restaurant_id, table_id, token_hash)
  select b, (select id from public.tables where restaurant_id = f.b limit 1), repeat('b', 64) from _f f;
insert into public.kiosk_devices (restaurant_id, name, token_hash, created_by) select b, 'B terminal', repeat('c', 64), b_admin from _f;
insert into public.user_notifications (restaurant_id, recipient_id, kind, payload) select b, b_waiter, 'security.concurrent_login_blocked', '{}'::jsonb from _f;
-- the 1:1 timer settings row exists for every tenant (0025); give it an actor so restaurant_session_settings_updated_by_fk has a victim
update public.restaurant_session_settings set updated_by = (select b_admin from _f) where restaurant_id = (select b from _f);
insert into public.qr_credentials (restaurant_id, table_id, token_hash, status, revoked_at, revoked_by, version)
  select b, (select id from public.tables where restaurant_id = f.b limit 1), repeat('d', 64), 'revoked', now(), b_admin, 2 from _f f;
insert into public.customer_sessions (restaurant_id, table_session_id, qr_credential_id, session_token_hash, expires_at)
  select f.b, ts.id, q.id, repeat('c', 64), now() + interval '1 hour'
  from _f f join public.table_sessions ts on ts.restaurant_id = f.b join public.qr_credentials q on q.restaurant_id = f.b and q.status = 'active';
insert into public.orders (restaurant_id, day_session_id, order_no, created_by, subtotal, vat_rate_snapshot, vat_amount, total, table_id, table_session_id, customer_session_id)
  select b, (select id from public.day_sessions where restaurant_id = f.b and status = 'open'), 'ORD-0001', b_waiter, 100, 15, 15, 115,
         ts.table_id, ts.id, cs.id
  from _f f join public.table_sessions ts on ts.restaurant_id = f.b join public.customer_sessions cs on cs.restaurant_id = f.b;
insert into public.orders (restaurant_id, day_session_id, order_no, created_by, subtotal, vat_rate_snapshot, vat_amount, total, status, cancelled_at, cancelled_by)
  select b, (select id from public.day_sessions where restaurant_id = f.b and status = 'open'), 'ORD-0002', b_waiter, 10, 15, 1.5, 11.5, 'cancelled', now(), b_admin from _f f;
insert into public.stock_movements (restaurant_id, ingredient_id, station_id, qty_delta, reason, day_session_id, created_by, order_id)
  select f.b, i.id, i.station_id, 5, 'opening', (select id from public.day_sessions where restaurant_id = f.b and status = 'open'), f.b_admin,
         (select id from public.orders where restaurant_id = f.b and order_no = 'ORD-0001')
  from _f f join public.ingredients i on i.restaurant_id = f.b;
insert into public.stock_movements (restaurant_id, ingredient_id, station_id, qty_delta, reason, day_session_id, reverses_movement_id)
  select m.restaurant_id, m.ingredient_id, m.station_id, -5, 'reversal', m.day_session_id, m.id from public.stock_movements m where m.restaurant_id = (select b from _f);
insert into public.order_items (restaurant_id, order_id, menu_item_id, name_snapshot, price_snapshot, qty, station_id, station_name_snapshot)
  select f.b, o.id, (select id from public.menu_items where restaurant_id = f.b and name <> 'Recipe-only B' order by id limit 1), 'Special', 100, 1, f.b_station, 'Kitchen'
  from _f f join public.orders o on o.restaurant_id = f.b and o.order_no = 'ORD-0001';
insert into public.vouchers (restaurant_id, voucher_no, order_id, customer_name, total, installment_count, interval_days, created_by, down_payment_method_id)
  select f.b, 'VCH-0001', o.id, 'Cust', 115, 2, 30, f.b_admin, (select id from public.payment_methods where restaurant_id = f.b and name = 'Cash')
  from _f f join public.orders o on o.restaurant_id = f.b and o.order_no = 'ORD-0001';
insert into public.payments (restaurant_id, day_session_id, order_id, kind, amount, payment_method_id, method_name_snapshot, method_affects_drawer_snapshot, receipt_no, created_by)
  select f.b, (select id from public.day_sessions where restaurant_id = f.b and status = 'open'), o.id, 'order_payment', 115,
         (select id from public.payment_methods where restaurant_id = f.b and name = 'Cash'), 'Cash', true, 'RCT-0001', f.b_admin
  from _f f join public.orders o on o.restaurant_id = f.b and o.order_no = 'ORD-0001';
insert into public.payments (restaurant_id, day_session_id, order_id, voucher_id, kind, amount, payment_method_id, method_name_snapshot, method_affects_drawer_snapshot, receipt_no)
  select f.b, p.day_session_id, p.order_id, v.id, 'down_payment', 10, p.payment_method_id, 'Cash', true, 'RCT-0002'
  from _f f join public.payments p on p.restaurant_id = f.b and p.receipt_no = 'RCT-0001' join public.vouchers v on v.restaurant_id = f.b;
insert into public.payments (restaurant_id, day_session_id, order_id, kind, amount, payment_method_id, method_name_snapshot, method_affects_drawer_snapshot, receipt_no, reversed_payment_id)
  select f.b, p.day_session_id, p.order_id, 'reversal', 5, p.payment_method_id, 'Cash', true, 'RCT-0003', p.id
  from _f f join public.payments p on p.restaurant_id = f.b and p.receipt_no = 'RCT-0001';
insert into public.installments (restaurant_id, voucher_id, no, due_date, amount)
  select f.b, v.id, 1, current_date + 30, 57.5 from _f f join public.vouchers v on v.restaurant_id = f.b;
insert into public.installments (restaurant_id, voucher_id, no, due_date, amount, paid, paid_at, payment_id)
  select f.b, v.id, 2, current_date + 60, 57.5, true, now(), (select id from public.payments where restaurant_id = f.b and receipt_no = 'RCT-0002')
  from _f f join public.vouchers v on v.restaurant_id = f.b;
insert into public.idempotency_keys (restaurant_id, key, command) select b, 'idem-key-000001', 'test' from _f;
insert into public.tenant_counters (restaurant_id, counter_key, last_value) select b, 'order', 1 from _f on conflict do nothing;
insert into public.platform_invoices (restaurant_id, subscription_id, amount, period_start, period_end, status)
  select b, (select id from public.subscriptions where restaurant_id = f.b), 990, current_date, current_date + 30, 'pending' from _f f;
insert into public.admin_audit_log (action, platform_admin_id, restaurant_id) select 'fixture.sweep', su1, b from _f;
insert into public.tenant_admin_invitations (restaurant_id, email, first_name, username, invited_by, invited_by_type, expires_at)
  select b, 'sweep@secondcafe.example.com', 'Sweep', 'sweep', b_admin, 'tenant_admin', now() + interval '1 day' from _f;
insert into public.day_sessions (restaurant_id, day_no, status, opened_by, closed_at, closed_by, order_count, gross_collected, cash_collected, cash_expenses,
                                 expenses_total, expected_cash, counted_cash, cash_variance, net_profit, station_snapshot, expense_snapshot, payment_snapshot, inventory_variance)
  select b, 900, 'closed', b_admin, now(), b_admin, 0, 0, 0, 0, 0, 0, 0, 0, 0, '[]', '[]', '[]', 0 from _f;
-- expenses: created through the client path so the BEFORE trigger files the real actor and the open day
select tests.authenticate_as((select b_admin from _f));
insert into public.expenses (restaurant_id, expense_category_id, payment_method_id, amount)
  select f.b, (select id from public.expense_categories where restaurant_id = f.b limit 1), (select id from public.payment_methods where restaurant_id = f.b and name = 'Cash'), 10 from _f f;
select tests.clear_auth();

-- For each FK: pick a parent row that has a child through THAT constraint, delete the parent, expect SQLSTATE 23503 raised by
-- THAT constraint (named, with a "still referenced" detail the UI can show). A delete that succeeds is rolled back by the sentinel.
create function tests.fk_delete_sweep() returns table (conname text, outcome text) language plpgsql as $$
declare
  c record; v_sql text; v_n bigint; v_state text; v_con text; v_detail text;
begin
  for c in
    select k.oid, k.conname::text cn, k.conrelid::regclass::text child, k.confrelid::regclass::text parent,
           (select string_agg(format('%I', a.attname), ',' order by u.ord) from unnest(k.conkey) with ordinality u(attnum, ord)
              join pg_attribute a on a.attrelid = k.conrelid and a.attnum = u.attnum) ccols,
           (select string_agg(format('%I', a.attname), ',' order by u.ord) from unnest(k.confkey) with ordinality u(attnum, ord)
              join pg_attribute a on a.attrelid = k.confrelid and a.attnum = u.attnum) pcols
    from pg_constraint k where k.contype = 'f' and k.connamespace = 'public'::regnamespace order by k.conname
  loop
    conname := c.cn;
    v_sql := format('delete from %s where (%s) in (select %s from %s where (%s) is not null limit 1)',
                    c.parent, c.pcols, c.ccols, c.child, c.ccols);
    begin
      execute v_sql;
      get diagnostics v_n = row_count;
      if v_n = 0 then outcome := 'no-victim'; else outcome := 'DELETED'; end if;
      raise exception using errcode = 'P0999', message = 'sweep_rollback';
    exception
      when sqlstate 'P0999' then null;   -- undo the (unexpected) delete
      when foreign_key_violation then
        get stacked diagnostics v_con = constraint_name, v_detail = pg_exception_detail;
        outcome := case when v_con = c.cn and v_detail ~ 'is still referenced from table' then 'restricted'
                        else 'blocked-by:' || coalesce(v_con, '?') end;
      when others then
        get stacked diagnostics v_state = returned_sqlstate;
        -- a BEFORE-trigger guard that is stricter than the FK (closed days, system roles) is fine, but named
        outcome := case when v_state = 'P0001' and sqlerrm in ('closed_day_immutable', 'system_role_protected', 'immutable_record', 'last_platform_super_admin')
                        then 'guarded:' || sqlerrm else 'other:' || v_state || ':' || sqlerrm end;
    end;
    return next;
  end loop;
end $$;
grant execute on function tests.fk_delete_sweep() to public;

select is((select count(*)::int from tests.fk_delete_sweep()), (select count(*)::int from pg_constraint where contype = 'f' and connamespace = 'public'::regnamespace),
          'the sweep visits every public foreign key');
select is((select string_agg(conname || '=' || outcome, ', ' order by conname) from tests.fk_delete_sweep() where outcome = 'no-victim'), null,
          'every foreign key has a victim row (the sweep is not vacuous)');
select is((select string_agg(conname || '=' || outcome, ', ' order by conname) from tests.fk_delete_sweep() where outcome = 'DELETED'), null,
          'no foreign key lets its parent be deleted while a child exists');
select is((select string_agg(conname || '=' || outcome, ', ' order by conname) from tests.fk_delete_sweep() where outcome like 'other:%'), null,
          'the only way a parent delete fails is a foreign-key violation (no trigger / privilege / cascade surprise)');
-- tenant_id -> restaurants constraints are all reported as blocked by whichever sibling fires first (the confdeltype pin in 14 covers each
-- individually); the business-record constraints below prove their own delete rule
select cmp_ok((select count(*)::int from tests.fk_delete_sweep() where outcome = 'restricted'), '>=', 20, 'at least 20 business-record constraints are proven individually (own constraint named in the error)');

-- the six dynamic domains + role, through the tenant_admin''s REAL DELETE grant: dependency error, and the row survives
select tests.authenticate_as((select b_admin from _f));
-- menu_items / ingredients: no client DELETE at all since 0029 (soft deactivation through the RPCs); the FK sweep above covers the owner
select is(tests.run(format($q$delete from public.ingredients where id = (select id from public.ingredients where restaurant_id = %L)$q$, (select b from _f))),
          '42501|permission denied for table ingredients|', 'ingredient cannot be deleted by a client (no DELETE grant; deactivate via fn_set_ingredient_active)');
select is(tests.run(format($q$delete from public.menu_items where id = (select menu_item_id from public.order_items where restaurant_id = %L limit 1)$q$, (select b from _f))),
          '42501|permission denied for table menu_items|', 'menu item cannot be deleted by a client (no DELETE grant; deactivate via fn_set_menu_item_active)');
select matches(tests.run(format($q$delete from public.tables where id = (select table_id from public.table_sessions where restaurant_id = %L limit 1)$q$, (select b from _f))),
               '^23503\|update or delete on table "tables" violates foreign key constraint', 'table with sessions / QR credentials cannot be deleted');
select tests.clear_auth();
select is((select count(*)::int from public.ingredients where restaurant_id = (select b from _f)), 1, 'the blocked ingredient still exists');
select matches(tests.run(format($q$delete from public.restaurants where id = %L$q$, (select b from _f))), '^23503\|update or delete on table "restaurants" violates foreign key constraint', 'a tenant with data cannot be deleted (even by the owner)');
select matches(tests.run($q$delete from public.plans where id = (select plan_id from public.subscriptions limit 1)$q$), '^23503\|update or delete on table "plans" violates foreign key constraint', 'a plan with subscriptions cannot be deleted');
select matches(tests.run(format($q$delete from public.profiles where id = %L$q$, (select b_waiter from _f))), '^(23503|P0001)\|', 'a staff profile with history cannot be deleted (dependency or guard error)');

-- ═════════ S4: exact client privilege matrix ═════════
create function tests.col_grants(p_role text, p_priv text) returns text language sql stable as $$
  select coalesce(string_agg(t, E'\n' order by t), '') from (
    select c.relname || ': ' || string_agg(a.attname, ',' order by a.attname) t
    from pg_class c join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and has_column_privilege(p_role, c.oid, a.attnum, p_priv)
    group by c.relname) s $$;
grant execute on function tests.col_grants(text, text) to public;
create function tests.tbl_grants(p_role text) returns text language sql stable as $$
  select coalesce(string_agg(t, E'\n' order by t), '') from (
    select c.relname || ': ' || string_agg(p, ',' order by p) t
    from pg_class c cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'v', 'm', 'p') and has_table_privilege(p_role, c.oid, p)
    group by c.relname) s $$;
grant execute on function tests.tbl_grants(text) to public;

select is(tests.col_grants('authenticated', 'insert'), $m$categories: color,description,icon,is_active,name,restaurant_id,sort_order
expense_categories: color,description,icon,is_active,name,restaurant_id,sort_order
expenses: amount,description,expense_category_id,expense_date,payment_method_id,restaurant_id
payment_methods: affects_cash_drawer,color,description,icon,is_active,name,requires_reference,restaurant_id,sort_order
stations: color,description,icon,is_active,name,restaurant_id,sort_order
table_areas: color,description,icon,is_active,name,restaurant_id,sort_order
tables: capacity,is_active,label,qr_enabled,restaurant_id,sort_order,status,table_area_id$m$,
  'authenticated: column INSERT grants are exactly the reviewed allowlist (no id, system_key, stock, actor, day, status of money rows)');
select is(tests.col_grants('authenticated', 'update'), $m$categories: color,description,icon,is_active,name,sort_order
expense_categories: color,description,icon,is_active,name,sort_order
expenses: amount,description,expense_category_id,expense_date,payment_method_id
payment_methods: affects_cash_drawer,color,description,icon,is_active,name,requires_reference,sort_order
stations: color,description,icon,is_active,name,sort_order
table_areas: color,description,icon,is_active,name,sort_order
tables: capacity,is_active,label,qr_enabled,sort_order,status,table_area_id$m$,
  'authenticated: column UPDATE grants are exactly the reviewed allowlist (never restaurant_id / role_id / auth_method / status / slug / stock)');
select is(tests.col_grants('anon', 'insert') || tests.col_grants('anon', 'update') || tests.col_grants('anon', 'references'), '', 'anon: no column INSERT / UPDATE / REFERENCES anywhere');
select is(tests.tbl_grants('anon'), 'plans: SELECT', 'anon: table privileges are exactly SELECT on plans');
select is(tests.tbl_grants('authenticated'), $m$admin_audit_log: SELECT
audit_logs: SELECT
categories: DELETE,SELECT
day_sessions: SELECT
expense_categories: DELETE,SELECT
expenses: DELETE,SELECT
ingredients: SELECT
installments: SELECT
menu_items: SELECT
order_items: SELECT
payment_methods: DELETE,SELECT
payments: SELECT
permissions: SELECT
plans: SELECT
platform_admins: SELECT
platform_invoices: SELECT
profiles: SELECT
recipe_lines: SELECT
role_permissions: SELECT
role_station_access: SELECT
roles: SELECT
stations: DELETE,SELECT
stock_movements: SELECT
subscriptions: SELECT
table_areas: DELETE,SELECT
table_sessions: SELECT
tables: DELETE,SELECT
vouchers: SELECT$m$,
  'authenticated: table-level privileges are exactly the reviewed set (no TRUNCATE / REFERENCES / TRIGGER; ledgers, orders, secrets, credentials have none beyond SELECT)');

-- ═════════ S5: audit coverage of every client-writable table ═════════
create function tests.unaudited_writable(p_fn text) returns text language sql stable as $$
  select string_agg(c.relname::text, ',' order by c.relname)
  from pg_class c
  where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
    and (has_any_column_privilege('authenticated', c.oid, 'insert') or has_any_column_privilege('authenticated', c.oid, 'update')
         or has_table_privilege('authenticated', c.oid, 'delete'))
    and (case when p_fn = 'fn_audit_row' then exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'restaurant_id' and not a.attisdropped)
                                               and c.relname not in ('plans', 'platform_invoices', 'subscriptions', 'platform_admins')
              else c.relname in ('plans', 'platform_invoices', 'subscriptions', 'platform_admins') end)
    and not exists (select 1 from pg_trigger t join pg_proc p on p.oid = t.tgfoid
                    where t.tgrelid = c.oid and not t.tgisinternal and p.proname = p_fn and t.tgenabled = 'O'
                      and (t.tgtype & 1) = 1 and (t.tgtype & 2) = 0   -- row level, AFTER
                      and (t.tgtype & 4) = 4 and (t.tgtype & 8) = 8 and (t.tgtype & 16) = 16) $$;
grant execute on function tests.unaudited_writable(text) to public;
-- restaurants has no restaurant_id column but its client UPDATE must be audited as well
select is(tests.unaudited_writable('fn_audit_row'), null, 'every client-writable tenant table has an enabled row-level AFTER INSERT/UPDATE/DELETE audit trigger (tenant audit_logs)');
select is(tests.unaudited_writable('fn_audit_admin_row'), null, 'every client-writable platform table has the same trigger into admin_audit_log');
select ok(exists (select 1 from pg_trigger t where t.tgrelid = 'public.restaurants'::regclass and t.tgname = 'trg_audit' and t.tgenabled = 'O' and (t.tgtype & 16) = 16),
          'restaurants (client UPDATE) has its audit trigger on UPDATE');
select is((select count(*)::int from public.audit_logs where restaurant_id is null), 0, 'no tenant audit row is filed without a tenant');

-- ═════════ S6: Storage guard ═════════
create function tests.storage_policy_gaps() returns text language sql stable as $$
  select string_agg(p.tablename || '.' || p.policyname, ',' order by p.tablename, p.policyname)
  from pg_policies p
  where p.schemaname = 'storage'
    and (p.roles && array['public', 'anon', 'authenticated']::name[])
    -- tenant scoped: must pin the object path to the caller's tenant folder (restaurants/<restaurant_id>/...)
    and not (coalesce(p.qual, '') || coalesce(p.with_check, '') ~ 'current_restaurant_id'
             and coalesce(p.qual, '') || coalesce(p.with_check, '') ~ 'restaurants') $$;
grant execute on function tests.storage_policy_gaps() to public;
select is(tests.storage_policy_gaps(), null, 'every Storage policy for clients pins the path to restaurants/<current_restaurant_id>/ (no policies exist before Phase 3)');
select is((select count(*)::int from storage.buckets where public), 0, 'no public Storage bucket (tenant files are served through policies or signed URLs)');
select is((select string_agg(p.tablename || '.' || p.policyname, ',') from pg_policies p where p.schemaname = 'storage' and p.roles && array['anon']::name[]), null, 'anon has no Storage policy');

-- ═════════ S7: delegated users.manage cannot escalate through staff creation / lockout reset ═════════
-- a delegated role holding ONLY users.manage + users.view, assigned to Meron by the admin
select tests.authenticate_as((select a_admin from _f));
select public.fn_create_role('{"name": "HR Lead"}');
select public.fn_create_role('{"name": "Viewer"}');
select public.fn_update_role_permissions((select id from public.roles where restaurant_id = (select a from _f) and name = 'HR Lead'), array['users.manage', 'users.view'], '{}');
select public.fn_update_role_permissions((select id from public.roles where restaurant_id = (select a from _f) and name = 'Viewer'), array['users.view'], '{}');
select public.fn_change_user_role((select a_deleg from _f), (select id from public.roles where restaurant_id = (select a from _f) and name = 'HR Lead'));
select tests.clear_auth();
do $$ begin
  perform tests.create_auth_user('00000000-0000-4000-8000-000000000201', 'viewer1@central-cafe.staff.cafeos.invalid');
  perform tests.create_auth_user('00000000-0000-4000-8000-000000000202', 'cashier2@central-cafe.staff.cafeos.invalid');
  update auth.users set raw_app_meta_data = '{"provider":"email","staff":true}' where id in ('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000202');
end $$;
update public.profile_secrets set failed_attempts = 7, locked_until = now() + interval '1 hour' where profile_id in ((select a_cashier from _f), (select a_kitchen from _f));
create temp table _s7 on commit drop as select tests.snapshot((select a from _f)) a;
grant all on _s7 to public;

select tests.authenticate_as((select a_deleg from _f));
select is(tests.run(format($q$select public.fn_prepare_staff_creation('viewer1', %L)$q$, (select a_cashier_role from _f))), 'P0001|permission_escalation|', 'delegate: fn_prepare_staff_creation with a role holding rights it lacks (Cashier)');
select is(tests.run(format($q$select public.fn_prepare_staff_creation('viewer1', %L)$q$, (select a_kitchen_role from _f))), 'P0001|permission_escalation|', 'delegate: ... nor the Kitchen role (rights and station)');
select is(tests.run(format($q$select public.fn_create_staff_profile('00000000-0000-4000-8000-000000000202', 'Cash', null, null, 'cashier2', %L)$q$, (select a_cashier_role from _f))), 'P0001|permission_escalation|', 'delegate: fn_create_staff_profile into the Cashier role is refused');
select is((select count(*)::int from public.profiles where id = '00000000-0000-4000-8000-000000000202'), 0, 'and no profile was created');
select is(tests.run(format($q$select public.fn_prepare_staff_creation('viewer1', %L)$q$, (select id from public.roles where restaurant_id = (select a from _f) and name = 'Viewer'))), 'ok:1', 'control: a role fully covered by the delegate''s own rights is allowed');
select is(tests.run(format($q$select public.fn_create_staff_profile('00000000-0000-4000-8000-000000000201', 'View', null, null, 'viewer1', %L)$q$, (select id from public.roles where restaurant_id = (select a from _f) and name = 'Viewer'))), 'ok:1', 'control: ... and the profile is created');
select is(tests.run(format($q$select public.fn_reset_pin_lockout(%L)$q$, (select a_cashier from _f))), 'P0001|permission_escalation|', 'delegate: cannot reset the lockout of a Cashier (rights it lacks)');
select is(tests.run(format($q$select public.fn_reset_pin_lockout(%L)$q$, (select a_kitchen from _f))), 'P0001|permission_escalation|', 'delegate: nor of Kitchen staff (rights and station it lacks)');
select tests.clear_auth();
select is((select count(*)::int from public.profile_secrets where profile_id in ((select a_cashier from _f), (select a_kitchen from _f)) and failed_attempts = 7 and locked_until > now()), 2, 'both locks are untouched');
select tests.authenticate_as_service_role();
select public.fn_set_user_pin('00000000-0000-4000-8000-000000000201', tests.pin_digest('4821'));
select tests.clear_auth();
select tests.authenticate_as((select a_deleg from _f));
select is(tests.run($q$select public.fn_reset_pin_lockout('00000000-0000-4000-8000-000000000201')$q$), 'ok:1', 'control: the delegate resets the lockout of a user whose role it fully covers');
select tests.clear_auth();
select is((select count(*)::int from public.audit_logs where event = 'user.created' and actor_id = (select a_deleg from _f)), 1, 'only the permitted creation was audited (with the delegate as actor)');

-- ═════════ S8: PIN lock tiers and eligibility ═════════
select is(public.fn_pin_lock_duration(0), null, 'tier: 0 failures, no lock');
select is(public.fn_pin_lock_duration(1), null, 'tier: 1 failure, no lock');
select is(array[public.fn_pin_lock_duration(4), public.fn_pin_lock_duration(5)], array[interval '15 minutes', interval '15 minutes'], 'tier: 4 and 5 stay at 15 minutes');
select is(array[public.fn_pin_lock_duration(7), public.fn_pin_lock_duration(8)], array[interval '1 hour', interval '1 hour'], 'tier: 7 and 8 stay at 1 hour');
select is(array[public.fn_pin_lock_duration(10), public.fn_pin_lock_duration(1000)], array[interval '24 hours', interval '24 hours'], 'tier: 10 and beyond stay at 24 hours');
select tests.authenticate_as_service_role();
select is(array[public.fn_pin_eligible((select a_cashier from _f)), public.fn_pin_eligible((select a_admin from _f)),
                public.fn_pin_eligible('00000000-0000-4000-8000-0000000000c1'), public.fn_pin_eligible(gen_random_uuid())],
          array[true, false, false, false], 'fn_pin_eligible: staff yes; tenant_admin, platform admin and unknown profile no');
select tests.clear_auth();

select * from finish();
rollback;
