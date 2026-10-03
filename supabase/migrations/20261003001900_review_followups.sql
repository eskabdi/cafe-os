-- 0019  Review/audit follow-ups
--
--  * Branding: size cap (pg_column_size < 4096), key whitelist (logo_path, primary_color, accent_color) and the hex-colour
--    format, as a dedicated CHECK (restaurants_branding_shape_check) next to the 0002 / 0010 path checks.
--  * Closed-day installments: the only post-close change is settling an UNPAID installment with a payment of the open
--    day (old.payment_id is null, new.paid, new.payment_id not null); un-paying or re-pointing is day_closed.
--  * fn_guard_closed_day: an INSERT into stock_movements / table_sessions without a business day raises no_open_day
--    (a NULL day would escape every freeze).
--  * fn_guard_profile_auth_method: identity checks run on INSERT or when auth_method / role_id /
--    identity_rotation_pending change, so narrowing (is_active = false) and renames are never blocked by them.
--  * fn_guard_profile_update (SL3/L6): renaming (first/middle/last name, username) another user needs the same
--    "caller covers the target's role" rule as is_active / role changes.
--  * Realtime: orders leaves the publication's secret column (public_token_hash) and the internal station_ids: the
--    publication now carries a column list (PG15) and orders uses REPLICA IDENTITY USING INDEX (restaurant_id, id)
--    so tenant filters still work on UPDATE/DELETE events. customer_sessions is not published (and must not be: it holds
--    session_token_hash).

-- ── branding ────────────────────────────────────────────────────────────────
alter table public.restaurants add constraint restaurants_branding_shape_check check (
  pg_column_size(branding) < 4096
  and jsonb_typeof(branding) = 'object'
  and (branding - 'logo_path' - 'primary_color' - 'accent_color') = '{}'::jsonb   -- key whitelist
  and (branding ->> 'primary_color') ~ '^#[0-9a-fA-F]{6}$'
  and (branding ->> 'accent_color') ~ '^#[0-9a-fA-F]{6}$'
);

-- ── guards (full replacements) ──────────────────────────────────────────────
create or replace function public.fn_guard_closed_day()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_kind    text   := tg_argv[0];
  v_allowed text[] := string_to_array(coalesce(tg_argv[1], ''), ',');
  v_old     jsonb;
  v_new     jsonb;
  v_changed text[];
  v_day     uuid;
  v_days    uuid[] := '{}';
  v_status  text;
  v_row     jsonb;
  v_pay_day uuid;
begin
  if tg_op = 'DELETE' then v_old := to_jsonb(old);
  elsif tg_op = 'INSERT' then v_new := to_jsonb(new);
  else v_old := to_jsonb(old); v_new := to_jsonb(new);
  end if;

  -- an UPDATE that only touches allowlisted columns skips the day freeze
  if tg_op = 'UPDATE' and cardinality(v_allowed) > 0 then
    select array_agg(k.key) into v_changed
    from jsonb_each(v_new) k
    where k.key <> 'updated_at' and v_old -> k.key is distinct from k.value;
    if v_changed is not null and v_changed <@ v_allowed then
      if tg_table_name = 'installments' then
        -- the ONE compensating path: an unpaid installment is settled by a payment of the OPEN day.
        -- Nothing else (un-paying, re-pointing the payment, editing a settled row) is allowed after the close.
        if (v_old ->> 'payment_id') is not null
           or (v_new ->> 'payment_id') is null
           or coalesce((v_new ->> 'paid')::boolean, false) is not true then
          perform public.fn_err('day_closed');
        end if;
        select p.day_session_id into v_pay_day from public.payments p where p.id = (v_new ->> 'payment_id')::uuid;
        if v_pay_day is null or exists (select 1 from public.day_sessions d where d.id = v_pay_day and d.status = 'closed') then
          perform public.fn_err('day_closed');
        end if;
      end if;
      return new;
    end if;
  end if;

  foreach v_row in array array[v_old, v_new] loop
    continue when v_row is null;
    v_day := case v_kind
      when 'self' then (v_row ->> 'day_session_id')::uuid
      when 'order' then (select o.day_session_id from public.orders o where o.id = (v_row ->> 'order_id')::uuid)
      when 'voucher' then (select o.day_session_id from public.vouchers v join public.orders o on o.id = v.order_id
                           where v.id = (v_row ->> 'voucher_id')::uuid)
      when 'table_session' then (select t.day_session_id from public.table_sessions t where t.id = (v_row ->> 'table_session_id')::uuid)
    end;
    if v_day is not null and not (v_day = any (v_days)) then v_days := v_days || v_day; end if;
  end loop;

  -- ledger rows and table sessions must belong to a business day: a NULL day would escape every freeze
  if tg_op = 'INSERT' and v_kind = 'self' and tg_table_name in ('stock_movements', 'table_sessions')
     and (v_new ->> 'day_session_id') is null then
    perform public.fn_err('no_open_day');
  end if;

  foreach v_day in array v_days loop
    select d.status into v_status from public.day_sessions d where d.id = v_day for share;
    if v_status = 'closed' then
      perform public.fn_err('day_closed');
    end if;
  end loop;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create or replace function public.fn_guard_profile_auth_method()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text;
  v_email text;
  v_synthetic boolean;
begin
  -- Narrowing / cosmetic edits (is_active = false, names, username) must never be blocked by the identity checks:
  -- on UPDATE they only run when the auth method, the role or the rotation flag changes.
  if tg_op = 'UPDATE'
     and new.auth_method is not distinct from old.auth_method
     and new.role_id is not distinct from old.role_id
     and new.identity_rotation_pending is not distinct from old.identity_rotation_pending then
    return new;
  end if;
  select ro.system_key into v_key from public.roles ro
  where ro.id = new.role_id and ro.restaurant_id = new.restaurant_id;
  if coalesce(v_key = 'tenant_admin', false) <> (new.auth_method = 'password') then
    perform public.fn_err('auth_method_mismatch', 'tenant_admin uses password, staff uses pin');
  end if;
  if exists (select 1 from public.platform_admins a where a.id = new.id) then
    perform public.fn_err('auth_method_mismatch', 'platform admins cannot hold a tenant profile');
  end if;
  select u.email into v_email from auth.users u where u.id = new.id;
  v_synthetic := v_email is not null and v_email ~* '^[a-z0-9._-]+@[a-z0-9-]+\.staff\.cafeos\.invalid$';
  if new.auth_method = 'password' then
    if new.identity_rotation_pending then
      perform public.fn_err('auth_method_mismatch', 'password profiles have no pending identity rotation');
    end if;
    if (tg_op = 'INSERT' or old.auth_method is distinct from new.auth_method)
       and (v_email is null or v_email ~* '\.invalid$') then
      perform public.fn_err('admin_requires_email_identity');
    end if;
  else
    -- 'pin': the identity must be the synthetic non-routable one, on INSERT and on every UPDATE,
    -- except while a rotation is pending (a demoted admin still holds its real email until rotated)
    if not v_synthetic and not (tg_op = 'UPDATE' and new.identity_rotation_pending) then
      perform public.fn_err('auth_method_mismatch', 'staff accounts use a synthetic non-routable email');
    end if;
    if tg_op = 'INSERT' and new.identity_rotation_pending then
      perform public.fn_err('auth_method_mismatch', 'a new staff profile cannot start with a pending rotation');
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.fn_guard_profile_update()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_caller uuid := (select public.current_user_id());
begin
  if v_caller is null or v_caller = old.id then
    return new;
  end if;
  if (new.is_active is distinct from old.is_active or new.role_id is distinct from old.role_id
      or new.first_name is distinct from old.first_name or new.middle_name is distinct from old.middle_name
      or new.last_name is distinct from old.last_name or new.username is distinct from old.username)
     and not public.fn_caller_covers_role(old.role_id) then
    perform public.fn_err('permission_escalation', 'target holds rights the caller does not');
  end if;
  return new;
end;
$$;

-- ── Realtime ────────────────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter table public.orders replica identity using index orders_tenant_id_key;
    if exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'orders') then
      alter publication supabase_realtime drop table public.orders;
    end if;
    alter publication supabase_realtime add table public.orders (
      id, restaurant_id, day_session_id, order_no, source, order_type, status, payment_status, table_id,
      table_label_snapshot, table_session_id, customer_session_id, created_by, created_by_name_snapshot,
      subtotal, vat_rate_snapshot, vat_amount, total, stock_consumed, client_key, customer_name,
      customer_phone, customer_note, ready_at, served_at, cancelled_at, cancelled_by, cancel_reason,
      created_at, updated_at);
  end if;
end $$;
