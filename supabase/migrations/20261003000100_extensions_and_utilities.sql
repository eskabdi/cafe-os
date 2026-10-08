-- 0001  Extensions + generic utility functions
-- Valid on the real Supabase stack (extensions already live in schema "extensions")
-- and on the plain-Postgres test shim (scripts/db/shim/00_supabase_shim.sql).

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- ── Error convention ────────────────────────────────────────────────────────
-- Every business/authorization failure is raised as:
--   errcode = 'P0001' (plpgsql default for RAISE EXCEPTION)
--   message = stable machine code   (permission_denied, tenant_suspended, ...)
--   detail  = safe, non-sensitive context (never SQL text, never cross-tenant ids)
-- See docs/architecture/rpc-conventions.md.
create or replace function public.fn_err(p_code text, p_detail text default null)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_detail is null then
    raise exception using errcode = 'P0001', message = p_code;
  end if;
  raise exception using errcode = 'P0001', message = p_code, detail = p_detail;
end;
$$;

-- ── Generic trigger functions ───────────────────────────────────────────────
create or replace function public.fn_set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Append-only / immutable rows (audit logs, payments, stock ledger, admin audit).
-- Fires for every role, including service_role and the table owner.
create or replace function public.fn_forbid_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform public.fn_err('immutable_record', tg_table_name::text);
  return null;
end;
$$;

-- restaurant_id is the tenant key: it can never be changed after insert.
create or replace function public.fn_lock_restaurant_id()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.restaurant_id is distinct from old.restaurant_id then
    perform public.fn_err('tenant_change_forbidden', tg_table_name::text);
  end if;
  return new;
end;
$$;
