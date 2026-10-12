-- Phase 10 (migration 0039): dynamic configuration dependency guards. Deactivation stays allowed with dependents (only the last
-- active payment method is kept), fn_config_usage counts, fn_delete_config_row (in_use with the blocking
-- dependency, allowed when unused, audited), closed domain list, permission denial, cross-tenant denial, anon denial.
-- Every fixture row is created here (names are test data only; no code knows them).
begin;
select plan(57);

create temp table _f on commit drop as
select tests.tenant_id('central-cafe') a, tests.tenant_id('second-cafe') b,
       tests.user_id('selam', 'central-cafe') a_admin, tests.user_id('yonas', 'central-cafe') a_waiter,
       tests.user_id('owner', 'second-cafe') b_admin;
grant all on _f to public;
create temp table _n (k text primary key, v uuid);
grant all on _n to public;
create function tests.cv(p_k text) returns uuid language sql stable as $$ select v from _n where k = p_k $$;
create function tests.cfg_exists(p_tbl text, p_id uuid) returns boolean language plpgsql stable security definer set search_path = '' as $$
declare v boolean; begin execute format('select exists (select 1 from public.%I where id = $1)', p_tbl) into v using p_id; return v; end $$;
create function tests.cfg_active(p_tbl text, p_id uuid) returns boolean language plpgsql stable security definer set search_path = '' as $$
declare v boolean; begin execute format('select is_active from public.%I where id = $1', p_tbl) into v using p_id; return v; end $$;
create function tests.cfg_ev(p_rid uuid) returns int language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.audit_logs a where a.restaurant_id = p_rid and a.event = 'config.row_deleted' $$;
grant execute on all functions in schema tests to public;

-- fixtures: used rows (s1, c1, ta1) and unused rows (s2, c2, ta2, ec2, pm2) in tenant A, one station in tenant B
do $$
declare
  v_a uuid := tests.tenant_id('central-cafe');
  v_b uuid := tests.tenant_id('second-cafe');
  v uuid;
begin
  insert into public.stations (restaurant_id, name, color, icon) values (v_a, 'P10 Used Station', '#ea580c', 'chef-hat') returning id into v;
  insert into _n values ('s1', v);
  insert into public.stations (restaurant_id, name) values (v_a, 'P10 Spare Station') returning id into v; insert into _n values ('s2', v);
  insert into public.categories (restaurant_id, name) values (v_a, 'P10 Used Category') returning id into v; insert into _n values ('c1', v);
  insert into public.categories (restaurant_id, name) values (v_a, 'P10 Spare Category') returning id into v; insert into _n values ('c2', v);
  insert into public.table_areas (restaurant_id, name) values (v_a, 'P10 Used Area') returning id into v; insert into _n values ('ta1', v);
  insert into public.table_areas (restaurant_id, name) values (v_a, 'P10 Spare Area') returning id into v; insert into _n values ('ta2', v);
  insert into public.expense_categories (restaurant_id, name) values (v_a, 'P10 Spare Expense') returning id into v; insert into _n values ('ec2', v);
  insert into public.payment_methods (restaurant_id, name) values (v_a, 'P10 Spare Method') returning id into v; insert into _n values ('pm2', v);
  insert into public.menu_items (restaurant_id, name, category_id, station_id, price)
    values (v_a, 'P10 Item', tests.cv('c1'), tests.cv('s1'), 10) returning id into v; insert into _n values ('m1', v);
  insert into public.ingredients (restaurant_id, name, station_id, unit) values (v_a, 'P10 Ingredient', tests.cv('s1'), 'pcs') returning id into v;
  insert into _n values ('i1', v);
  insert into public.tables (restaurant_id, table_area_id, label) values (v_a, tests.cv('ta1'), 'P10-T1') returning id into v; insert into _n values ('t1', v);
  insert into public.stations (restaurant_id, name) values (v_b, 'P10 Other Tenant Station') returning id into v; insert into _n values ('sb', v);
  insert into public.payment_methods (restaurant_id, name) values (v_a, 'P10 Last Method') returning id into v; insert into _n values ('pm3', v);
  insert into public.payment_methods (restaurant_id, name, is_active) values (v_a, 'P10 Retired Method', false) returning id into v;
  insert into _n values ('pm4', v);
  insert into public.table_areas (restaurant_id, name) values (v_a, 'P10 Split Area') returning id into v; insert into _n values ('ta3', v);
  insert into public.tables (restaurant_id, table_area_id, label) values (v_a, tests.cv('ta3'), 'P10-T2') returning id into v; insert into _n values ('t2', v);
end $$;
-- split permissions: one custom role with tables.manage only, one with config.manage only
do $$
declare v_a uuid := tests.tenant_id('central-cafe'); v_t uuid; v_c uuid;
begin
  insert into public.roles (restaurant_id, name) values (v_a, 'P10 Tables Only') returning id into v_t;
  insert into public.roles (restaurant_id, name) values (v_a, 'P10 Config Only') returning id into v_c;
  insert into public.role_permissions (role_id, permission_id, restaurant_id) select v_t, id, v_a from public.permissions where key = 'tables.manage';
  insert into public.role_permissions (role_id, permission_id, restaurant_id) select v_c, id, v_a from public.permissions where key = 'config.manage';
  perform tests.create_auth_user('00000000-0000-4000-8000-0000000051a1', 'p10tables@central-cafe.staff.cafeos.invalid');
  perform tests.create_auth_user('00000000-0000-4000-8000-0000000051a2', 'p10config@central-cafe.staff.cafeos.invalid');
  insert into public.profiles (id, restaurant_id, first_name, username, role_id, auth_method) values
    ('00000000-0000-4000-8000-0000000051a1', v_a, 'Tigist', 'p10tables', v_t, 'pin'),
    ('00000000-0000-4000-8000-0000000051a2', v_a, 'Dawit', 'p10config', v_c, 'pin');
end $$;

-- structure
select is((select count(*)::int from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosecdef and p.proconfig @> array['search_path=""']
           and p.proname in ('fn_config_usage_counts', 'fn_guard_payment_method_deactivation', 'fn_config_domain_check', 'fn_config_usage', 'fn_delete_config_row')), 5,
          'all five: security definer, empty search_path');
select ok(not has_function_privilege('authenticated', 'public.fn_config_usage_counts(uuid, text, uuid)', 'execute')
          and not has_function_privilege('authenticated', 'public.fn_config_domain_check(text)', 'execute')
          and not has_function_privilege('authenticated', 'public.fn_guard_payment_method_deactivation()', 'execute'), 'the helpers are internal');
select is((select string_agg(tgrelid::regclass::text, ',') from pg_trigger where tgname = 'trg_guard_deactivation' and not tgisinternal),
          'payment_methods', 'the deactivation guard is on payment methods only');
select ok(not exists (select 1 from pg_constraint c where c.contype = 'f' and c.confdeltype = 'c'
                      and c.confrelid in ('public.stations'::regclass, 'public.categories'::regclass, 'public.payment_methods'::regclass,
                                          'public.table_areas'::regclass, 'public.expense_categories'::regclass, 'public.tables'::regclass)),
          'no ON DELETE CASCADE into any configuration domain');

-- anon
select ok(not has_function_privilege('anon', 'public.fn_config_usage(text, uuid)', 'execute')
          and not has_function_privilege('anon', 'public.fn_delete_config_row(text, uuid)', 'execute'), 'anon cannot execute either RPC');
select ok(not has_function_privilege('service_role', 'public.fn_config_usage(text, uuid)', 'execute')
          and not has_function_privilege('service_role', 'public.fn_delete_config_row(text, uuid)', 'execute'), 'service_role cannot execute either RPC');
select ok(not exists (select 1 from unnest(array['stations', 'categories', 'payment_methods', 'table_areas', 'expense_categories', 'tables']) t
                      where has_table_privilege('authenticated', 'public.' || t, 'delete')), 'no client DELETE privilege on any configuration table');
select tests.as_anon();
select matches(tests.run(format($q$select public.fn_config_usage('stations', %L)$q$, tests.cv('s2'))), '^42501\|', 'anon: usage refused');
select matches(tests.run(format($q$select public.fn_delete_config_row('stations', %L)$q$, tests.cv('s2'))), '^42501\|', 'anon: delete refused');
select tests.clear_auth();
select ok(tests.cfg_exists('stations', tests.cv('s2')), 'anon deleted nothing');

-- deactivation (direct RLS update by the Tenant Admin, as the settings page does): always allowed, dependents or not
select tests.authenticate_as((select a_admin from _f));
select is(tests.run(format($q$update public.stations set name = 'P10 Renamed', color = '#16a34a', icon = 'soup' where id = %L$q$, tests.cv('s1'))),
          'ok:1', 'editing name / colour / icon of a used row');
select is(tests.run(format($q$update public.stations set is_active = false where id = %L$q$, tests.cv('s1'))), 'ok:1', 'a used station deactivates');
select is(tests.run(format($q$update public.categories set is_active = false where id = %L$q$, tests.cv('c1'))), 'ok:1', 'a used category deactivates');
select is(tests.run(format($q$update public.table_areas set is_active = false where id = %L$q$, tests.cv('ta1'))), 'ok:1', 'a used table area deactivates');
select is(tests.run(format($q$update public.expense_categories set is_active = false where id = %L$q$, tests.cv('ec2'))), 'ok:1', 'expense category deactivates');
select is(tests.run(format($q$update public.stations set is_active = true where id = %L$q$, tests.cv('s1'))), 'ok:1', 'and reactivates');
select is(tests.run(format($q$update public.table_areas set is_active = true where id = %L$q$, tests.cv('ta1'))), 'ok:1', 'area reactivates');
select tests.clear_auth();
update public.menu_items set is_active = false where id = tests.cv('m1');
update public.ingredients set is_active = false where id = tests.cv('i1');
select tests.authenticate_as((select a_admin from _f));

-- usage counts
select is(public.fn_config_usage('stations', tests.cv('s1')) - 'order_items' - 'stock_movements' - 'role_access' - 'active_open_order_items',
          '{"menu_items": 1, "ingredients": 1, "active_menu_items": 0, "active_ingredients": 0}'::jsonb, 'station usage: all references, active split out');
select is(public.fn_config_usage('categories', tests.cv('c1')) ->> 'menu_items', '1', 'category usage');
select is(public.fn_config_usage('table_areas', tests.cv('ta1')), '{"tables": 1, "active_tables": 1}'::jsonb, 'table area usage');
select is((select sum(v::int) from jsonb_each_text(public.fn_config_usage('payment_methods', tests.cv('pm2'))) e(k, v)), 0::bigint, 'unused method: zero everywhere');
select is(tests.run($q$select public.fn_config_usage('roles', gen_random_uuid())$q$), 'P0001|invalid_input|domain', 'domain outside the closed list refused');
select is(tests.run($q$select public.fn_delete_config_row('profiles; drop table x', gen_random_uuid())$q$), 'P0001|invalid_input|domain', 'no identifier injection');
select is(tests.run($q$select public.fn_config_usage('stations', gen_random_uuid())$q$), 'P0001|not_found|', 'unknown id: not_found');

-- delete: refused with the blocking dependency, allowed when unused, audited
select is(tests.run(format($q$select public.fn_delete_config_row('stations', %L)$q$, tests.cv('s1'))), 'P0001|in_use|ingredients:1,menu_items:1',
          'used station: delete refused with what uses it (inactive references still count)');
select is(tests.run(format($q$select public.fn_delete_config_row('categories', %L)$q$, tests.cv('c1'))), 'P0001|in_use|menu_items:1', 'used category refused');
select is(tests.run(format($q$select public.fn_delete_config_row('table_areas', %L)$q$, tests.cv('ta1'))), 'P0001|in_use|tables:1', 'used area refused');
select is(public.fn_delete_config_row('stations', tests.cv('s2')) ->> 'deleted', 'true', 'unused station deleted');
select is(public.fn_delete_config_row('categories', tests.cv('c2')) ->> 'deleted', 'true', 'unused category deleted');
select is(public.fn_delete_config_row('table_areas', tests.cv('ta2')) ->> 'deleted', 'true', 'unused table area deleted');
select is(public.fn_delete_config_row('expense_categories', tests.cv('ec2')) ->> 'deleted', 'true', 'unused expense category deleted');
select is(public.fn_delete_config_row('payment_methods', tests.cv('pm2')) ->> 'deleted', 'true', 'unused payment method deleted');
select is(public.fn_delete_config_row('tables', tests.cv('t1')) ->> 'deleted', 'true', 'unused table deleted (tables.manage)');
select is(public.fn_delete_config_row('table_areas', tests.cv('ta1')) ->> 'deleted', 'true', 'and then its area');
select tests.clear_auth();
select ok(not tests.cfg_exists('stations', tests.cv('s2')) and not tests.cfg_exists('payment_methods', tests.cv('pm2'))
          and tests.cfg_exists('stations', tests.cv('s1')), 'only the unused rows are gone');
select is(tests.cfg_ev((select a from _f)), 7, 'every delete wrote a config.row_deleted audit event');

-- permission denial (a waiter has neither config.manage nor tables.manage)
select tests.authenticate_as((select a_waiter from _f));
select is(tests.run(format($q$select public.fn_config_usage('stations', %L)$q$, tests.cv('s1'))), 'P0001|permission_denied|', 'waiter: usage refused');
select is(tests.run(format($q$select public.fn_delete_config_row('stations', %L)$q$, tests.cv('s1'))), 'P0001|permission_denied|', 'waiter: delete refused');
select is(tests.run(format($q$update public.stations set is_active = true where id = %L$q$, tests.cv('s1'))), 'ok:0', 'waiter: RLS update touches nothing');
select tests.clear_auth();

-- cross-tenant: tenant A's admin cannot read usage of, or delete, tenant B's row (indistinguishable from a missing id)
select tests.authenticate_as((select a_admin from _f));
select is(tests.run(format($q$select public.fn_config_usage('stations', %L)$q$, tests.cv('sb'))), 'P0001|not_found|', 'A cannot read B usage');
select is(tests.run(format($q$select public.fn_delete_config_row('stations', %L)$q$, tests.cv('sb'))), 'P0001|not_found|', 'A cannot delete B row');
select tests.clear_auth();
select ok(tests.cfg_exists('stations', tests.cv('sb')), 'B row untouched');
select tests.authenticate_as((select b_admin from _f));
select is(tests.run(format($q$select public.fn_delete_config_row('stations', %L)$q$, tests.cv('s1'))), 'P0001|not_found|', 'B cannot delete A row');
select tests.clear_auth();

-- direct DELETE is refused outright: fn_delete_config_row is the only client delete path
select tests.authenticate_as((select a_admin from _f));
select is(tests.run(format($q$delete from public.payment_methods where id = %L$q$, tests.cv('pm3'))), '42501|permission denied for table payment_methods|',
          'direct DELETE of a payment method: 42501');
select is(tests.run(format($q$delete from public.tables where id = %L$q$, tests.cv('t2'))), '42501|permission denied for table tables|', 'direct DELETE of a table: 42501');
select tests.clear_auth();

-- split permissions: config.manage does not cover tables, tables.manage does not cover the configuration domains
select tests.authenticate_as('00000000-0000-4000-8000-0000000051a2');
select is(public.fn_config_usage('stations', tests.cv('s1')) ->> 'menu_items', '1', 'config.manage only: station usage');
select is(tests.run(format($q$select public.fn_delete_config_row('tables', %L)$q$, tests.cv('t2'))), 'P0001|permission_denied|', 'config.manage only: tables refused');
select tests.clear_auth();
select tests.authenticate_as('00000000-0000-4000-8000-0000000051a1');
select is(tests.run(format($q$select public.fn_config_usage('stations', %L)$q$, tests.cv('s1'))), 'P0001|permission_denied|', 'tables.manage only: stations refused');
select is(tests.run(format($q$select public.fn_delete_config_row('table_areas', %L)$q$, tests.cv('ta3'))), 'P0001|permission_denied|', 'tables.manage only: table areas refused');
select is(public.fn_delete_config_row('tables', tests.cv('t2')) ->> 'deleted', 'true', 'tables.manage only: an unused table is deleted');
select tests.clear_auth();

-- the last active payment method can neither be deactivated nor deleted; an inactive one is not subject to the rule
update public.payment_methods set is_active = false where restaurant_id = (select a from _f) and id <> tests.cv('pm3');
select tests.authenticate_as((select a_admin from _f));
select is(tests.run($q$update public.payment_methods set is_active = false where is_active$q$), 'P0001|in_use|last_active_method',
          'the last active payment method cannot be deactivated');
select is(tests.run(format($q$select public.fn_delete_config_row('payment_methods', %L)$q$, tests.cv('pm3'))), 'P0001|in_use|last_active_method',
          'the last active payment method cannot be deleted through the RPC');
select is(public.fn_delete_config_row('payment_methods', tests.cv('pm4')) ->> 'deleted', 'true', 'an unused INACTIVE method is deleted while one other is active');
select tests.clear_auth();
select ok(tests.cfg_active('payment_methods', tests.cv('pm3')), 'the last method is still active');
select throws_ok(format($q$delete from public.payment_methods where id = %L$q$, tests.cv('pm3')), 'P0001', 'in_use',
                 'even at owner level the delete trigger keeps the last active method');

-- a suspended tenant cannot delete
update public.restaurants set status = 'suspended' where id = (select b from _f);
select tests.authenticate_as((select b_admin from _f));
select is(tests.run(format($q$select public.fn_delete_config_row('stations', %L)$q$, tests.cv('sb'))), 'P0001|tenant_suspended|', 'suspended tenant: delete refused');
select tests.clear_auth();
select ok(tests.cfg_exists('stations', tests.cv('sb')), 'and nothing was deleted');

select * from finish();
rollback;
