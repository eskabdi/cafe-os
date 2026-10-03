-- Supabase-compat shim for PLAIN Postgres (scripts/db-test.sh). NEVER applied to a real Supabase project;
-- it lives in scripts/db/shim (NOT supabase/tests: `supabase test db` runs every file under supabase/tests)
-- and is NOT part of supabase/migrations. Mirrors only what migrations/seed/tests rely on.
--
-- Run as the cluster superuser `supabase_admin` (as on the real stack). It then creates `postgres` the way
-- Supabase does: a NON-superuser (BYPASSRLS, CREATEROLE, CREATEDB) that owns the database. Migrations, seed
-- and pgTAP files all run as that `postgres`, so privilege problems that only show up on the real stack
-- (no superuser, untrusted extensions, auth.* ownership) show up here too.
-- Known differences vs. real Supabase: no GoTrue, no PostgREST, no Realtime server, storage schema is a stub,
-- auth.users is a column subset of GoTrue's table.

do $$ begin
  if exists (select 1 from pg_roles where rolname in ('supabase_auth_admin', 'authenticator')) then
    raise exception 'shim must not run on a real Supabase database';
  end if;
end $$;

create role postgres login nosuperuser bypassrls createrole createdb;
alter database postgres owner to postgres;
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role authenticator login noinherit;
create role supabase_auth_admin nologin noinherit createrole;
grant anon, authenticated, service_role to authenticator;
grant anon, authenticated, service_role to postgres;   -- lets postgres `set role` to them (as on Supabase)

create schema if not exists extensions;
create schema if not exists auth;
create schema if not exists storage;
-- extensions are preinstalled on Supabase (postgres cannot create untrusted ones itself)
create extension if not exists pgcrypto with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;
create extension if not exists citext with schema extensions;
create extension if not exists pgtap with schema extensions;

grant usage on schema extensions, auth, storage to anon, authenticated, service_role, postgres;
alter database postgres set search_path to "$user", public, extensions;
-- local/CI posture: platform admins are not forced through TOTP (production default = required; see migration 0015)
alter database postgres set app.platform_mfa_required to 'off';
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

-- MFA factors (subset of GoTrue's auth.mfa_factors): fn_platform_mfa_satisfied / fn_require_step_up read it
create table auth.mfa_factors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  friendly_name text,
  factor_type text not null default 'totp',
  status text not null default 'unverified' check (status in ('unverified','verified')),
  created_at timestamptz default now()
);
alter table auth.mfa_factors enable row level security;

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
-- postgres may read/write auth.users (seed and tests do) but does not own the auth schema
grant all on all tables in schema auth to postgres;

-- minimal storage stub (Phase 3 adds policies)
create table storage.buckets (id text primary key, name text not null, public boolean default false);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id),
                              name text, owner uuid, created_at timestamptz default now());
alter table storage.objects enable row level security;
grant all on all tables in schema storage to postgres;

create publication supabase_realtime;
alter publication supabase_realtime owner to postgres;

-- Supabase's platform default privileges (the migrations must cope with them)
alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
