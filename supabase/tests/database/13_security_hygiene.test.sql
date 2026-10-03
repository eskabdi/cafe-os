-- Adversarial: structural security hygiene, asserted from the catalogs so it also covers objects added later.
-- SECURITY DEFINER search_path pinning, EXECUTE grants, RLS enabled+forced+policies, views, secrets that must
-- never reach a client (PIN hash, token hashes), Realtime publication, default privileges.
-- A failure here after a new migration means the new object needs the same hardening (or a reviewed allowlist entry).
begin;
select plan(62);

-- ═════════ SECURITY DEFINER / function hygiene ═════════
create temp view _fn as
select p.oid, p.proname::text as name, p.prosecdef as definer, p.proconfig, p.prosrc, p.prorettype, p.proretset,
       p.proargnames, p.prokind
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e');
grant select on _fn to public;

select is((select string_agg(name, ',' order by name) from _fn where definer and not coalesce(proconfig, '{}') @> array['search_path=""']),
          null, 'every SECURITY DEFINER function pins search_path to the empty path');
select is((select string_agg(name, ',' order by name) from _fn where not coalesce(proconfig, '{}') @> array['search_path=""']),
          null, 'every function in public (definer or not) pins search_path');
select is((select string_agg(name, ',' order by name) from _fn where pg_get_userbyid((select proowner from pg_proc where oid = _fn.oid)) <> 'postgres'),
          null, 'every function in public is owned by the migration role');
select is((select string_agg(name, ',' order by name) from _fn where has_function_privilege('public', oid, 'execute')),
          null, 'no function in public is executable by PUBLIC');
select is((select string_agg(name, ',' order by name) from _fn where has_function_privilege('anon', oid, 'execute')),
          'fn_resolve_tenant_slug', 'anon may execute only fn_resolve_tenant_slug (fn_err is authenticated/service_role only)');
select is((select string_agg(name, ',' order by name) from _fn where has_function_privilege('authenticated', oid, 'execute')),
          'current_restaurant_id,current_role_id,current_station_ids,current_tenant_writable,current_user_id,fn_change_user_role,fn_create_staff_profile,fn_err,fn_get_open_day,fn_get_restaurant_settings,fn_get_session_context,fn_list_kiosks,fn_mark_notification_read,fn_prepare_staff_creation,fn_provision_tenant,fn_reactivate_tenant,fn_register_kiosk,fn_reset_pin_lockout,fn_resolve_tenant_slug,fn_revoke_kiosk,fn_suspend_tenant,fn_update_role_permissions,has_permission,has_station_access,is_order_owner,is_platform_admin,is_platform_super_admin,is_tenant_admin',
          'authenticated executes exactly the reviewed RPC + RLS helper list (update this list consciously)');
select is((select string_agg(name, ',' order by name) from _fn where has_function_privilege('authenticated', oid, 'execute') and has_function_privilege('anon', oid, 'execute')
           and name not in ('fn_resolve_tenant_slug')), null, 'nothing anon can run beyond the allowlist is also open to authenticated');
select is((select string_agg(name, ',' order by name) from _fn
           where name in ('fn_set_user_pin', 'fn_verify_pin', 'fn_register_pin_failure', 'fn_user_auth_method', 'fn_write_audit', 'fn_write_admin_audit',
                          'fn_seed_tenant_defaults', 'fn_next_number', 'fn_tenant_status_guard', 'fn_idempotency_begin', 'fn_idempotency_complete', 'fn_pin_eligible')
             and (has_function_privilege('authenticated', oid, 'execute') or has_function_privilege('anon', oid, 'execute'))),
          null, 'PIN, audit, seeding, counter and idempotency functions are not client-executable');
select is((select string_agg(name, ',' order by name) from _fn where prorettype = 'trigger'::regtype
           and (has_function_privilege('authenticated', oid, 'execute') or has_function_privilege('anon', oid, 'execute'))),
          null, 'trigger functions are not client-executable');
-- every client-callable business RPC must authorise inside its body (it is the only gate; RLS does not apply to definers)
select is((select string_agg(name, ',' order by name) from _fn
           where has_function_privilege('authenticated', oid, 'execute')
             and name not in ('current_restaurant_id', 'current_role_id', 'current_station_ids', 'current_tenant_writable', 'current_user_id', 'has_permission', 'has_station_access',
                              'is_order_owner', 'is_platform_admin', 'is_platform_super_admin', 'is_tenant_admin', 'order_has_station_access',
                              'fn_err', 'fn_resolve_tenant_slug')
             and prosrc !~ '(fn_tenant_status_guard|is_platform_super_admin|is_service_role|auth\.uid)'),
          null, 'every client-callable RPC authorises in its body');
select is((select string_agg(name, ',' order by name) from _fn
           where has_function_privilege('authenticated', oid, 'execute') and proargnames is not null
             and exists (select 1 from unnest(proargnames) a where a ~* 'restaurant')),
          'fn_reactivate_tenant,fn_suspend_tenant', 'only the platform RPCs accept a tenant id from the caller');
-- a definer function must never hand rows of tenant tables to a client (it would bypass RLS)
select is((select string_agg(name, ',' order by name) from _fn
           where definer and has_function_privilege('authenticated', oid, 'execute')
             and (proretset or prorettype in (select reltype from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r'))),
          null, 'no client-callable definer function returns rows or table row types');
select is((select string_agg(name, ',' order by name) from _fn
           where has_function_privilege('authenticated', oid, 'execute') and prorettype in ('jsonb'::regtype, 'json'::regtype, 'text'::regtype, 'record'::regtype)),
          'fn_change_user_role,fn_create_staff_profile,fn_get_open_day,fn_get_restaurant_settings,fn_get_session_context,fn_list_kiosks,fn_mark_notification_read,fn_prepare_staff_creation,fn_provision_tenant,fn_reactivate_tenant,fn_register_kiosk,fn_reset_pin_lockout,fn_resolve_tenant_slug,fn_revoke_kiosk,fn_suspend_tenant,fn_update_role_permissions',
          'the set of client-callable functions returning free-form json/text is the reviewed one');
select is((select string_agg(name, ',' order by name) from _fn where prorettype = 'public.profile_secrets'::regtype or proargnames @> array['pin_hash']
           or (name <> 'fn_audit_row' and prosrc ~* '''pin_hash''') or prosrc ~* 'returning\s+(ps\.)?pin_hash' or prosrc ~* 'to_jsonb\(\s*(ps|profile_secrets)'),
          null, 'no function returns, names or serialises pin_hash');

-- ═════════ RLS hygiene ═════════
create temp view _tbl as
select c.oid, c.relname::text as name, c.relrowsecurity as rls, c.relforcerowsecurity as forced
from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p');
grant select on _tbl to public;

select is((select string_agg(name, ',') from _tbl where not rls), null, 'RLS is enabled on every public table');
select is((select string_agg(name, ',') from _tbl where not forced), null, 'RLS is FORCED on every public table (owner included)');
select is((select string_agg(t.name, ',' order by t.name) from _tbl t where not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = t.name)),
          'idempotency_keys,profile_secrets,tenant_counters', 'the only policy-less (deny-all) tables are the intended internal ones');
select is((select string_agg(t.name, ',') from _tbl t
           where t.name in ('idempotency_keys', 'profile_secrets', 'tenant_counters')
             and (has_any_column_privilege('anon', t.oid, 'select,insert,update,references') or has_any_column_privilege('authenticated', t.oid, 'select,insert,update,references')
                  or has_table_privilege('anon', t.oid, 'delete,truncate,trigger') or has_table_privilege('authenticated', t.oid, 'delete,truncate,trigger'))),
          null, 'deny-all tables carry no privilege for any client role');
select is((select string_agg(t.name, ',') from _tbl t
           where has_table_privilege('authenticated', t.oid, 'truncate') or has_table_privilege('authenticated', t.oid, 'trigger')
              or has_table_privilege('authenticated', t.oid, 'references') or has_table_privilege('anon', t.oid, 'truncate')),
          null, 'no client role holds TRUNCATE / TRIGGER / REFERENCES anywhere');
select is((select string_agg(t.name || ':' || p, ',') from _tbl t, unnest(array['select', 'insert', 'update', 'delete']) p
           where has_table_privilege('anon', t.oid, p) and not (t.name = 'plans' and p = 'select')),
          null, 'anon holds table-level privileges on nothing except SELECT on plans');
select is((select string_agg(distinct tablename || '.' || policyname, ',') from pg_policies
           where schemaname = 'public' and (roles::text like '%anon%' or roles::text like '%public%') and policyname <> 'plans_select_anon'),
          null, 'the only policy that applies to anon/PUBLIC is plans_select_anon');
select is((select string_agg(tablename || '.' || policyname, ',') from pg_policies where schemaname = 'public' and (qual ~ '^\(?true\)?$' or with_check ~ '^\(?true\)?$')),
          null, 'no policy is USING (true) / WITH CHECK (true)');
select is((select string_agg(tablename || '.' || policyname, ',') from pg_policies where schemaname = 'public' and cmd = 'ALL'),
          null, 'no FOR ALL policies (one explicit policy per verb)');
select is((select string_agg(p.tablename || '.' || p.policyname, ',' order by p.tablename, p.policyname) from pg_policies p
           where p.schemaname = 'public' and p.tablename in (select tests.tenant_tables())
             and coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '') !~ '(current_restaurant_id|is_platform_admin|is_platform_super_admin)'),
          null, 'every policy on a tenant table is scoped by current_restaurant_id() or is platform-only');
select is((select string_agg(t.name, ',' order by t.name) from _tbl t
           where not exists (select 1 from pg_attribute a where a.attrelid = t.oid and a.attname = 'restaurant_id' and not a.attisdropped)),
          'permissions,plans,platform_admins,restaurants', 'only platform/global tables lack restaurant_id');
select is((select string_agg(t, ',') from tests.tenant_tables() t
           where not exists (select 1 from pg_trigger g where g.tgrelid = ('public.' || t)::regclass and g.tgname = 'trg_lock_restaurant_id')),
          null, 'restaurant_id is immutable (trigger) on every tenant table');
select is((select string_agg(t, ',') from tests.tenant_tables() t
           where not exists (select 1 from pg_constraint c where c.conrelid = ('public.' || t)::regclass and c.contype = 'f' and c.confrelid = 'public.restaurants'::regclass)),
          null, 'every tenant table has an FK to restaurants');
select is((select string_agg(t, ',') from tests.tenant_tables() t
           where exists (select 1 from pg_attribute a where a.attrelid = ('public.' || t)::regclass and a.attname = 'restaurant_id' and not a.attnotnull)),
          'admin_audit_log', 'restaurant_id is NOT NULL on every tenant table (admin_audit_log: platform jobs have none)');
select is((select count(*)::int from pg_policies where schemaname = 'public'), 82, 'policy count matches docs/architecture/rls-matrix.md (update the doc when policies change)');

-- ═════════ views, materialized views, foreign tables ═════════
select is((select string_agg(c.relname, ',') from pg_class c
           where c.relnamespace = 'public'::regnamespace and c.relkind in ('v', 'm', 'f')
             and not (c.relkind = 'v' and coalesce(c.reloptions, '{}') @> array['security_invoker=true'])),
          null, 'no view without security_invoker=true, and no materialized/foreign tables, in public');
select is((select string_agg(c.relname, ',') from pg_class c
           where c.relnamespace = 'public'::regnamespace and c.relkind in ('v', 'm', 'f')
             and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('authenticated', c.oid, 'select'))
             and c.relname !~ '^_'), null, 'no client-readable view exists at all (temp test views excluded)');

-- ═════════ secrets that must never reach a client ═════════
select is((select string_agg(c.relname || '.' || a.attname, ',' order by c.relname)
           from pg_attribute a join pg_class c on c.oid = a.attrelid
           where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
             and a.attname ~ '(hash|secret|token|password)'
             and (has_column_privilege('anon', c.oid, a.attnum, 'select,insert,update,references')
                  or has_column_privilege('authenticated', c.oid, a.attnum, 'select,insert,update,references'))),
          null, 'no client role holds any privilege on a hash/secret/token column (pin_hash, token_hash, session_token_hash, public_token_hash)');
select is((select string_agg(c.relname || '.' || a.attname, ',' order by c.relname)
           from pg_attribute a join pg_class c on c.oid = a.attrelid
           where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped and a.attname ~ '(hash|secret|token|password)'),
          'customer_sessions.session_token_hash,idempotency_keys.request_hash,kiosk_devices.token_hash,orders.public_token_hash,profile_secrets.pin_hash,qr_credentials.token_hash',
          'inventory of secret-looking columns (a new one must be reviewed and kept off client grants)');

create temp table _ctx on commit drop as
select tests.user_id('selam', 'central-cafe') admin, tests.user_id('hanna', 'central-cafe') cashier,
       tests.user_id('yonas', 'central-cafe') waiter, tests.user_id('abebe', 'central-cafe') kitchen,
       '00000000-0000-4000-8000-0000000000c1'::uuid platform;
grant all on _ctx to public;

select tests.authenticate_as((select admin from _ctx));
select is(tests.run('select * from public.profile_secrets'), '42501|permission denied for table profile_secrets|', 'tenant admin: profile_secrets unreadable');
select is(tests.run('select pin_hash from public.profiles'), '42703|column "pin_hash" does not exist|', 'tenant admin: profiles has no pin_hash column');
select is(tests.run('select token_hash from public.qr_credentials'), '42501|permission denied for table qr_credentials|', 'tenant admin: qr token_hash unreadable');
select is(tests.run('select public_token_hash from public.orders'), '42501|permission denied for table orders|', 'tenant admin: orders.public_token_hash unreadable');
select is(tests.run('select session_token_hash from public.customer_sessions'), '42501|permission denied for table customer_sessions|', 'tenant admin: session_token_hash unreadable');
select is(tests.run('select * from public.qr_credentials'), '42501|permission denied for table qr_credentials|', 'tenant admin: select * on qr_credentials denied (column grants)');
select ok(not ((select jsonb_agg(to_jsonb(p)) from public.profiles p)::text ~* '(pin_hash|\$2[aby]\$)'), 'tenant admin: serialised profile rows carry no secret');
select ok(not ((select public.fn_get_session_context())::text ~* '(pin_hash|token_hash|\$2[aby]\$)'), 'tenant admin: session context carries no secret');
select tests.clear_auth();
select tests.authenticate_as((select kitchen from _ctx));
select is(tests.run('select * from public.profile_secrets'), '42501|permission denied for table profile_secrets|', 'staff: profile_secrets unreadable');
select ok(not ((select public.fn_get_session_context())::text ~* '(pin_hash|token_hash|\$2[aby]\$)'), 'staff: session context carries no secret');
select tests.clear_auth();
select tests.as_anon();
select is(tests.run('select * from public.profile_secrets'), '42501|permission denied for table profile_secrets|', 'anon: profile_secrets unreadable');
select ok(not ((select public.fn_resolve_tenant_slug('central-cafe'))::text ~* '(pin_hash|token_hash|\$2[aby]\$|status)'), 'anon: slug resolver carries no secret or status');
select tests.clear_auth();
select tests.authenticate_as_service_role();
select ok(not ((select public.fn_verify_pin((select cashier from _ctx), '3456'))::text ~* '(pin_hash|\$2[aby]\$)'), 'fn_verify_pin (ok) never returns the hash');
select ok(not ((select public.fn_verify_pin((select cashier from _ctx), '0000'))::text ~* '(pin_hash|\$2[aby]\$)'), 'fn_verify_pin (bad pin) never returns the hash');
select ok(not ((select public.fn_register_pin_failure((select cashier from _ctx)))::text ~* '(pin_hash|\$2[aby]\$)'), 'fn_register_pin_failure never returns the hash');
select lives_ok(format($q$select public.fn_set_user_pin(%L, encode(sha256('2468'::bytea), 'hex'))$q$, (select cashier from _ctx)), 'PIN rotation (service) works');
select tests.clear_auth();
select is((select count(*)::int from public.audit_logs
           where coalesce(old_data::text, '') || coalesce(new_data::text, '') ~* '(pin_hash|token_hash|\$2[aby]\$|[0-9a-f]{64})'), 0,
          'audit_logs never contain a PIN hash, token hash or any 64-hex digest');
select ok((select pin_hash ~ '^\$2[aby]\$' from public.profile_secrets where profile_id = (select cashier from _ctx)), 'PINs are stored as bcrypt hashes');
select ok((select count(*) from public.profile_secrets where pin_hash ~ '^[0-9]{4,8}$') = 0, 'no plaintext PIN is stored');

-- ═════════ Realtime publication ═════════
select is((select puballtables or pubviaroot from pg_publication where pubname = 'supabase_realtime'), false, 'supabase_realtime is not FOR ALL TABLES');
select is((select count(*)::int from pg_publication_namespace pn join pg_publication p on p.oid = pn.pnpubid where p.pubname = 'supabase_realtime'), 0, 'no schema-wide publication (tables are listed one by one)');
select is((select string_agg(pt.tablename, ',') from pg_publication_tables pt join _tbl t on t.name = pt.tablename
           where pt.pubname = 'supabase_realtime' and pt.schemaname = 'public' and not (t.rls and t.forced)),
          null, 'every table in supabase_realtime has RLS enabled and forced');
select is((select string_agg(pt.tablename, ',') from pg_publication_tables pt
           where pt.pubname = 'supabase_realtime' and not (pt.tablename in (select tests.tenant_tables()))),
          null, 'every published table has restaurant_id (tenant filters work on every event)');
select is((select string_agg(pt.tablename || '.' || a, ',' order by pt.tablename)
           from pg_publication_tables pt, unnest(pt.attnames) a
           where pt.pubname = 'supabase_realtime' and a ~ '(hash|secret|token|password)'),
          null,
          'Realtime streams no secret-looking column at all (orders uses a column list)');
select is((select string_agg(pt.tablename || '.' || a, ',' order by pt.tablename, a)
           from pg_publication_tables pt, unnest(pt.attnames) a
           where pt.pubname = 'supabase_realtime' and pt.tablename = 'orders' and a in ('public_token_hash', 'station_ids')),
          null, 'orders: public_token_hash and the internal station_ids are not published');
select is((select string_agg(c.relname, ',') from pg_publication_tables pt join pg_class c on c.relname = pt.tablename and c.relnamespace = 'public'::regnamespace
           where pt.pubname = 'supabase_realtime' and c.relreplident <> 'f' and c.relname not in ('orders', 'user_notifications')), null, 'published tables use REPLICA IDENTITY FULL (restaurant_id present on UPDATE/DELETE)');
select is((select c.relreplident::text from pg_class c where c.oid = 'public.orders'::regclass), 'i', 'orders (column-list publication) uses REPLICA IDENTITY USING INDEX');
select is((select string_agg(a.attname, ',' order by a.attname) from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey) where i.indrelid = 'public.orders'::regclass and i.indisreplident), 'id,restaurant_id', 'and that index is exactly (restaurant_id, id)');

-- ═════════ default privileges ═════════
select is((select count(*)::int from pg_default_acl d
           where d.defaclrole = 'postgres'::regrole and d.defaclnamespace = 'public'::regnamespace
             and d.defaclacl::text ~ '(\{|,)(anon|authenticated)?='),
          0, 'future objects created by the migration role are not granted to anon / authenticated / PUBLIC by default');

select * from finish();
rollback;
