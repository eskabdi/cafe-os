-- 0010  Hardening found by the adversarial pgTAP suite (supabase/tests/database/1*_*.test.sql)
--
--  1. Realtime streamed qr_credentials.token_hash (postgres_changes sends whole rows; column privileges do not
--     apply to the stream). QR credentials are fetched, never subscribed to: remove the table from the publication.
--  2. restaurants.branding.logo_path accepted ANY well-formed tenant path, so tenant A could point its logo at
--     tenant B's Storage object. It must live under the tenant's own prefix (menu_items.image_path already does).
--  3. platform_admins and tenant profiles must stay disjoint in both directions (profiles already refuse a platform
--     admin id); a super admin could register an existing tenant staff account as platform staff.
--     The guard is an AFTER trigger on purpose: BEFORE triggers run before the RLS WITH CHECK, so a BEFORE guard
--     would let any tenant user probe "is this uuid a tenant staff account?" (different error than RLS denial).
--  4. fn_expense_context (BEFORE INSERT) looked up the payment method before RLS was evaluated, so a caller naming
--     another tenant's restaurant_id could tell a real method id from an unknown one. It now refuses a foreign
--     restaurant_id first, with the same 42501 the RLS policy raises.
--  5. An expense recorded while no business day was open got day_session_id = NULL: it belonged to no day, was never
--     frozen by a day close and was invisible to every day's totals (durable-financial-history hole). Expenses now
--     require an OPEN day (error day_closed), also when a service caller names a closed day explicitly.
--
-- Convention reminder: functions get EXECUTE for PUBLIC by default in Postgres, and default privileges cannot
-- change that safely. Every migration that adds a function MUST revoke it explicitly (see the block below);
-- supabase/tests/database/13_security_hygiene.test.sql fails when a function is executable by PUBLIC or anon
-- outside the reviewed allowlist.

-- 1 ── Realtime
do $$
begin
  if exists (select 1 from pg_publication_tables
             where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'qr_credentials') then
    alter publication supabase_realtime drop table public.qr_credentials;
  end if;
end $$;

-- 2 ── logo path is tenant-scoped
alter table public.restaurants
  add constraint restaurants_logo_own_tenant_check check (
    (branding ->> 'logo_path') is null
    or (branding ->> 'logo_path') like 'restaurants/' || id::text || '/%'
  );

-- 3 ── identities stay disjoint
create or replace function public.fn_guard_platform_admin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.profiles p where p.id = new.id) then
    perform public.fn_err('auth_method_mismatch', 'tenant staff cannot become platform admins');
  end if;
  return new;
end;
$$;
create trigger trg_guard_platform_admin after insert or update of id on public.platform_admins
  for each row execute function public.fn_guard_platform_admin();

revoke all on function public.fn_guard_platform_admin() from public, anon, authenticated;

-- 4/5 ── expenses: tenant check before any lookup + open-day requirement (create or replace of the 0006 function; only the INSERT branch changes)
create or replace function public.fn_expense_context()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_day uuid;
begin
  if tg_op = 'DELETE' then
    if old.day_session_id is not null
       and exists (select 1 from public.day_sessions d where d.id = old.day_session_id and d.status = 'closed') then
      perform public.fn_err('day_closed');
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' then
    if old.day_session_id is not null
       and exists (select 1 from public.day_sessions d where d.id = old.day_session_id and d.status = 'closed') then
      perform public.fn_err('day_closed');
    end if;
    new.created_by := old.created_by;
    new.day_session_id := old.day_session_id;
    if new.payment_method_id is not distinct from old.payment_method_id then
      new.method_name_snapshot := old.method_name_snapshot;
      new.method_affects_drawer_snapshot := old.method_affects_drawer_snapshot;
    end if;
  else
    -- INSERT: a client may only insert into its own tenant. Checked BEFORE any lookup so the error cannot
    -- distinguish another tenant's ids from unknown ones (same SQLSTATE/message as the RLS policy).
    if (select auth.uid()) is not null then
      if new.restaurant_id is distinct from (select public.current_restaurant_id()) then
        raise exception using errcode = '42501',
          message = 'new row violates row-level security policy for table "expenses"';
      end if;
      new.created_by := (select public.current_user_id());
      new.day_session_id := null;
    end if;
    if new.day_session_id is null then
      select d.id into v_day from public.day_sessions d
      where d.restaurant_id = new.restaurant_id and d.status = 'open';
      new.day_session_id := v_day;
    end if;
    -- an expense always belongs to an OPEN business day of its own tenant
    if new.day_session_id is null
       or exists (select 1 from public.day_sessions d
                  where d.id = new.day_session_id and d.restaurant_id = new.restaurant_id and d.status = 'closed') then
      perform public.fn_err('day_closed');
    end if;
  end if;

  if tg_op = 'INSERT' or new.payment_method_id is distinct from old.payment_method_id then
    select pm.name, pm.affects_cash_drawer into new.method_name_snapshot, new.method_affects_drawer_snapshot
    from public.payment_methods pm
    where pm.id = new.payment_method_id and pm.restaurant_id = new.restaurant_id;
    if not found then
      perform public.fn_err('invalid_reference', 'payment_method_id');
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.fn_expense_context() from public, anon, authenticated;
