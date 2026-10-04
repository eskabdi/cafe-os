-- 0025  Per-tenant session timer settings (editable by the tenant admin)
--
--  User request (2026-10-04): the inactivity timings of the SPA (InactivityGuard: "Still there?" warning, then sign-out) and the
--  kiosk PIN-pad idle timer become per-tenant settings instead of code constants.
--
--  Storage: public.restaurant_session_settings, ONE row per tenant (PK = restaurant_id, FK RESTRICT). There is no other settings
--  table (tenant settings so far are columns on restaurants with a settings.manage UPDATE column grant); a separate 1:1 table keeps
--  these values out of the restaurants client UPDATE grant, so they can only change through the audited, step-up RPCs below.
--    idle_warning_seconds  default 15   seconds of inactivity before the warning dialog         CHECK 5 <= x < signout_seconds
--    signout_seconds       default 30   seconds of inactivity (TOTAL, from the last activity)   CHECK 15 <= x <= 900
--                                       before the session ends
--    pin_pad_idle_seconds  default 60   kiosk PIN pad idle -> back to the tiles                 CHECK 15 <= x <= 300
--  A row exists for every tenant: backfill below + AFTER INSERT trigger on restaurants (covers fn_provision_tenant and every other path).
--
--  Permission: settings.session_timers (module settings; tenant_admin through trg_grant_new_permission; grantable in the matrix).
--  RPCs (authenticated):
--    fn_get_session_timers()                                   -> {idle_warning_seconds, signout_seconds, pin_pad_idle_seconds}
--        any ACTIVE member of a non-suspended tenant (no permission: the timers must keep running while a PIN change is required/pending)
--    fn_update_session_timers(idle_warning, signout, pin_pad)  -> same shape (the stored values)
--        settings.session_timers + step-up; writable tenant; invalid_input with the field name as detail; audit settings.session_timers_updated
--    fn_reset_session_timers()                                 -> same shape (the defaults); same checks and audit (reset: true)
--  Session context: + session_timers {idle_warning_seconds, signout_seconds, pin_pad_idle_seconds} (0024 fields unchanged).
--  Kiosk (service-only): fn_kiosk_terminal_bootstrap(token_hash, slug) -> NULL | {staff: <fn_kiosk_roster>, pin_pad_idle_seconds}.
--  fn_kiosk_roster keeps its array contract, so an Edge Function deployed before this migration keeps working.

-- ── permission ──────────────────────────────────────────────────────────────
insert into public.permissions (key, module, description, sort_order)
values ('settings.session_timers', 'settings', 'Change the inactivity sign-out and kiosk PIN-pad timers', 114)
on conflict (key) do nothing;
-- (trigger trg_grant_new_permission gives it to every tenant_admin role)

-- ── table ───────────────────────────────────────────────────────────────────
create table public.restaurant_session_settings (
  restaurant_id         uuid primary key references public.restaurants(id) on delete restrict,
  idle_warning_seconds  integer not null default 15,
  signout_seconds       integer not null default 30,
  pin_pad_idle_seconds  integer not null default 60,
  updated_by            uuid,
  updated_at            timestamptz not null default now(),
  constraint restaurant_session_settings_signout_check check (signout_seconds between 15 and 900),
  constraint restaurant_session_settings_warning_check check (idle_warning_seconds >= 5 and idle_warning_seconds < signout_seconds),
  constraint restaurant_session_settings_pin_pad_check check (pin_pad_idle_seconds between 15 and 300),
  constraint restaurant_session_settings_updated_by_fk foreign key (restaurant_id, updated_by)
    references public.profiles (restaurant_id, id) on delete restrict
);
create index restaurant_session_settings_updated_by_idx on public.restaurant_session_settings (updated_by);

alter table public.restaurant_session_settings enable row level security;
alter table public.restaurant_session_settings force row level security;
create trigger trg_set_updated_at before update on public.restaurant_session_settings
  for each row execute function public.fn_set_updated_at();
create trigger trg_lock_restaurant_id before update on public.restaurant_session_settings
  for each row execute function public.fn_lock_restaurant_id();
create trigger trg_audit after insert or update or delete on public.restaurant_session_settings
  for each row execute function public.fn_audit_row('restaurant_id');

-- every active member of the tenant reads its own row (tenant from identity); no client write grant at all (RPCs only)
create policy restaurant_session_settings_select on public.restaurant_session_settings for select to authenticated
  using (restaurant_id = (select public.current_restaurant_id()));
revoke all on public.restaurant_session_settings from public, anon, authenticated, service_role; -- RPCs (security definer) are the only writers
grant select (restaurant_id, idle_warning_seconds, signout_seconds, pin_pad_idle_seconds, updated_by, updated_at)
  on public.restaurant_session_settings to authenticated;

-- ── one row per tenant: backfill + creation with the tenant ─────────────────
insert into public.restaurant_session_settings (restaurant_id)
select r.id from public.restaurants r
on conflict (restaurant_id) do nothing;

create or replace function public.fn_create_session_settings()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.restaurant_session_settings (restaurant_id) values (new.id)
  on conflict (restaurant_id) do nothing;
  return null;
end;
$$;
revoke all on function public.fn_create_session_settings() from public, anon, authenticated;
create trigger trg_create_session_settings after insert on public.restaurants
  for each row execute function public.fn_create_session_settings();

-- ── internal helpers (no client EXECUTE) ────────────────────────────────────
-- The JSON shape used everywhere (RPCs + session context). Falls back to the column defaults if a row were ever missing.
create or replace function public.fn_session_timers_json(p_restaurant_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select jsonb_build_object('idle_warning_seconds', s.idle_warning_seconds,
                               'signout_seconds', s.signout_seconds,
                               'pin_pad_idle_seconds', s.pin_pad_idle_seconds)
     from public.restaurant_session_settings s where s.restaurant_id = p_restaurant_id),
    jsonb_build_object('idle_warning_seconds', 15, 'signout_seconds', 30, 'pin_pad_idle_seconds', 60))
$$;
revoke all on function public.fn_session_timers_json(uuid) from public, anon, authenticated;

-- Shared body of update and reset: authorise, validate, lock, write, audit. p_reset = true ignores the values and stores the
-- column defaults. Not client-executable: the two public wrappers fix p_reset.
create or replace function public.fn_store_session_timers(p_idle_warning_seconds integer, p_signout_seconds integer,
                                                          p_pin_pad_idle_seconds integer, p_reset boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rid uuid := public.fn_tenant_status_guard(true);
  v_old jsonb;
  v_new jsonb;
begin
  if not public.has_permission('settings.session_timers') then perform public.fn_err('permission_denied'); end if;
  perform public.fn_require_step_up();

  if not coalesce(p_reset, false) then
    if p_idle_warning_seconds is null or p_idle_warning_seconds < 5 then
      perform public.fn_err('invalid_input', 'idle_warning_seconds');
    end if;
    if p_signout_seconds is null or p_signout_seconds not between 15 and 900 then
      perform public.fn_err('invalid_input', 'signout_seconds');
    end if;
    if p_pin_pad_idle_seconds is null or p_pin_pad_idle_seconds not between 15 and 300 then
      perform public.fn_err('invalid_input', 'pin_pad_idle_seconds');
    end if;
    -- the warning must come BEFORE the sign-out (signout is the total from the last activity)
    if p_idle_warning_seconds >= p_signout_seconds then
      perform public.fn_err('invalid_input', 'idle_warning_seconds');
    end if;
  end if;

  insert into public.restaurant_session_settings (restaurant_id) values (v_rid) on conflict (restaurant_id) do nothing;
  perform 1 from public.restaurant_session_settings s where s.restaurant_id = v_rid for update;
  v_old := public.fn_session_timers_json(v_rid);

  if coalesce(p_reset, false) then
    update public.restaurant_session_settings
       set idle_warning_seconds = default, signout_seconds = default, pin_pad_idle_seconds = default,
           updated_by = (select public.current_user_id())
     where restaurant_id = v_rid;
  else
    update public.restaurant_session_settings
       set idle_warning_seconds = p_idle_warning_seconds, signout_seconds = p_signout_seconds,
           pin_pad_idle_seconds = p_pin_pad_idle_seconds, updated_by = (select public.current_user_id())
     where restaurant_id = v_rid;
  end if;
  v_new := public.fn_session_timers_json(v_rid);

  -- a replay with identical values changes nothing and writes no second event
  if v_new is distinct from v_old then
    perform public.fn_write_audit('settings.session_timers_updated',
      jsonb_build_object('old', v_old, 'new', v_new, 'reset', coalesce(p_reset, false)), v_rid);
  end if;
  return v_new;
end;
$$;
revoke all on function public.fn_store_session_timers(integer, integer, integer, boolean) from public, anon, authenticated;

-- ── client RPCs ─────────────────────────────────────────────────────────────
create or replace function public.fn_update_session_timers(p_idle_warning_seconds integer, p_signout_seconds integer,
                                                           p_pin_pad_idle_seconds integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.fn_tenant_status_guard(true);   -- (repeated inside; keeps the authorisation visible in this body)
  return public.fn_store_session_timers(p_idle_warning_seconds, p_signout_seconds, p_pin_pad_idle_seconds, false);
end;
$$;

create or replace function public.fn_reset_session_timers()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.fn_tenant_status_guard(true);
  return public.fn_store_session_timers(null, null, null, true);
end;
$$;

create or replace function public.fn_get_session_timers()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  -- write=false: reading is allowed for a past_due (read-only) tenant; suspended/cancelled are refused by the guard.
  -- No permission check on purpose: every member's client needs the timers, including while a PIN change is required/pending.
  v_rid uuid := public.fn_tenant_status_guard(false);
begin
  return public.fn_session_timers_json(v_rid);
end;
$$;
revoke all on function public.fn_update_session_timers(integer, integer, integer), public.fn_reset_session_timers(),
                       public.fn_get_session_timers() from public, anon;
grant execute on function public.fn_update_session_timers(integer, integer, integer), public.fn_reset_session_timers(),
                          public.fn_get_session_timers() to authenticated;

-- ── session context: 0024 body unchanged + session_timers ───────────────────
create or replace function public.fn_get_session_context()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v jsonb;
  v_platform text;
begin
  if v_uid is null then perform public.fn_err('not_authenticated'); end if;
  select a.role into v_platform from public.platform_admins a where a.id = v_uid and a.is_active;

  select jsonb_build_object(
    'user', jsonb_build_object('id', p.id, 'first_name', p.first_name, 'middle_name', p.middle_name,
                               'last_name', p.last_name, 'short_name', p.short_name, 'username', p.username),
    'restaurant', jsonb_build_object('id', r.id, 'name', r.name, 'slug', r.slug, 'status', r.status,
                                     'vat_rate', r.vat_rate, 'branding', r.branding, 'timezone', r.timezone,
                                     'auto_consume_stock', r.auto_consume_stock),
    'role', jsonb_build_object('id', ro.id, 'name', ro.name, 'color', ro.color, 'icon', ro.icon,
                               'system_key', ro.system_key, 'is_active', ro.is_active),
    -- true only while the user must set a new PIN; 'pending_approval' is reported through pin_change_status
    'must_change_pin', (pc.status = 'required'),
    'pin_change_status', pc.status,
    'pin_length', public.fn_pin_length_for_role_name(ro.name),
    -- while restricted the user holds no permission and no station (same answer as has_permission)
    'permissions', case when not ro.is_active or pc.status <> 'none' then '[]'::jsonb
      when ro.system_key = 'tenant_admin' then (select coalesce(jsonb_agg(pm.key order by pm.key), '[]'::jsonb) from public.permissions pm)
      else (select coalesce(jsonb_agg(pm.key order by pm.key), '[]'::jsonb)
            from public.role_permissions rp join public.permissions pm on pm.id = rp.permission_id
            where rp.role_id = ro.id) end,
    'station_ids', case when not ro.is_active or pc.status <> 'none' then '[]'::jsonb
      when ro.system_key = 'tenant_admin' then (select coalesce(jsonb_agg(s.id), '[]'::jsonb) from public.stations s where s.restaurant_id = r.id)
      else (select coalesce(jsonb_agg(rsa.station_id), '[]'::jsonb) from public.role_station_access rsa where rsa.role_id = ro.id) end,
    'tenant_writable', (r.status in ('trialing', 'active')),
    'open_day', (select jsonb_build_object('id', d.id, 'day_no', d.day_no, 'opened_at', d.opened_at)
                 from public.day_sessions d where d.restaurant_id = r.id and d.status = 'open'),
    -- the tenant's inactivity timers (always present for a tenant user, also while a PIN change is required/pending)
    'session_timers', public.fn_session_timers_json(r.id)
  ) into v
  from public.profiles p
  join public.restaurants r on r.id = p.restaurant_id
  join public.roles ro on ro.id = p.role_id and ro.restaurant_id = p.restaurant_id
  cross join lateral (
    select case
      when ro.system_key is not distinct from 'tenant_admin' then 'none'
      when exists (select 1 from public.profile_secrets ps where ps.profile_id = p.id and ps.must_change_pin) then 'required'
      when exists (select 1 from public.profile_secrets ps where ps.profile_id = p.id and ps.pin_change_pending) then 'pending_approval'
      else 'none' end as status
  ) pc
  where p.id = v_uid and p.is_active and r.status not in ('suspended', 'cancelled');

  if v is null and v_platform is null then
    return null;
  end if;
  return coalesce(v, '{}'::jsonb)
    || case when v_platform is null then '{}'::jsonb
            else jsonb_build_object('platform_role', v_platform, 'platform_mfa', public.fn_platform_mfa_satisfied()) end;
end;
$$;

-- ── kiosk bootstrap (service-only; staff-roster Edge Function) ──────────────
-- NULL for every invalid kiosk (same rules as fn_kiosk_roster: unknown, revoked, slug mismatch, suspended, cancelled), otherwise
-- the roster plus THIS tenant's PIN-pad idle timer. Tenant comes from the token (fn_kiosk_context), never from a parameter.
create or replace function public.fn_kiosk_terminal_bootstrap(p_token_hash text, p_slug text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_staff jsonb;
  v_rid uuid;
begin
  if not public.is_service_role() then perform public.fn_err('permission_denied'); end if;
  v_staff := public.fn_kiosk_roster(p_token_hash, p_slug);   -- validates the kiosk and refreshes last_seen_at (throttled)
  if v_staff is null then return null; end if;
  v_rid := public.fn_kiosk_context(p_token_hash, p_slug, false);
  if v_rid is null then return null; end if;
  return jsonb_build_object('staff', v_staff,
                            'pin_pad_idle_seconds', (public.fn_session_timers_json(v_rid) -> 'pin_pad_idle_seconds'));
end;
$$;
revoke all on function public.fn_kiosk_terminal_bootstrap(text, text) from public, anon, authenticated;
grant execute on function public.fn_kiosk_terminal_bootstrap(text, text) to service_role;
