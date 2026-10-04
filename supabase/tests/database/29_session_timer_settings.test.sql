-- Per-tenant session timer settings (migration 0025): table + RLS + grants, one row per tenant (backfill, provisioning, any
-- restaurants insert), CHECK bounds, fn_get/update/reset_session_timers (tenant from identity, settings.session_timers, step-up,
-- invalid_input with field, audit with old/new, replay), session-context session_timers, PIN-restricted users keep the timers,
-- tenant status, cross-tenant isolation, service-only kiosk bootstrap returning the kiosk tenant's own pin_pad_idle_seconds.
begin;
select plan(138);

create temp table _f on commit drop as
select tests.tenant_id('central-cafe') a, tests.tenant_id('second-cafe') b,
       tests.user_id('selam', 'central-cafe') admin, tests.user_id('dawit', 'central-cafe') admin2,
       tests.user_id('yonas', 'central-cafe') waiter, tests.user_id('abebe', 'central-cafe') kitchen,
       tests.user_id('hanna', 'central-cafe') cashier, tests.user_id('meron', 'central-cafe') waiter2,
       tests.user_id('owner', 'second-cafe') b_admin, tests.user_id('waiter', 'second-cafe') b_waiter,
       tests.role_id('Waiter', 'central-cafe') r_waiter,
       '00000000-0000-4000-8000-0000000000c1'::uuid platform;
grant all on _f to public;
grant execute on all functions in schema tests to public;
create temp table _n (k text primary key, v text);
grant all on _n to public;
create function tests.aal2(p_user uuid) returns void language plpgsql as $$
begin
  perform tests.authenticate_as(p_user);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated', 'aud', 'authenticated', 'aal', 'aal2')::text, true);
end $$;
create function tests.timers(p_rid uuid) returns text language sql stable security definer set search_path = '' as $$
  select s.idle_warning_seconds || '/' || s.signout_seconds || '/' || s.pin_pad_idle_seconds
  from public.restaurant_session_settings s where s.restaurant_id = p_rid $$;
create function tests.n_events(p_rid uuid) returns int language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.audit_logs a where a.restaurant_id = p_rid and a.event = 'settings.session_timers_updated' $$;
create function tests.sha256_hex(p text) returns text language sql immutable as $$ select encode(extensions.digest(convert_to(p, 'UTF8'), 'sha256'), 'hex') $$;
grant execute on all functions in schema tests to public;

-- ═════════ structure, RLS, grants ═════════
select has_table('public', 'restaurant_session_settings', 'restaurant_session_settings exists');
select is((select string_agg(a.attname, ',') from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
           where i.indrelid = 'public.restaurant_session_settings'::regclass and i.indisprimary), 'restaurant_id', '1:1 with the tenant: PK = restaurant_id');
select is((select confdeltype::text from pg_constraint where conrelid = 'public.restaurant_session_settings'::regclass and contype = 'f' and confrelid = 'public.restaurants'::regclass), 'r', 'FK to restaurants is ON DELETE RESTRICT');
select is((select confdeltype::text from pg_constraint where conname = 'restaurant_session_settings_updated_by_fk'), 'r', 'updated_by is a composite FK to profiles of the same tenant (RESTRICT)');
select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.restaurant_session_settings'::regclass), 'RLS enabled and forced');
select is((select string_agg(cmd || ':' || array_to_string(roles, ','), ',') from pg_policies where tablename = 'restaurant_session_settings'), 'SELECT:authenticated', 'exactly one policy: SELECT for authenticated');
select ok((select qual ~ 'current_restaurant_id' from pg_policies where tablename = 'restaurant_session_settings'), 'the policy is scoped by current_restaurant_id() (tenant from identity)');
select ok(not has_table_privilege('authenticated', 'public.restaurant_session_settings', 'insert,update,delete,truncate,references,trigger')
      and not has_any_column_privilege('authenticated', 'public.restaurant_session_settings', 'insert,update,references'), 'authenticated: no write privilege at all (RPCs only)');
select ok(not has_any_column_privilege('anon', 'public.restaurant_session_settings', 'select,insert,update,references')
      and not has_table_privilege('anon', 'public.restaurant_session_settings', 'select,insert,update,delete'), 'anon: nothing');
select ok(has_column_privilege('authenticated', 'public.restaurant_session_settings', 'pin_pad_idle_seconds', 'select'), 'authenticated may SELECT the columns (RLS decides the rows)');
select is((select string_agg(tgname, ',' order by tgname) from pg_trigger where tgrelid = 'public.restaurant_session_settings'::regclass and not tgisinternal),
          'trg_audit,trg_lock_restaurant_id,trg_set_updated_at', 'triggers: row audit, tenant-key lock, updated_at');
select ok(exists (select 1 from pg_trigger where tgrelid = 'public.restaurants'::regclass and tgname = 'trg_create_session_settings' and tgenabled = 'O'), 'restaurants AFTER INSERT trigger creates the settings row');
select ok(has_function_privilege('authenticated', 'public.fn_get_session_timers()', 'execute')
      and has_function_privilege('authenticated', 'public.fn_update_session_timers(integer,integer,integer)', 'execute')
      and has_function_privilege('authenticated', 'public.fn_reset_session_timers()', 'execute'), 'get / update / reset: authenticated');
select ok(not has_function_privilege('anon', 'public.fn_get_session_timers()', 'execute')
      and not has_function_privilege('anon', 'public.fn_update_session_timers(integer,integer,integer)', 'execute')
      and not has_function_privilege('anon', 'public.fn_reset_session_timers()', 'execute'), 'and not anon');
select is((select string_agg(p.proname, ',' order by p.proname) from pg_proc p
           where p.pronamespace = 'public'::regnamespace
             and p.proname in ('fn_store_session_timers', 'fn_session_timers_json', 'fn_create_session_settings', 'fn_kiosk_terminal_bootstrap')
             and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))), null,
          'internal helpers and the kiosk bootstrap are not client-executable');
select ok(has_function_privilege('service_role', 'public.fn_kiosk_terminal_bootstrap(text,text)', 'execute'), 'service_role executes the kiosk bootstrap');
select ok((select bool_and(p.prosecdef and p.proconfig @> array['search_path=""']) from pg_proc p where p.pronamespace = 'public'::regnamespace
           and p.proname in ('fn_get_session_timers', 'fn_update_session_timers', 'fn_reset_session_timers', 'fn_store_session_timers',
                             'fn_session_timers_json', 'fn_create_session_settings', 'fn_kiosk_terminal_bootstrap')), 'all seven: security definer, empty search_path');
select is((select module from public.permissions where key = 'settings.session_timers'), 'settings', 'permission settings.session_timers exists (module settings)');
select is((select count(*)::int from public.roles r where r.system_key = 'tenant_admin'
             and not exists (select 1 from public.role_permissions rp join public.permissions pm on pm.id = rp.permission_id
                             where rp.role_id = r.id and pm.key = 'settings.session_timers')), 0, 'every tenant_admin role holds it (trg_grant_new_permission)');
select is((select count(*)::int from public.role_permissions rp join public.permissions pm on pm.id = rp.permission_id
           join public.roles r on r.id = rp.role_id where pm.key = 'settings.session_timers' and r.system_key is null), 0, 'no non-admin role holds it by default');

-- ═════════ defaults, backfill, new tenants ═════════
select is((select count(*)::int from public.restaurants r where not exists (select 1 from public.restaurant_session_settings s where s.restaurant_id = r.id)), 0, 'backfill: every existing tenant has a row');
select is((select count(*)::int from public.restaurant_session_settings), (select count(*)::int from public.restaurants), 'and exactly one each');
select is(tests.timers((select a from _f)), '15/30/60', 'tenant A: defaults 15 / 30 / 60');
select is(tests.timers((select b from _f)), '15/30/60', 'tenant B: defaults 15 / 30 / 60');
select is((select string_agg(column_name || '=' || column_default, ',' order by column_name) from information_schema.columns
           where table_schema = 'public' and table_name = 'restaurant_session_settings' and column_name like '%_seconds'),
          'idle_warning_seconds=15,pin_pad_idle_seconds=60,signout_seconds=30', 'column defaults');
select is(public.fn_session_timers_json(gen_random_uuid()), '{"idle_warning_seconds": 15, "signout_seconds": 30, "pin_pad_idle_seconds": 60}'::jsonb,
          'the missing-row fallback equals the column defaults');
do $$ begin perform tests.create_auth_user('00000000-0000-4000-8000-0000000000e9', 'founder@third-cafe.example.com'); end $$;
select tests.authenticate_as_service_role();
select lives_ok($q$select public.fn_provision_tenant('Third Cafe', 'third-cafe', '00000000-0000-4000-8000-0000000000e9', 'founder@third-cafe.example.com',
                                                      'Fikru', null, null, (select id from public.plans where name = 'Starter'), null, false)$q$, 'provision a new tenant');
select tests.clear_auth();
insert into _n select 'c', tests.tenant_id('third-cafe')::text;
select is(tests.timers((select v::uuid from _n where k = 'c')), '15/30/60', 'fn_provision_tenant: the new tenant gets a default row');
insert into public.restaurants (name, slug) values ('Direct Insert', 'direct-insert-cafe');
select is(tests.timers(tests.tenant_id('direct-insert-cafe')), '15/30/60', 'any restaurants insert gets a default row (trigger)');
select is((select actor_type from public.audit_logs where table_name = 'restaurant_session_settings' and action = 'insert' and restaurant_id = (select v::uuid from _n where k = 'c')), 'system', 'the creation is row-audited');

-- ═════════ CHECK bounds (owner role, tenant C) ═════════
create function tests.set_c(p text) returns text language plpgsql as $$
begin
  return tests.run(format('update public.restaurant_session_settings set %s where restaurant_id = %L', p, (select v from _n where k = 'c')));
end $$;
grant execute on function tests.set_c(text) to public;
select matches(tests.set_c('idle_warning_seconds = 4'), '^23514\|.*restaurant_session_settings_warning_check', 'CHECK: idle_warning < 5 refused');
select matches(tests.set_c('idle_warning_seconds = 30'), '^23514\|.*restaurant_session_settings_warning_check', 'CHECK: idle_warning = signout refused');
select matches(tests.set_c('idle_warning_seconds = 31'), '^23514\|.*restaurant_session_settings_warning_check', 'CHECK: idle_warning > signout refused');
select matches(tests.set_c('signout_seconds = 14, idle_warning_seconds = 5'), '^23514\|.*restaurant_session_settings_signout_check', 'CHECK: signout < 15 refused');
select matches(tests.set_c('signout_seconds = 901'), '^23514\|.*restaurant_session_settings_signout_check', 'CHECK: signout > 900 refused');
select matches(tests.set_c('pin_pad_idle_seconds = 14'), '^23514\|.*restaurant_session_settings_pin_pad_check', 'CHECK: pin_pad < 15 refused');
select matches(tests.set_c('pin_pad_idle_seconds = 301'), '^23514\|.*restaurant_session_settings_pin_pad_check', 'CHECK: pin_pad > 300 refused');
select matches(tests.set_c('idle_warning_seconds = null'), '^23502\|', 'NOT NULL');
select is(tests.set_c('idle_warning_seconds = 5, signout_seconds = 15, pin_pad_idle_seconds = 15'), 'ok:1', 'lower boundaries accepted (5 / 15 / 15)');
select is(tests.set_c('idle_warning_seconds = 899, signout_seconds = 900, pin_pad_idle_seconds = 300'), 'ok:1', 'upper boundaries accepted (899 / 900 / 300)');
select matches(tests.set_c(format('restaurant_id = %L', (select b from _f))), '^P0001\|tenant_change_forbidden', 'restaurant_id is immutable');

-- ═════════ read ═════════
select tests.authenticate_as((select waiter from _f));
select is(public.fn_get_session_timers(), '{"idle_warning_seconds": 15, "signout_seconds": 30, "pin_pad_idle_seconds": 60}'::jsonb, 'waiter: fn_get_session_timers = the tenant values (no permission needed)');
select is((select string_agg(k, ',' order by k) from jsonb_object_keys(public.fn_get_session_timers()) k), 'idle_warning_seconds,pin_pad_idle_seconds,signout_seconds', 'exactly three keys');
select is(public.fn_get_session_context() -> 'session_timers', public.fn_get_session_timers(), 'session context carries the same session_timers');
select is((select count(*)::int from public.restaurant_session_settings), 1, 'RLS: a member sees exactly one row');
select is((select restaurant_id from public.restaurant_session_settings), (select a from _f), 'and it is the own tenant''s');
select is(tests.oracle($q$select 1 from public.restaurant_session_settings where restaurant_id = {id}$q$, (select b from _f)), 'ok:0', 'B''s row by id behaves like an unknown id');
select tests.clear_auth();
select tests.authenticate_as((select b_waiter from _f));
select is((select restaurant_id from public.restaurant_session_settings), (select b from _f), 'tenant B member sees only B''s row');
select tests.clear_auth();
select tests.as_anon();
select is(tests.run('select public.fn_get_session_timers()'), '42501|permission denied for function fn_get_session_timers|', 'anon cannot read the timers');
select is(tests.run('select * from public.restaurant_session_settings'), '42501|permission denied for table restaurant_session_settings|', 'anon cannot select the table');
select tests.clear_auth();
select tests.authenticate_as((select platform from _f));
select is(tests.run('select public.fn_get_session_timers()'), 'P0001|permission_denied|', 'a platform admin (no tenant profile) gets permission_denied');
select ok(not (public.fn_get_session_context() ? 'session_timers'), 'and its session context has no session_timers');
select tests.clear_auth();

-- ═════════ update: happy path, audit, replay ═════════
select tests.authenticate_as((select admin from _f));
select is(public.fn_update_session_timers(20, 45, 90), '{"idle_warning_seconds": 20, "signout_seconds": 45, "pin_pad_idle_seconds": 90}'::jsonb, 'tenant_admin updates: returns the stored values');
select tests.clear_auth();
select is(tests.timers((select a from _f)), '20/45/90', 'stored');
select is((select updated_by from public.restaurant_session_settings where restaurant_id = (select a from _f)), (select admin from _f), 'updated_by = the caller');
select is(tests.timers((select b from _f)), '15/30/60', 'tenant B untouched');
select is(tests.n_events((select a from _f)), 1, 'one settings.session_timers_updated event');
select is((select new_data from public.audit_logs where event = 'settings.session_timers_updated' and restaurant_id = (select a from _f)),
          '{"old": {"idle_warning_seconds": 15, "signout_seconds": 30, "pin_pad_idle_seconds": 60}, "new": {"idle_warning_seconds": 20, "signout_seconds": 45, "pin_pad_idle_seconds": 90}, "reset": false}'::jsonb,
          'audit payload: old, new, reset = false');
select is((select actor_id from public.audit_logs where event = 'settings.session_timers_updated' and restaurant_id = (select a from _f)), (select admin from _f), 'audit actor = the admin');
select is((select count(*)::int from public.audit_logs where table_name = 'restaurant_session_settings' and action = 'update' and restaurant_id = (select a from _f) and actor_id = (select admin from _f)), 1, 'and the row audit trigger recorded the change');
select is((select old_data ->> 'signout_seconds' || '>' || (new_data ->> 'signout_seconds') from public.audit_logs where table_name = 'restaurant_session_settings' and action = 'update' and restaurant_id = (select a from _f)), '30>45', 'row audit carries changed columns old/new');
select tests.authenticate_as((select admin from _f));
select is(public.fn_update_session_timers(20, 45, 90), '{"idle_warning_seconds": 20, "signout_seconds": 45, "pin_pad_idle_seconds": 90}'::jsonb, 'replay with the same values: same answer');
select tests.clear_auth();
select is(tests.n_events((select a from _f)), 1, 'replay writes no second event');
select is(tests.timers((select a from _f)), '20/45/90', 'and changes nothing');
select tests.authenticate_as((select waiter from _f));
select is(public.fn_get_session_context() -> 'session_timers', '{"idle_warning_seconds": 20, "signout_seconds": 45, "pin_pad_idle_seconds": 90}'::jsonb, 'a waiter''s session context shows the new values');
select is(public.fn_get_session_timers() ->> 'signout_seconds', '45', 'and so does fn_get_session_timers');
select tests.clear_auth();

-- ═════════ validation ═════════
select tests.authenticate_as((select admin from _f));
select is(tests.run('select public.fn_update_session_timers(4, 30, 60)'), 'P0001|invalid_input|idle_warning_seconds', 'idle_warning 4: invalid_input idle_warning_seconds');
select is(tests.run('select public.fn_update_session_timers(null, 30, 60)'), 'P0001|invalid_input|idle_warning_seconds', 'idle_warning null');
select is(tests.run('select public.fn_update_session_timers(30, 30, 60)'), 'P0001|invalid_input|idle_warning_seconds', 'idle_warning = signout');
select is(tests.run('select public.fn_update_session_timers(40, 30, 60)'), 'P0001|invalid_input|idle_warning_seconds', 'idle_warning > signout');
select is(tests.run('select public.fn_update_session_timers(5, 14, 60)'), 'P0001|invalid_input|signout_seconds', 'signout 14: invalid_input signout_seconds');
select is(tests.run('select public.fn_update_session_timers(5, 901, 60)'), 'P0001|invalid_input|signout_seconds', 'signout 901');
select is(tests.run('select public.fn_update_session_timers(5, null, 60)'), 'P0001|invalid_input|signout_seconds', 'signout null');
select is(tests.run('select public.fn_update_session_timers(5, 30, 14)'), 'P0001|invalid_input|pin_pad_idle_seconds', 'pin_pad 14: invalid_input pin_pad_idle_seconds');
select is(tests.run('select public.fn_update_session_timers(5, 30, 301)'), 'P0001|invalid_input|pin_pad_idle_seconds', 'pin_pad 301');
select is(tests.run('select public.fn_update_session_timers(5, 30, null)'), 'P0001|invalid_input|pin_pad_idle_seconds', 'pin_pad null');
select is(tests.run('select public.fn_update_session_timers(-2147483648, 2147483647, 0)'), 'P0001|invalid_input|idle_warning_seconds', 'integer extremes: invalid_input (no overflow / SQL error)');
select tests.clear_auth();
select is(tests.timers((select a from _f)), '20/45/90', 'no refused call changed anything');
select is(tests.n_events((select a from _f)), 1, 'and none was audited as a change');

-- ═════════ authorisation ═════════
select tests.authenticate_as((select waiter from _f));
select is(tests.run('select public.fn_update_session_timers(10, 20, 30)'), 'P0001|permission_denied|', 'waiter: update permission_denied');
select is(tests.run('select public.fn_reset_session_timers()'), 'P0001|permission_denied|', 'waiter: reset permission_denied');
select is(tests.run('update public.restaurant_session_settings set signout_seconds = 900'), '42501|permission denied for table restaurant_session_settings|', 'waiter: no direct UPDATE');
select tests.clear_auth();
select tests.authenticate_as((select kitchen from _f));
select is(tests.run('select public.fn_update_session_timers(10, 20, 30)'), 'P0001|permission_denied|', 'kitchen staff: permission_denied');
select tests.clear_auth();
select tests.authenticate_as((select cashier from _f));
select is(tests.run('select public.fn_update_session_timers(10, 20, 30)'), 'P0001|permission_denied|', 'cashier: permission_denied');
select tests.clear_auth();
select tests.authenticate_as((select admin from _f));
select is(tests.run('update public.restaurant_session_settings set signout_seconds = 900'), '42501|permission denied for table restaurant_session_settings|', 'even tenant_admin: no direct UPDATE (RPC only)');
select is(tests.run(format($q$insert into public.restaurant_session_settings (restaurant_id) values (%L)$q$, (select b from _f))), '42501|permission denied for table restaurant_session_settings|', 'no direct INSERT');
select is(tests.run('delete from public.restaurant_session_settings'), '42501|permission denied for table restaurant_session_settings|', 'no direct DELETE');
select tests.clear_auth();
select tests.as_anon();
select is(tests.run('select public.fn_update_session_timers(10, 20, 30)'), '42501|permission denied for function fn_update_session_timers|', 'anon cannot update');
select tests.clear_auth();
select is(tests.timers((select a from _f)), '20/45/90', 'denied callers changed nothing');
-- grantable through the matrix
insert into public.role_permissions (role_id, permission_id, restaurant_id)
  select (select r_waiter from _f), id, (select a from _f) from public.permissions where key = 'settings.session_timers';
select tests.authenticate_as((select waiter2 from _f));
select is(public.fn_update_session_timers(25, 50, 90) ->> 'idle_warning_seconds', '25', 'the permission is grantable: a Waiter holding it may update');
select tests.clear_auth();
delete from public.role_permissions where role_id = (select r_waiter from _f) and permission_id = (select id from public.permissions where key = 'settings.session_timers');

-- ═════════ cross-tenant ═════════
select tests.authenticate_as((select b_admin from _f));
select is(public.fn_update_session_timers(10, 120, 45), '{"idle_warning_seconds": 10, "signout_seconds": 120, "pin_pad_idle_seconds": 45}'::jsonb, 'tenant B admin updates B');
select is(public.fn_get_session_timers() ->> 'signout_seconds', '120', 'B reads B''s values');
select tests.clear_auth();
select is(tests.timers((select a from _f)), '25/50/90', 'tenant A unchanged by B''s update (no tenant parameter exists)');
select is(tests.timers((select b from _f)), '10/120/45', 'B stored');
select tests.authenticate_as((select waiter from _f));
select is(public.fn_get_session_timers() ->> 'signout_seconds', '50', 'A members still read A''s values');
select tests.clear_auth();
select is((select count(*)::int from public.audit_logs where event = 'settings.session_timers_updated' and restaurant_id = (select b from _f) and actor_id = (select b_admin from _f)), 1, 'B''s event is filed under B with B''s admin');

-- ═════════ step-up ═════════
select tests.add_verified_factor((select admin from _f));
select tests.authenticate_as((select admin from _f));
select is(tests.run('select public.fn_update_session_timers(10, 20, 30)'), 'P0001|mfa_required|', 'admin with a verified factor on aal1: update needs step-up');
select is(tests.run('select public.fn_reset_session_timers()'), 'P0001|mfa_required|', 'reset too');
select is(public.fn_get_session_timers() ->> 'idle_warning_seconds', '25', 'reading needs no step-up');
select tests.clear_auth();
select tests.authenticate_as((select admin2 from _f));
select set_config('app.tenant_admin_mfa_required', 'on', true);
select is(tests.run('select public.fn_update_session_timers(10, 20, 30)'), 'P0001|mfa_required|', 'app.tenant_admin_mfa_required = on: an admin without a factor needs aal2');
select set_config('app.tenant_admin_mfa_required', 'off', true);
select tests.clear_auth();
select is(tests.timers((select a from _f)), '25/50/90', 'nothing changed without step-up');
select tests.aal2((select admin from _f));
select is(public.fn_update_session_timers(10, 20, 30) ->> 'pin_pad_idle_seconds', '30', 'aal2 session: update succeeds');

-- ═════════ reset ═════════
select is(public.fn_reset_session_timers(), '{"idle_warning_seconds": 15, "signout_seconds": 30, "pin_pad_idle_seconds": 60}'::jsonb, 'reset returns the defaults');
select tests.clear_auth();
select is(tests.timers((select a from _f)), '15/30/60', 'defaults stored');
select is((select new_data from public.audit_logs where event = 'settings.session_timers_updated' and restaurant_id = (select a from _f) and (new_data ->> 'reset')::boolean),
          '{"old": {"idle_warning_seconds": 10, "signout_seconds": 20, "pin_pad_idle_seconds": 30}, "new": {"idle_warning_seconds": 15, "signout_seconds": 30, "pin_pad_idle_seconds": 60}, "reset": true}'::jsonb,
          'reset audit: old, new = defaults, reset = true');
select tests.aal2((select admin from _f));
select is(public.fn_reset_session_timers() ->> 'signout_seconds', '30', 'reset replay: same answer');
select tests.clear_auth();
select is((select count(*)::int from public.audit_logs where event = 'settings.session_timers_updated' and restaurant_id = (select a from _f) and (new_data ->> 'reset')::boolean), 1, 'reset replay writes no second event');
select tests.authenticate_as((select waiter from _f));
select is(tests.run('select public.fn_reset_session_timers()'), 'P0001|permission_denied|', 'reset: staff denied');
select tests.clear_auth();

-- ═════════ PIN-restricted users keep the timers ═════════
select tests.aal2((select admin from _f));
select public.fn_update_session_timers(12, 40, 75);
select tests.clear_auth();
select tests.authenticate_as_service_role();
select public.fn_staff_login_blocked((select waiter from _f));
select tests.clear_auth();
select tests.authenticate_as((select waiter from _f));
select is(public.fn_get_session_context() ->> 'pin_change_status', 'required', '(waiter is restricted: PIN change required)');
select is(public.fn_get_session_timers(), '{"idle_warning_seconds": 12, "signout_seconds": 40, "pin_pad_idle_seconds": 75}'::jsonb, 'restricted (required): fn_get_session_timers still works');
select is(public.fn_get_session_context() -> 'session_timers', '{"idle_warning_seconds": 12, "signout_seconds": 40, "pin_pad_idle_seconds": 75}'::jsonb, 'restricted (required): session_timers still in the context');
select is((select count(*)::int from public.restaurant_session_settings), 1, 'restricted: the own row is still readable');
select tests.clear_auth();
select tests.authenticate_as_service_role();
select public.fn_complete_forced_pin_change((select waiter from _f), tests.pin_digest('5183'), 4);
select tests.clear_auth();
select tests.authenticate_as((select waiter from _f));
select is(public.fn_get_session_context() ->> 'pin_change_status', 'pending_approval', '(waiter now awaits approval)');
select is(public.fn_get_session_timers() ->> 'signout_seconds', '40', 'restricted (pending_approval): fn_get_session_timers still works');
select is(public.fn_get_session_context() #>> '{session_timers,idle_warning_seconds}', '12', 'restricted (pending_approval): session_timers still in the context');
select tests.clear_auth();
-- the restricted user holds no permission, even when the role holds settings.session_timers
insert into public.role_permissions (role_id, permission_id, restaurant_id)
  select (select r_waiter from _f), id, (select a from _f) from public.permissions where key = 'settings.session_timers';
select tests.authenticate_as((select waiter from _f));
select is(tests.run('select public.fn_update_session_timers(10, 20, 30)'), 'P0001|permission_denied|', 'restricted user: update denied even though the role holds the permission');
select tests.clear_auth();
delete from public.role_permissions where role_id = (select r_waiter from _f) and permission_id = (select id from public.permissions where key = 'settings.session_timers');

-- ═════════ session context: every 0024 field preserved ═════════
select tests.authenticate_as((select admin from _f));
select is((select string_agg(k, ',' order by k) from jsonb_object_keys(public.fn_get_session_context()) k),
          'must_change_pin,open_day,permissions,pin_change_status,pin_length,restaurant,role,session_timers,station_ids,tenant_writable,user',
          'context keys = the 0024 keys + session_timers');
select ok(public.fn_get_session_context() -> 'permissions' ? 'settings.session_timers', 'tenant_admin context lists settings.session_timers');
select tests.clear_auth();

-- ═════════ kiosk bootstrap (service-only) ═════════
select tests.aal2((select admin from _f));
create temp table _r on commit drop as select public.fn_register_kiosk('Timer terminal') r;
grant all on _r to public;
select tests.clear_auth();
insert into public.kiosk_devices (restaurant_id, name, token_hash, created_by) select b, 'B terminal', tests.sha256_hex(repeat('b', 64)), b_admin from _f;
select tests.authenticate_as_service_role();
create temp table _boot on commit drop as
select public.fn_kiosk_terminal_bootstrap(tests.sha256_hex((select r ->> 'token' from _r)), 'central-cafe') a_boot,
       public.fn_kiosk_terminal_bootstrap(tests.sha256_hex(repeat('b', 64)), 'second-cafe') b_boot,
       public.fn_kiosk_roster(tests.sha256_hex((select r ->> 'token' from _r)), 'central-cafe') a_roster;
grant all on _boot to public;
select tests.clear_auth();
select is((select string_agg(k, ',' order by k) from jsonb_object_keys((select a_boot from _boot)) k), 'pin_pad_idle_seconds,staff', 'bootstrap keys: staff, pin_pad_idle_seconds');
select is((select a_boot -> 'staff' from _boot), (select a_roster from _boot), 'staff = exactly fn_kiosk_roster');
select is((select a_boot ->> 'pin_pad_idle_seconds' from _boot), '75', 'tenant A kiosk: A''s own pin_pad_idle_seconds');
select is((select b_boot ->> 'pin_pad_idle_seconds' from _boot), '45', 'tenant B kiosk: B''s own value (tenant from the token)');
select is(jsonb_typeof((select a_boot -> 'pin_pad_idle_seconds' from _boot)), 'number', 'a JSON number');
select tests.authenticate_as_service_role();
select is(public.fn_kiosk_terminal_bootstrap(tests.sha256_hex((select r ->> 'token' from _r)), 'second-cafe'), null::jsonb, 'A token with B''s slug: NULL (no B value leaks)');
select is(public.fn_kiosk_terminal_bootstrap(repeat('f', 64), 'central-cafe'), null::jsonb, 'unknown token: NULL');
select is(public.fn_kiosk_terminal_bootstrap('nope', 'central-cafe'), null::jsonb, 'malformed token: NULL');
select tests.clear_auth();
select tests.authenticate_as((select admin from _f));
select is(tests.run($q$select public.fn_kiosk_terminal_bootstrap(repeat('a', 64), 'central-cafe')$q$), '42501|permission denied for function fn_kiosk_terminal_bootstrap|', 'authenticated cannot call the bootstrap');
select tests.clear_auth();
select tests.as_anon();
select is(tests.run($q$select public.fn_kiosk_terminal_bootstrap(repeat('a', 64), 'central-cafe')$q$), '42501|permission denied for function fn_kiosk_terminal_bootstrap|', 'nor anon');
select tests.clear_auth();
select is(tests.run($q$select public.fn_kiosk_terminal_bootstrap(repeat('a', 64), 'central-cafe')$q$), 'P0001|permission_denied|', 'a non-service caller (owner role) gets permission_denied');

-- ═════════ tenant status ═════════
update public.restaurants set status = 'past_due' where id = (select b from _f);
select tests.authenticate_as((select b_admin from _f));
select is(tests.run('select public.fn_update_session_timers(10, 20, 30)'), 'P0001|tenant_read_only|', 'past_due: update refused (tenant_read_only)');
select is(tests.run('select public.fn_reset_session_timers()'), 'P0001|tenant_read_only|', 'past_due: reset refused');
select is(public.fn_get_session_timers() ->> 'signout_seconds', '120', 'past_due: reading still works');
select tests.clear_auth();
update public.restaurants set status = 'suspended', suspended_at = now(), suspension_reason = 'test', status_before_suspension = 'active' where id = (select b from _f);
select tests.authenticate_as((select b_waiter from _f));
select is(tests.run('select public.fn_get_session_timers()'), 'P0001|tenant_suspended|', 'suspended: even reading is refused');
select is((select count(*)::int from public.restaurant_session_settings), 0, 'suspended: RLS shows no row');
select tests.clear_auth();
select tests.authenticate_as_service_role();
select is(public.fn_kiosk_terminal_bootstrap(tests.sha256_hex(repeat('b', 64)), 'second-cafe'), null::jsonb, 'suspended: kiosk bootstrap NULL');
select tests.clear_auth();

-- ═════════ no secrets ═════════
select ok(not exists (select 1 from public.audit_logs where (event = 'settings.session_timers_updated' or table_name = 'restaurant_session_settings')
                       and coalesce(new_data::text, '') || coalesce(old_data::text, '') ~* '(hash|token|secret|pin_hash|\$2[aby]\$)'), 'timer audit rows carry no secret');
select is(tests.run('delete from public.restaurant_session_settings where restaurant_id = (select id from public.restaurants where slug = ''direct-insert-cafe'')'), 'ok:1', '(owner can delete a row: fallback check)');
select is(public.fn_session_timers_json(tests.tenant_id('direct-insert-cafe')) ->> 'pin_pad_idle_seconds', '60', 'a missing row falls back to the defaults');

select * from finish();
rollback;
