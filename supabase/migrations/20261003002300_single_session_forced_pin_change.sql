-- 0023  One concurrent session per PIN staff member, security notifications, server-enforced forced PIN change
--
--  User decisions (2026-10-03):
--   * PIN staff (profiles.auth_method = 'pin', non-admin) may hold ONE active session. If the PIN verifies but another
--     session is active, pin-login refuses (answer byte-identical to a wrong PIN: no oracle), notifies the user and every
--     active tenant_admin, forces a PIN change and audits it. Admins / password users are never affected.
--   * profile_secrets.must_change_pin = true => has_permission() / has_station_access() / current_station_ids() answer
--     "nothing" for that user (every RPC and RLS predicate that goes through them denies; tenant-membership-only reads such as roles/stations/categories config stay readable within the user's own tenant) until the user sets a new
--     PIN through the pin-change Edge Function (fn_set_user_pin clears the flag). tenant_admin is exempt by construction.
--
--  Service-only helpers (no client EXECUTE):
--    fn_active_session_window()                 -> interval, the freshness window (2 hours; MUST stay > jwt_expiry = 1 hour)
--    fn_staff_has_active_session(profile_id)    -> boolean. TRUE only for a PIN-eligible profile with a row in auth.sessions that
--                                                  is not past not_after AND whose last activity
--                                                  coalesce(refreshed_at, updated_at, created_at) is inside the window. Sign-out
--                                                  deletes the GoTrue row (frees immediately); a closed browser stops refreshing and
--                                                  goes stale after the window. Anything else (admin, password user, unknown) = FALSE
--    fn_staff_login_blocked(profile_id, kiosk_token_hash?) -> jsonb {notified}: sets must_change_pin, notifies (deduped to one
--                                                  per user per 5 minutes), audits. Never raises for unknown/ineligible ids.
--  Client RPC: fn_mark_notification_read(id)    -> own notifications only; unknown and foreign ids are both not_found.

-- ── profile_secrets.must_change_pin ─────────────────────────────────────────
alter table public.profile_secrets add column must_change_pin boolean not null default false;
-- (profile_secrets rows only exist for PIN-eligible non-admin profiles: trg_guard_profile_secret fires on INSERT and UPDATE,
--  so the flag can never be set on a tenant_admin / platform admin. has_permission additionally exempts tenant_admin.)

-- ── enforcement: helpers answer "nothing" while a PIN change is pending ─────
create or replace function public.has_permission(p_key text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    join public.restaurants r on r.id = p.restaurant_id
    join public.roles ro on ro.id = p.role_id and ro.restaurant_id = p.restaurant_id
    where p.id = (select auth.uid())
      and p.is_active
      and ro.is_active
      and r.status not in ('suspended', 'cancelled')
      -- forced PIN change pending: no permission at all (tenant_admin can never be in this state; exempt as belt and braces)
      and (ro.system_key = 'tenant_admin'
           or not exists (select 1 from public.profile_secrets ps where ps.profile_id = p.id and ps.must_change_pin))
      and (
        (ro.system_key = 'tenant_admin'
          and exists (select 1 from public.permissions pm where pm.key = p_key))
        or exists (
          select 1
          from public.role_permissions rp
          join public.permissions pm on pm.id = rp.permission_id
          where rp.role_id = ro.id
            and rp.restaurant_id = ro.restaurant_id
            and pm.key = p_key
        )
      )
  )
$$;

create or replace function public.has_station_access(p_station_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    join public.restaurants r on r.id = p.restaurant_id
    join public.roles ro on ro.id = p.role_id and ro.restaurant_id = p.restaurant_id
    join public.stations s on s.id = p_station_id and s.restaurant_id = p.restaurant_id
    where p.id = (select auth.uid())
      and p.is_active
      and ro.is_active
      and r.status not in ('suspended', 'cancelled')
      and (ro.system_key = 'tenant_admin'
           or not exists (select 1 from public.profile_secrets ps where ps.profile_id = p.id and ps.must_change_pin))
      and (
        ro.system_key = 'tenant_admin'
        or exists (
          select 1 from public.role_station_access rsa
          where rsa.role_id = ro.id
            and rsa.restaurant_id = ro.restaurant_id
            and rsa.station_id = p_station_id
        )
      )
  )
$$;

create or replace function public.current_station_ids()
returns uuid[]
language sql stable security definer set search_path = ''
as $$
  select coalesce((
    select case
      when ro.system_key = 'tenant_admin' then
        (select array_agg(s.id) from public.stations s where s.restaurant_id = p.restaurant_id)
      else
        (select array_agg(rsa.station_id) from public.role_station_access rsa
         where rsa.role_id = ro.id and rsa.restaurant_id = ro.restaurant_id)
      end
    from public.profiles p
    join public.restaurants r on r.id = p.restaurant_id
    join public.roles ro on ro.id = p.role_id and ro.restaurant_id = p.restaurant_id
    where p.id = (select auth.uid())
      and p.is_active
      and ro.is_active
      and r.status not in ('suspended', 'cancelled')
      and (ro.system_key = 'tenant_admin'
           or not exists (select 1 from public.profile_secrets ps where ps.profile_id = p.id and ps.must_change_pin))
  ), '{}'::uuid[])
$$;

-- ── session context: adds must_change_pin (the SPA routes to the PIN change screen) ──
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
    'must_change_pin', pc.pending,
    -- while a PIN change is pending the user holds no permission and no station (same answer as has_permission)
    'permissions', case when not ro.is_active or pc.pending then '[]'::jsonb
      when ro.system_key = 'tenant_admin' then (select coalesce(jsonb_agg(pm.key order by pm.key), '[]'::jsonb) from public.permissions pm)
      else (select coalesce(jsonb_agg(pm.key order by pm.key), '[]'::jsonb)
            from public.role_permissions rp join public.permissions pm on pm.id = rp.permission_id
            where rp.role_id = ro.id) end,
    'station_ids', case when not ro.is_active or pc.pending then '[]'::jsonb
      when ro.system_key = 'tenant_admin' then (select coalesce(jsonb_agg(s.id), '[]'::jsonb) from public.stations s where s.restaurant_id = r.id)
      else (select coalesce(jsonb_agg(rsa.station_id), '[]'::jsonb) from public.role_station_access rsa where rsa.role_id = ro.id) end,
    'tenant_writable', (r.status in ('trialing', 'active')),
    'open_day', (select jsonb_build_object('id', d.id, 'day_no', d.day_no, 'opened_at', d.opened_at)
                 from public.day_sessions d where d.restaurant_id = r.id and d.status = 'open')
  ) into v
  from public.profiles p
  join public.restaurants r on r.id = p.restaurant_id
  join public.roles ro on ro.id = p.role_id and ro.restaurant_id = p.restaurant_id
  cross join lateral (
    select (ro.system_key is distinct from 'tenant_admin'
            and exists (select 1 from public.profile_secrets ps where ps.profile_id = p.id and ps.must_change_pin)) as pending
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

-- ── fn_set_user_pin: a successful PIN change clears the forced-change flag ──
-- (fn_reset_pin_lockout deliberately does NOT touch must_change_pin: an admin unlock is not a PIN change)
create or replace function public.fn_set_user_pin(p_profile_id uuid, p_pin_digest text, p_pin_length integer default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rid uuid;
  v_role uuid;
  v_len integer;
begin
  if not public.is_service_role() then perform public.fn_err('permission_denied'); end if;
  if p_pin_digest is null or p_pin_digest !~ '^[0-9a-f]{64}$' then perform public.fn_err('invalid_pin'); end if;
  select p.restaurant_id, p.role_id into v_rid, v_role from public.profiles p where p.id = p_profile_id;
  if not found then perform public.fn_err('not_found'); end if;
  if not public.fn_pin_eligible(p_profile_id) then perform public.fn_err('pin_not_allowed'); end if;

  v_len := public.fn_pin_length_for_role(v_role);
  if p_pin_length is not null and p_pin_length is distinct from v_len then
    perform public.fn_err('pin_length_mismatch');
  end if;

  insert into public.profile_secrets (profile_id, restaurant_id, pin_hash, pin_length, must_change_pin)
  values (p_profile_id, v_rid, extensions.crypt(p_pin_digest, extensions.gen_salt('bf', 10)), v_len, false)
  on conflict (profile_id) do update
    set pin_hash = excluded.pin_hash, pin_length = excluded.pin_length,
        failed_attempts = 0, locked_until = null, pin_changed_at = now(), must_change_pin = false;

  perform public.fn_write_audit('auth.pin_set', jsonb_build_object('profile_id', p_profile_id), v_rid);
end;
$$;
revoke all on function public.fn_set_user_pin(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.fn_set_user_pin(uuid, text, integer) to service_role;

-- ── user_notifications ──────────────────────────────────────────────────────
create table public.user_notifications (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references public.restaurants(id) on delete restrict,
  recipient_id   uuid not null,
  kind           text not null check (kind ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$' and char_length(kind) <= 64),
  payload        jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object' and pg_column_size(payload) < 2048),
  created_at     timestamptz not null default now(),
  read_at        timestamptz,
  constraint user_notifications_tenant_id_key unique (restaurant_id, id),
  constraint user_notifications_recipient_fk foreign key (restaurant_id, recipient_id)
    references public.profiles (restaurant_id, id) on delete restrict
);
create index user_notifications_recipient_idx on public.user_notifications (restaurant_id, recipient_id, created_at desc);

alter table public.user_notifications enable row level security;
alter table public.user_notifications force row level security;
create trigger trg_lock_restaurant_id before update on public.user_notifications for each row execute function public.fn_lock_restaurant_id();

-- only read_at may change, and only from NULL to a time: the history of what was sent is not rewritable (even by the owner role)
create or replace function public.fn_notification_read_only_column()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if (new.id, new.restaurant_id, new.recipient_id, new.kind, new.payload, new.created_at)
     is distinct from (old.id, old.restaurant_id, old.recipient_id, old.kind, old.payload, old.created_at)
     or (old.read_at is not null and new.read_at is distinct from old.read_at) then
    raise exception 'immutable_column' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger trg_notification_immutable before update on public.user_notifications
  for each row execute function public.fn_notification_read_only_column();

-- the recipient reads their OWN rows (not even a tenant_admin reads other people's notifications); no client write grants at all
create policy user_notifications_select on public.user_notifications for select to authenticated
  using (restaurant_id = (select public.current_restaurant_id()) and recipient_id = (select auth.uid()));
revoke all on public.user_notifications from public, anon, authenticated;
grant select (id, restaurant_id, recipient_id, kind, payload, created_at, read_at) on public.user_notifications to authenticated;

-- Realtime (RLS applies to postgres_changes): explicit column list like orders; REPLICA IDENTITY USING INDEX (restaurant_id, id)
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter table public.user_notifications replica identity using index user_notifications_tenant_id_key;
    alter publication supabase_realtime add table public.user_notifications (id, restaurant_id, recipient_id, kind, payload, created_at, read_at);
  end if;
end $$;

create or replace function public.fn_mark_notification_read(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- write=false: acknowledging a message only reduces noise, so a read-only (past_due) tenant may still do it,
  -- and it must keep working while a PIN change is pending (the user has no permissions then, by design)
  v_rid uuid := public.fn_tenant_status_guard(false);
  v_uid uuid := (select auth.uid());
  v_read timestamptz;
begin
  if p_id is null then perform public.fn_err('invalid_input'); end if;
  update public.user_notifications n
     set read_at = coalesce(n.read_at, now())
   where n.id = p_id and n.restaurant_id = v_rid and n.recipient_id = v_uid
   returning n.read_at into v_read;
  if not found then perform public.fn_err('not_found'); end if;   -- unknown, foreign tenant and other user's ids look the same
  return jsonb_build_object('id', p_id, 'read_at', v_read);
end;
$$;
revoke all on function public.fn_mark_notification_read(uuid) from public, anon;
grant execute on function public.fn_mark_notification_read(uuid) to authenticated;

-- ── single concurrent session ───────────────────────────────────────────────
create or replace function public.fn_active_session_window()
returns interval
language sql immutable set search_path = ''
as $$ select interval '2 hours' $$;   -- must stay > config.toml [auth] jwt_expiry (1 hour) so a live, refreshing browser is always inside it

create or replace function public.fn_staff_has_active_session(p_profile_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_service_role() then perform public.fn_err('permission_denied'); end if;
  if p_profile_id is null or not public.fn_pin_eligible(p_profile_id) then return false; end if;   -- admins / password users: never blocked
  return exists (
    select 1 from auth.sessions s
    where s.user_id = p_profile_id
      and (s.not_after is null or s.not_after > now())
      -- GoTrue: refreshed_at is timestamp WITHOUT time zone in UTC; updated_at / created_at are timestamptz
      and coalesce(s.refreshed_at at time zone 'UTC', s.updated_at, s.created_at) > now() - public.fn_active_session_window()
  );
end;
$$;

create or replace function public.fn_staff_login_blocked(p_profile_id uuid, p_kiosk_token_hash text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rid uuid;
  v_name text;
  v_kiosk text;
  v_payload jsonb;
  v_notify boolean;
begin
  if not public.is_service_role() then perform public.fn_err('permission_denied'); end if;
  if p_profile_id is null or not public.fn_pin_eligible(p_profile_id) then return jsonb_build_object('notified', false); end if;
  select p.restaurant_id, p.short_name into v_rid, v_name
  from public.profiles p join public.restaurants r on r.id = p.restaurant_id
  where p.id = p_profile_id and p.is_active and r.status not in ('suspended', 'cancelled');
  if not found then return jsonb_build_object('notified', false); end if;

  -- serialise per user so concurrent blocked attempts cannot both pass the dedupe test
  perform pg_advisory_xact_lock(hashtextextended('login_blocked:' || p_profile_id::text, 0));

  if p_kiosk_token_hash is not null then
    select k.name into v_kiosk from public.kiosk_devices k
    where k.token_hash = p_kiosk_token_hash and k.restaurant_id = v_rid and k.revoked_at is null;
  end if;

  -- (b) force a PIN change: a correct PIN was used while another session lives, so treat the PIN as exposed
  update public.profile_secrets set must_change_pin = true where profile_id = p_profile_id and not must_change_pin;

  -- (a) at most one notification set per user per 5 minutes (the user's own row is the dedupe key)
  v_notify := not exists (
    select 1 from public.user_notifications n
    where n.restaurant_id = v_rid and n.recipient_id = p_profile_id and n.kind = 'security.concurrent_login_blocked'
      and n.created_at > now() - interval '5 minutes');
  if v_notify then
    v_payload := jsonb_build_object('profile_id', p_profile_id, 'user_name', v_name, 'at', now())
                 || case when v_kiosk is null then '{}'::jsonb else jsonb_build_object('kiosk_name', v_kiosk) end;
    insert into public.user_notifications (restaurant_id, recipient_id, kind, payload)
    select v_rid, x.id, 'security.concurrent_login_blocked', v_payload
    from (
      select p_profile_id as id
      union
      select a.id from public.profiles a
      join public.roles ro on ro.id = a.role_id and ro.restaurant_id = a.restaurant_id
      where a.restaurant_id = v_rid and a.is_active and ro.is_active and ro.system_key = 'tenant_admin'
    ) x;
  end if;

  -- (c) audit (no PIN, digest, token or session data)
  perform public.fn_write_audit('auth.concurrent_login_blocked',
    jsonb_build_object('profile_id', p_profile_id, 'kiosk_name', v_kiosk, 'notified', v_notify), v_rid);
  return jsonb_build_object('notified', v_notify);
end;
$$;

revoke all on function public.fn_active_session_window(), public.fn_staff_has_active_session(uuid),
                       public.fn_staff_login_blocked(uuid, text), public.fn_notification_read_only_column()
  from public, anon, authenticated;
grant execute on function public.fn_staff_has_active_session(uuid), public.fn_staff_login_blocked(uuid, text) to service_role;
