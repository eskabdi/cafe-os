-- 0011  Privilege hygiene + single audit writer path
--
--  SM1  Postgres grants EXECUTE on every new function to PUBLIC. 0009 only revoked the anon/authenticated
--       default ACL entries, so a function added later was still callable by anon/authenticated through PUBLIC
--       (proved: a probe function was executable by anon). The global default for the migration role is now
--       "no PUBLIC execute" (this statement has no IN SCHEMA on purpose: a schema-scoped REVOKE can only
--       subtract from schema-scoped entries, never from the implicit global PUBLIC grant).
--       The same is applied to supabase_admin when this migration runs with that membership (never true on the
--       local test cluster; on the hosted stack `postgres` is not a member either, hence the guard).
--       service_role no longer receives EXECUTE on new functions automatically either: every new function must be
--       granted explicitly, to exactly the roles that need it (see 13_security_hygiene.test.sql canary).
--  SL1  service_role keeps SELECT/INSERT/UPDATE/DELETE on business tables (RLS bypass is needed by Edge Functions)
--       but loses TRUNCATE / REFERENCES / TRIGGER everywhere, and loses every write privilege on the audit tables:
--       only the SECURITY DEFINER writers (fn_write_audit, fn_write_admin_audit, fn_audit_row) append there.
--  SL7  fn_err is not callable by anon (nothing anonymous raises business errors); authenticated/service_role keep
--       it because invoker-security trigger functions call it.
--  L1   fn_write_audit derives the actor ONLY from auth.uid(). The p_actor_id override is gone (docs claimed this
--       already; the code allowed it). The restaurant override remains for definer callers acting across tenants
--       (platform RPCs, service jobs) but can never name a tenant other than the caller's own when the caller
--       belongs to one.

-- ── SM1 ─────────────────────────────────────────────────────────────────────
alter default privileges for role postgres revoke execute on functions from public;
alter default privileges for role postgres in schema public revoke all on functions from service_role;
-- keep Postgres' normal behaviour for objects postgres creates in the extensions schema (pgTAP installed by
-- `supabase test db` must stay callable by the roles the tests switch to)
alter default privileges for role postgres in schema extensions grant execute on functions to public;

do $$
begin
  if pg_has_role(current_user, 'supabase_admin', 'member') then
    execute 'alter default privileges for role supabase_admin revoke execute on functions from public';
  end if;
end $$;

-- ── SL1 ─────────────────────────────────────────────────────────────────────
revoke truncate, references, trigger on all tables in schema public from service_role;
alter default privileges for role postgres in schema public revoke truncate, references, trigger on tables from service_role;
revoke insert, update, delete on public.audit_logs, public.admin_audit_log from service_role;

-- ── SL7 ─────────────────────────────────────────────────────────────────────
revoke execute on function public.fn_err(text, text) from anon;

-- ── L1: one audit writer, actor = auth.uid() only ───────────────────────────
drop function public.fn_write_audit(text, jsonb, uuid, uuid);
create or replace function public.fn_write_audit(
  p_event text,
  p_record jsonb default null,
  p_restaurant_id uuid default null
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_own uuid := (select public.current_restaurant_id());
  v_rid uuid := coalesce(p_restaurant_id, v_own);
  v_type text;
begin
  if v_rid is null then
    perform public.fn_err('audit_tenant_unresolved');
  end if;
  -- a tenant user can only ever write to its own tenant's trail
  if v_own is not null and v_rid is distinct from v_own then
    perform public.fn_err('permission_denied');
  end if;
  v_type := case
    when v_uid is null then 'system'
    when exists (select 1 from public.platform_admins pa where pa.id = v_uid) then 'platform_admin'
    else 'user'
  end;
  insert into public.audit_logs (restaurant_id, actor_id, actor_type, event, action, new_data)
  values (v_rid, v_uid, v_type, p_event, 'event', p_record);
end;
$$;
revoke all on function public.fn_write_audit(text, jsonb, uuid) from public, anon, authenticated, service_role;
