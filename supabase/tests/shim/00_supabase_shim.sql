-- Supabase-compat shim for PLAIN Postgres (scripts/db-test.sh). NEVER applied to a real Supabase project
-- and NOT part of supabase/migrations. Mirrors only what migrations/seed/tests rely on.
-- Known differences vs. real Supabase: `postgres` is a superuser here (BYPASSRLS on Supabase), no GoTrue,
-- no PostgREST, no Realtime server, storage schema is a stub.

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'supabase_admin') then
    raise exception 'shim must not run on a real Supabase database';
  end if;
end $$;

create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role authenticator login noinherit;
create role supabase_auth_admin nologin noinherit createrole;
grant anon, authenticated, service_role to authenticator;

create schema if not exists extensions;
create schema if not exists auth;
create schema if not exists storage;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;
create extension if not exists citext with schema extensions;

grant usage on schema extensions, auth, storage to anon, authenticated, service_role;
alter database postgres set search_path to "$user", public, extensions;
set search_path to "$user", public, extensions;

-- auth.users: superset of the columns seed.sql writes (GoTrue token columns are NOT NULL '' on real stacks)
create table auth.users (
  instance_id uuid,
  id uuid primary key,
  aud varchar(255),
  role varchar(255),
  email varchar(255),
  encrypted_password varchar(255),
  email_confirmed_at timestamptz,
  confirmation_token varchar(255) default '',
  recovery_token varchar(255) default '',
  email_change_token_new varchar(255) default '',
  email_change varchar(255) default '',
  raw_app_meta_data jsonb,
  raw_user_meta_data jsonb,
  is_super_admin boolean,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create unique index users_email_idx on auth.users (lower(email));
alter table auth.users enable row level security;

-- exactly as GoTrue defines them: read the PostgREST-provided request GUCs
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;
create function auth.role() returns text language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;
grant execute on function auth.uid(), auth.role(), auth.jwt() to anon, authenticated, service_role;

-- minimal storage stub (Phase 3 adds policies)
create table storage.buckets (id text primary key, name text not null, public boolean default false);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id),
                              name text, owner uuid, created_at timestamptz default now());
alter table storage.objects enable row level security;

create publication supabase_realtime;

-- Supabase's platform default privileges (the migrations must cope with them)
alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
