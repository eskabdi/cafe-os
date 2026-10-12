-- Phase 11 hardening: catalog invariants that keep the audit's findings closed, plus a catalog-DRIVEN cross-tenant
-- penetration sweep (every tenant table, every granted verb), so a table added later is probed without editing this file.
-- Complements 13_security_hygiene (definer/search_path/EXECUTE/RLS forced/secrets/realtime), 21 (FK indexes),
-- 24 (Storage path policies) and 01 (no ON DELETE CASCADE). See docs/security/hardening-report.md.
begin;
select plan(23);

-- ═════════ RLS: a policy for every verb a client role is granted ═════════
create temp view _grants as
select c.oid, c.relname::text as tbl, v.verb, r.role
from pg_class c
cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) v(verb)
cross join unnest(array['anon', 'authenticated']) r(role)
where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
  and case v.verb
        when 'SELECT' then has_any_column_privilege(r.role, c.oid, 'select')
        when 'INSERT' then has_any_column_privilege(r.role, c.oid, 'insert')
        when 'UPDATE' then has_any_column_privilege(r.role, c.oid, 'update')
        else has_table_privilege(r.role, c.oid, 'delete') end;
grant select on _grants to public;

select is((select string_agg(g.role || ':' || g.tbl || ':' || g.verb, ',' order by g.tbl, g.verb) from _grants g
           where not exists (select 1 from pg_policies p
                             where p.schemaname = 'public' and p.tablename = g.tbl and p.cmd = g.verb
                               and p.roles && array[g.role, 'public']::name[])),
          null, 'every verb granted to anon/authenticated on a public table has a policy for that verb and role');
select is((select string_agg(tablename || '.' || policyname, ',' order by tablename, policyname) from pg_policies
           where schemaname in ('public', 'storage') and cmd = 'INSERT' and with_check is null),
          null, 'every INSERT policy has a WITH CHECK');
select is((select string_agg(tablename || '.' || policyname, ',' order by tablename, policyname) from pg_policies
           where schemaname = 'public' and permissive = 'PERMISSIVE' and cmd = 'UPDATE' and with_check is null and qual is null),
          null, 'no UPDATE policy is unconstrained');

-- ═════════ FK hygiene ═════════
select is((select string_agg(conrelid::regclass || '.' || conname, ',' order by conname) from pg_constraint
           where contype = 'f' and connamespace = 'public'::regnamespace
             and (confdeltype in ('c', 'n', 'd') or confupdtype in ('c', 'n', 'd'))),
          null, 'no FK in public uses CASCADE / SET NULL / SET DEFAULT on delete or update (RESTRICT + soft deactivation)');
select is((select string_agg(c.relname, ',' order by c.relname) from pg_class c
           where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
             and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'restaurant_id' and not a.attisdropped)
             and not exists (select 1 from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = (i.indkey::int2[])[0]
                             where i.indrelid = c.oid and i.indisvalid and a.attname = 'restaurant_id')),
          null, 'every tenant table has an index leading with restaurant_id (RLS predicate, tenant purge)');
select is((select string_agg(x.idx, ',') from (
             select string_agg(indexrelid::regclass::text, '=' order by indexrelid::regclass::text) idx
             from pg_index where indrelid in (select oid from pg_class where relnamespace = 'public'::regnamespace)
             group by indrelid, indkey::text, indclass::text, coalesce(indpred::text, ''), coalesce(indexprs::text, '')
             having count(*) > 1) x),
          null, 'no duplicate index (same columns, opclasses, predicate) in public');
select is((select string_agg(conrelid::regclass::text, ',') from pg_constraint c
           where c.contype = 'f' and c.connamespace = 'public'::regnamespace and not c.convalidated),
          null, 'every FK is validated');

-- ═════════ RLS performance: helper calls are init-plans, helpers are STABLE ═════════
select is((select string_agg(tablename || '.' || policyname, ',' order by tablename, policyname) from pg_policies
           where schemaname in ('public', 'storage')
             and regexp_replace(coalesce(qual, '') || ' ' || coalesce(with_check, ''),
                                'SELECT (public\.)?(current_restaurant_id|current_user_id|current_role_id|current_station_ids|current_tenant_writable|has_permission|is_platform_admin|is_platform_super_admin|is_tenant_admin)\(', '', 'g')
                 ~ '(^|[^_a-z])(current_restaurant_id|current_user_id|current_role_id|current_tenant_writable|has_permission|is_platform_admin|is_platform_super_admin|is_tenant_admin)\('),
          null, 'every auth helper in a policy is wrapped in (select ...) so it runs once per statement, not per row');
select is((select string_agg(proname, ',' order by proname) from pg_proc
           where pronamespace = 'public'::regnamespace and provolatile <> 's'
             and proname in ('current_restaurant_id', 'current_user_id', 'current_role_id', 'current_station_ids', 'current_tenant_writable',
                             'has_permission', 'has_station_access', 'is_platform_admin', 'is_platform_super_admin', 'is_tenant_admin')),
          null, 'RLS helper functions are STABLE');

-- ═════════ error handling: no raw SQL error text is re-raised to a client ═════════
select is((select string_agg(proname, ',' order by proname) from pg_proc
           where pronamespace = 'public'::regnamespace and prosrc ~* '(sqlerrm|message_text|pg_exception_detail|pg_exception_context)'),
          null, 'no function in public echoes SQLERRM / exception text (clients only ever see fn_err machine codes)');
select is((select string_agg(proname, ',' order by proname) from pg_proc
           where pronamespace = 'public'::regnamespace and has_function_privilege('authenticated', oid, 'execute') and prosecdef
             and prosrc ~* 'raise\s+exception\s+''[^'']*%' ),
          null, 'no client-callable definer interpolates values into a raw RAISE EXCEPTION message');

-- ═════════ Storage ═════════
select is((select string_agg(id, ',' order by id) from storage.buckets
           where public or file_size_limit is null or file_size_limit > 5 * 1024 * 1024
              or allowed_mime_types is null or not (allowed_mime_types <@ array['image/png', 'image/jpeg', 'image/webp'])),
          null, 'every bucket is private, size-capped (<= 5 MB) and MIME-allowlisted to raster images (no SVG / HTML)');
select is((select string_agg(policyname, ',' order by policyname) from pg_policies
           where schemaname = 'storage' and cmd in ('INSERT', 'UPDATE')
             and not (coalesce(with_check, '') ~ 'current_tenant_writable' and coalesce(with_check, '') ~ '\\\.\\\.'
                      and coalesce(with_check, '') ~ 'restaurants/''.*current_restaurant_id')),
          null, 'every Storage write policy pins restaurants/<own tenant>/, refuses "..", and needs a writable tenant');
select is((select string_agg(policyname, ',' order by policyname) from pg_policies
           where schemaname = 'storage' and cmd in ('UPDATE', 'DELETE') and coalesce(qual, '') !~ 'NOT \(EXISTS'),
          null, 'every Storage overwrite / delete policy refuses an object still referenced by a row');
select is((select string_agg(policyname, ',' order by policyname) from pg_policies where schemaname = 'storage' and cmd = 'ALL'),
          null, 'no FOR ALL Storage policy');

-- ═════════ catalog-driven cross-tenant penetration sweep ═════════
-- per table: the verbs authenticated holds, a column it may UPDATE, and how many rows OTHER tenants own (so the
-- sweep is not vacuous). Platform/global tables are excluded (no restaurant_id).
create temp table _probe on commit drop as
select g.tbl,
       bool_or(g.verb = 'SELECT') can_select,
       bool_or(g.verb = 'UPDATE') can_update,
       bool_or(g.verb = 'DELETE') can_delete,
       (select a.attname::text from pg_attribute a
        where a.attrelid = ('public.' || g.tbl)::regclass and a.attnum > 0 and not a.attisdropped
          and has_column_privilege('authenticated', a.attrelid, a.attnum, 'update') order by a.attnum limit 1) upd_col
from _grants g
where g.role = 'authenticated' and g.tbl in (select tests.tenant_tables())
group by g.tbl;
alter table _probe add column foreign_rows bigint, add column seen text, add column upd text, add column del text;
do $$
declare r record; v bigint;
begin
  for r in select tbl from _probe loop
    execute format('select count(*) from public.%I where restaurant_id is distinct from %L', r.tbl, tests.tenant_id('central-cafe')) into v;
    update _probe set foreign_rows = v where tbl = r.tbl;
  end loop;
end $$;
grant all on _probe to public;

select ok((select count(*) from _probe where can_select and foreign_rows > 0) >= 10,
          'the sweep is meaningful: >= 10 client-readable tenant tables hold rows of another tenant');

create or replace function pg_temp.sweep(p_me uuid) returns void language plpgsql as $$
declare r record; v bigint;
begin
  for r in select * from _probe loop
    if r.can_select then
      execute format('select count(*) from public.%I where restaurant_id is distinct from %L', r.tbl, p_me) into v;
      update _probe set seen = v::text where tbl = r.tbl;
    end if;
    if r.can_update and r.upd_col is not null then
      update _probe set upd = tests.run(format('update public.%I set %I = %I where restaurant_id is distinct from %L', r.tbl, r.upd_col, r.upd_col, p_me))
      where tbl = r.tbl;
    end if;
    if r.can_delete then
      update _probe set del = tests.run(format('delete from public.%I where restaurant_id is distinct from %L', r.tbl, p_me)) where tbl = r.tbl;
    end if;
  end loop;
end $$;
grant execute on function pg_temp.sweep(uuid) to public;

-- tenant admin of central-cafe (holds every tenant permission)
select tests.authenticate_as(tests.user_id('selam', 'central-cafe'));
select pg_temp.sweep(tests.tenant_id('central-cafe'));
select tests.clear_auth();
select is((select string_agg(tbl || '=' || seen, ',' order by tbl) from _probe where can_select and seen <> '0'), null,
          'tenant admin A: SELECT on every tenant table returns zero rows of other tenants');
select is((select string_agg(tbl || '=' || upd, ',' order by tbl) from _probe where upd is not null and upd !~ '^(ok:0|42501\|)'), null,
          'tenant admin A: UPDATE of another tenant''s rows touches nothing on every updatable tenant table');
select is((select string_agg(tbl || '=' || del, ',' order by tbl) from _probe where del is not null and del !~ '^(ok:0|42501\|)'), null,
          'tenant admin A: DELETE of another tenant''s rows touches nothing on every deletable tenant table');

-- a plain staff member (kitchen) of central-cafe
update _probe set seen = null, upd = null, del = null;
select tests.authenticate_as(tests.user_id('abebe', 'central-cafe'));
select pg_temp.sweep(tests.tenant_id('central-cafe'));
select tests.clear_auth();
select is((select string_agg(tbl || '=' || coalesce(seen, '') || '/' || coalesce(upd, '') || '/' || coalesce(del, ''), ',' order by tbl) from _probe
           where seen <> '0' or upd !~ '^(ok:0|42501\|)' or del !~ '^(ok:0|42501\|)'), null,
          'staff A: no cross-tenant read, update or delete on any tenant table');

-- the second tenant's admin, against central-cafe's rows
update _probe set seen = null, upd = null, del = null;
select tests.authenticate_as((select p.id from public.profiles p join public.roles r on r.id = p.role_id
                              where p.restaurant_id = tests.tenant_id('second-cafe') and r.is_system and p.is_active limit 1));
select pg_temp.sweep(tests.tenant_id('second-cafe'));
select tests.clear_auth();
select is((select string_agg(tbl || '=' || coalesce(seen, '') || '/' || coalesce(upd, '') || '/' || coalesce(del, ''), ',' order by tbl) from _probe
           where seen <> '0' or upd !~ '^(ok:0|42501\|)' or del !~ '^(ok:0|42501\|)'), null,
          'tenant admin B: no cross-tenant read, update or delete on any tenant table');

-- anon: no tenant table is readable at all
create temp table _anon on commit drop as select tbl, null::text res from _probe;
grant all on _anon to public;
select tests.as_anon();
do $$ declare r record; begin
  for r in select tbl from _anon loop
    update _anon set res = tests.run(format('select 1 from public.%I limit 1', r.tbl)) where tbl = r.tbl;
  end loop;
end $$;
select tests.clear_auth();
select is((select string_agg(tbl || '=' || res, ',' order by tbl) from _anon where res !~ '^(ok:0|42501\|)'), null,
          'anon reads no row of any tenant table');

-- a platform super admin (aal2) never sees tenant operational data (two-portal rule)
select tests.aal2('00000000-0000-4000-8000-0000000000c1');
select is((select string_agg(t, ',' order by t) from (values ('orders'), ('order_items'), ('payments'), ('day_sessions'), ('expenses'),
                                                             ('stock_movements'), ('vouchers'), ('installments'), ('menu_items'), ('ingredients'), ('audit_logs')) v(t)
           where tests.run(format('select 1 from public.%I limit 1', t)) !~ '^(ok:0|42501\|)'),
          null, 'platform super admin reads no tenant operational row');
select tests.clear_auth();

select * from finish();
rollback;
