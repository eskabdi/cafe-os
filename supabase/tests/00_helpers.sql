-- pgTAP helpers shared by every test file. Committed (not rolled back) so later files can use them.
-- Works on plain Postgres (scripts/db-test.sh) and `supabase test db`.
create schema if not exists tests;
grant usage on schema tests to anon, authenticated, service_role;

-- Become an authenticated end user: role + JWT claims exactly as PostgREST would set them.
create or replace function tests.authenticate_as(p_user_id uuid) returns void
language plpgsql as $$
begin
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

-- convenience lookups used by the tests (superuser context)
create or replace function tests.tenant_id(p_slug text) returns uuid
language sql stable security definer set search_path = '' as $$ select id from public.restaurants where slug = p_slug $$;
create or replace function tests.user_id(p_username text, p_slug text) returns uuid
language sql stable security definer set search_path = '' as $$
  select p.id from public.profiles p join public.restaurants r on r.id = p.restaurant_id
  where p.username = p_username and r.slug = p_slug $$;
grant execute on all functions in schema tests to anon, authenticated, service_role;

select plan(2);
select has_function('tests', 'authenticate_as', array['uuid'], 'authenticate_as helper exists');
select has_function('tests', 'clear_auth', 'clear_auth helper exists');
select * from finish();
