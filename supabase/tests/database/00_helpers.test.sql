-- pgTAP helpers shared by every other file. Installs schema `tests` (COMMITTED, on purpose).
--
-- WHY THIS SHAPE (verified against the Supabase CLI's `supabase test db` implementation):
--   * The CLI runs `pg_prove --ext .pg --ext .sql -r` over supabase/tests, one psql session per file,
--     sequentially, in sorted path order, against the local dev/CI database. It also executes EVERY .sql
--     file it finds, so each file here must be a valid pgTAP file with a plan (no shim/include files).
--   * A rolled-back file cannot hand helpers to the next file, and plain pgTAP files cannot `include` one
--     another (the CLI mounts the folder read-only into a container; \ir paths are not portable).
--   * Therefore this file sorts first (00_), creates the helpers with `commit`, and 99_cleanup.test.sql
--     (sorts last) drops them again, so a test run leaves no `tests` schema behind in the dev database.
--   * Every later file is `begin; ... rollback;` and uses the helpers. Running a single later file needs
--     this file to have run once before (scripts/db-test.sh always prepends it for subsets).
--   * NEVER run these tests against a production / linked project: they create fixtures (inside rolled-back
--     transactions) and this file commits a helper schema.
--   * The CLI creates pgTAP before running and drops it afterwards if it was not installed. Nothing here
--     depends on pgTAP at the object level, so that DROP EXTENSION always succeeds.
create extension if not exists pgtap with schema extensions;

begin;
select plan(1);

create schema if not exists tests;
grant usage on schema tests to anon, authenticated, service_role;

-- Become an authenticated end user: role + JWT claims exactly as PostgREST would set them.
create or replace function tests.authenticate_as(p_user_id uuid) returns void
language plpgsql as $$
begin
  -- Platform admins need aal2 in production (migration 0015). Tests opt out per transaction so they do not depend on
  -- a database-level setting (the real stack has none); 20_platform_hardening.test.sql exercises the gate itself.
  perform set_config('app.platform_mfa_required', 'off', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user_id, 'role', 'authenticated', 'aud', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', p_user_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  execute 'set local role authenticated';
end $$;

create or replace function tests.authenticate_as_service_role() returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  execute 'set local role service_role';
end $$;

create or replace function tests.as_anon() returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', 'anon', true);
  execute 'set local role anon';
end $$;

create or replace function tests.clear_auth() returns void
language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', '', true);
end $$;

-- Fixture lookups (definer, so they work under any role and bypass RLS).
create or replace function tests.tenant_id(p_slug text) returns uuid
language sql stable security definer set search_path = '' as $$ select id from public.restaurants where slug = p_slug $$;
create or replace function tests.user_id(p_username text, p_slug text) returns uuid
language sql stable security definer set search_path = '' as $$
  select p.id from public.profiles p join public.restaurants r on r.id = p.restaurant_id
  where p.username = p_username and r.slug = p_slug $$;
create or replace function tests.role_id(p_name text, p_slug text) returns uuid
language sql stable security definer set search_path = '' as $$
  select ro.id from public.roles ro join public.restaurants r on r.id = ro.restaurant_id
  where ro.normalized_name = lower(p_name) and r.slug = p_slug $$;
create or replace function tests.admin_role_id(p_slug text) returns uuid
language sql stable security definer set search_path = '' as $$
  select ro.id from public.roles ro join public.restaurants r on r.id = ro.restaurant_id
  where ro.system_key = 'tenant_admin' and r.slug = p_slug $$;

-- Run one statement as the CURRENT role (security invoker) and describe the outcome as a string:
--   'ok:<rows>'  or  '<sqlstate>|<message>|<detail>'  (uuids normalised, so two denials for different ids
-- compare equal exactly when the error leaks no id-specific information).
create or replace function tests.run(p_sql text) returns text
language plpgsql as $$
declare
  v_rows bigint;
  v_state text; v_msg text; v_detail text;
begin
  execute p_sql;
  get diagnostics v_rows = row_count;
  return 'ok:' || v_rows;
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_detail = pg_exception_detail;
  return v_state || '|' ||
    regexp_replace(coalesce(v_msg, ''), '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', '<uuid>', 'g') || '|' ||
    regexp_replace(coalesce(v_detail, ''), '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', '<uuid>', 'g');
end $$;

-- Existence-oracle probe. The template holds the token {id}; it is run once with a REAL foreign id and once
-- with a random id that exists nowhere. Returns the common outcome (tests.run format) when both are
-- indistinguishable, or 'LEAK|real=...|unknown=...' when the caller could tell them apart.
create or replace function tests.oracle(p_template text, p_real uuid) returns text
language plpgsql as $$
declare
  v_real text := tests.run(replace(p_template, '{id}', quote_literal(p_real::text)));
  v_fake text := tests.run(replace(p_template, '{id}', quote_literal(gen_random_uuid()::text)));
begin
  if v_real = v_fake then return v_real; end if;
  return 'LEAK|real=' || v_real || '|unknown=' || v_fake;
end $$;

-- Minimal auth.users row for fixtures (columns that exist on both GoTrue and the plain-Postgres shim).
create or replace function tests.create_auth_user(p_id uuid, p_email text) returns uuid
language plpgsql as $$
begin
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, confirmation_token, recovery_token,
                          email_change_token_new, email_change)
  values ('00000000-0000-0000-0000-000000000000', p_id, 'authenticated', 'authenticated', p_email,
          extensions.crypt(gen_random_uuid()::text, extensions.gen_salt('bf')), now(),
          '{"provider":"email","providers":["email"]}', '{}', '', '', '', '');
  return p_id;
end $$;

-- Every public table that carries a restaurant_id column (the tenant tables), by name.
create or replace function tests.tenant_tables() returns setof text
language sql stable as $$
  select c.relname::text
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
    and exists (select 1 from pg_attribute a
                where a.attrelid = c.oid and a.attname = 'restaurant_id' and a.attnum > 0 and not a.attisdropped)
  order by 1 $$;

-- Content fingerprint of everything a tenant owns (every tenant table + its restaurants row). Owned by the
-- migration role (definer), so it sees all rows whatever role calls it; used to prove "nothing changed".
create or replace function tests.snapshot(p_tenant uuid) returns text
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  t text; s text; acc text;
begin
  select coalesce(string_agg(q::text, chr(10) order by q::text), '') into acc from public.restaurants q where q.id = p_tenant;
  for t in select tests.tenant_tables() loop
    execute format('select coalesce(string_agg(q::text, chr(10) order by q::text), '''') from public.%I q where q.restaurant_id = $1', t)
      into s using p_tenant;
    acc := acc || '|' || t || ':' || s;
  end loop;
  return md5(acc);
end $$;

-- Peppered PIN digest exactly as the Edge Functions compute it: hex(HMAC-SHA256(pin, pepper)). The pepper is the
-- documented DEMO pepper (the one seed.sql uses).
create or replace function tests.pin_digest(p_pin text) returns text
language sql immutable as $$ select encode(extensions.hmac(p_pin, 'cafeos-local-demo-pepper-v1', 'sha256'), 'hex') $$;

grant execute on all functions in schema tests to anon, authenticated, service_role;

select has_function('tests', 'authenticate_as', array['uuid'], 'test helpers installed');
select * from finish();
commit;
