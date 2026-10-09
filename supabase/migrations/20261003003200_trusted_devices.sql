-- 0032  Trusted devices (owner decision 2026-10-09) and no MFA opt-out (owner decision 7)
--
--  Owner decisions:
--   * "TOTP on each sign-in is not acceptable": the code is asked on the FIRST sign-in from a new device / browser, then not again
--     on that device for 30 days. Trust is recorded server-side (trusted_devices), revocable, audited.
--   * Very sensitive actions (cancel / restore tenant, plan change, role permission matrix, role station access) still ask the code:
--     a REAL TOTP verification at most 12 h old (JWT amr), else P0001 step_up_required.
--   * Demo without real MFA is not acceptable: the app.platform_mfa_required = 'off' relaxation is gone. Platform reads and
--     commands need an MFA-satisfied session, always.
--
--  Mechanism. Supabase AAL is per session: a password sign-in on a trusted device yields an aal1 session. The SPA then calls
--  fn_check_trusted_device(token) with the device token it stored at trust time; on success the database records an ATTESTATION
--  for that session (session_device_attestations, keyed by the JWT session_id claim). The MFA predicate fn_mfa_session_ok() is
--     (aal = aal2 AND the account owns a verified factor)  OR  (an attestation for THIS session_id, of THIS user, whose device is
--      unrevoked, unexpired, in the caller's current portal scope, and whose enrolment factor is still verified).
--  It replaces the aal2 test in fn_platform_mfa_satisfied (RLS helpers), fn_platform_guard, fn_require_aal2 and
--  fn_require_step_up. Removing the factor a device was trusted with invalidates the device at once (no trigger on auth tables).
--
--  The device token: 32 random bytes (hex), returned ONCE by fn_trust_device; only its sha256 is stored. It is a bearer secret
--  bound to one user (a stolen token alone is useless without that user's password session). Max 10 live devices per user
--  (the oldest is revoked, reason 'limit'). Revoked with the user: profile deactivated, PIN changed / reset, platform admin
--  deactivated, factor removed (implicit, above).
--
--  Who may revoke: the owner (any of its devices); a tenant_admin (aal2-equivalent) for the users of its own tenant; an active
--  Super Admin (fn_platform_guard) for platform admins. Foreign / unknown ids answer not_found.

-- ════════════════════════════════════════ tables ════════════════════════════════════════
create table public.trusted_devices (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete restrict,
  scope          text not null check (scope in ('platform', 'tenant')),     -- tenant: the user's own profile tenant (immutable)
  factor_id      uuid not null,                                                    -- auth.mfa_factors.id it was trusted with
  token_hash     text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  label          text not null default '' check (char_length(label) <= 120),
  created_at     timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  expires_at     timestamptz not null,
  revoked_at     timestamptz,
  revoked_by     uuid,
  revoke_reason  text check (revoke_reason in ('user', 'admin', 'limit', 'user_disabled', 'pin_reset', 'admin_disabled')),
  constraint trusted_devices_ttl_check check (expires_at > created_at and expires_at <= created_at + interval '30 days'),
  constraint trusted_devices_revoked_check check ((revoked_at is null) = (revoke_reason is null))
);
create index trusted_devices_user_live_idx on public.trusted_devices (user_id, created_at) where revoked_at is null;

create table public.session_device_attestations (
  session_id  uuid primary key,
  user_id     uuid not null,
  device_id   uuid not null references public.trusted_devices (id) on delete restrict,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);
create index session_device_attestations_device_idx on public.session_device_attestations (device_id);

alter table public.trusted_devices enable row level security;
alter table public.trusted_devices force row level security;
alter table public.session_device_attestations enable row level security;
alter table public.session_device_attestations force row level security;
-- owner-only read under RLS (defence in depth); clients get no table privilege at all: the RPCs below are the only path
create policy trusted_devices_select_own on public.trusted_devices for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.trusted_devices from public, anon, authenticated;
revoke all on public.session_device_attestations from public, anon, authenticated;

-- ════════════════════════════════════════ predicates ════════════════════════════════════════
create or replace function public.fn_jwt_session_id()
returns uuid
language plpgsql stable set search_path = ''
as $$
declare
  v text := (select auth.jwt()) ->> 'session_id';
begin
  if v ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return v::uuid; end if;
  return null;
end;
$$;
revoke all on function public.fn_jwt_session_id() from public, anon, authenticated;

-- the portal scope a device must match: platform for an active platform admin, the caller's own tenant for a password profile
create or replace function public.fn_device_scope_ok(p_scope text, p_user_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select case p_scope
    when 'platform' then exists (select 1 from public.platform_admins a where a.id = p_user_id and a.is_active)
    when 'tenant' then exists (select 1 from public.profiles p
                               where p.id = p_user_id and p.is_active and p.auth_method <> 'pin')
    else false end
$$;
revoke all on function public.fn_device_scope_ok(text, uuid) from public, anon, authenticated;

create or replace function public.fn_device_live(p_device public.trusted_devices)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select p_device.revoked_at is null and p_device.expires_at > now()
     and exists (select 1 from auth.mfa_factors f where f.id = p_device.factor_id and f.user_id = p_device.user_id and f.status = 'verified')
     and public.fn_device_scope_ok(p_device.scope, p_device.user_id)
$$;
revoke all on function public.fn_device_live(public.trusted_devices) from public, anon, authenticated;

create or replace function public.fn_device_trust_satisfied()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.session_device_attestations s join public.trusted_devices d on d.id = s.device_id
    where s.session_id = public.fn_jwt_session_id() and s.user_id = (select auth.uid()) and d.user_id = s.user_id
      and s.expires_at > now() and public.fn_device_live(d))
$$;
revoke all on function public.fn_device_trust_satisfied() from public, anon, authenticated;

-- THE MFA predicate of every portal gate: a live authenticator behind this session, by TOTP (aal2) or by a trusted device
create or replace function public.fn_mfa_session_ok()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select (coalesce((select auth.jwt()) ->> 'aal', '') = 'aal2'
          and exists (select 1 from auth.mfa_factors f where f.user_id = (select auth.uid()) and f.status = 'verified'))
      or public.fn_device_trust_satisfied()
$$;
revoke all on function public.fn_mfa_session_ok() from public, anon, authenticated;

-- very sensitive actions: a REAL TOTP verification at most p_max old (JWT amr entry {method: totp, timestamp}), whatever the device
create or replace function public.fn_require_recent_totp(p_max interval default interval '12 hours')
returns void
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_jwt jsonb := coalesce((select auth.jwt()), '{}'::jsonb);
begin
  if coalesce(v_jwt ->> 'aal', '') <> 'aal2'
     or not exists (select 1 from auth.mfa_factors f where f.user_id = (select auth.uid()) and f.status = 'verified')
     or not exists (select 1 from jsonb_array_elements(case when jsonb_typeof(v_jwt -> 'amr') = 'array' then v_jwt -> 'amr' else '[]'::jsonb end) e
                    where jsonb_typeof(e) = 'object' and e ->> 'method' = 'totp' and (e ->> 'timestamp') ~ '^[0-9]{1,12}$'
                      and to_timestamp((e ->> 'timestamp')::bigint) > now() - p_max
                      and to_timestamp((e ->> 'timestamp')::bigint) <= now() + interval '5 minutes') then
    perform public.fn_err('step_up_required');
  end if;
end;
$$;
revoke all on function public.fn_require_recent_totp(interval) from public, anon, authenticated;

-- ════════════════════════════════════════ the gates, re-pointed (no GUC opt-out) ════════════════════════════════════════
create or replace function public.fn_platform_mfa_satisfied()
returns boolean
language sql stable security definer set search_path = ''
as $$ select public.fn_mfa_session_ok() $$;
revoke all on function public.fn_platform_mfa_satisfied() from public, anon, authenticated;

create or replace function public.fn_platform_guard()
returns uuid
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then perform public.fn_err('not_authenticated'); end if;
  if not exists (select 1 from public.platform_admins a
                 where a.id = v_uid and a.is_active and a.role = 'platform_super_admin') then
    perform public.fn_err('permission_denied');
  end if;
  if not public.fn_mfa_session_ok() then perform public.fn_err('mfa_required'); end if;
  return v_uid;
end;
$$;
revoke all on function public.fn_platform_guard() from public, anon, authenticated;

create or replace function public.fn_require_aal2()
returns void
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.auth_method <> 'pin')
     or not public.fn_mfa_session_ok() then
    perform public.fn_err('mfa_required');
  end if;
end;
$$;
revoke all on function public.fn_require_aal2() from public, anon, authenticated;

create or replace function public.fn_require_step_up()
returns void
language plpgsql stable security definer set search_path = ''
as $$
begin
  if public.fn_mfa_session_ok() then return; end if;
  if exists (select 1 from auth.mfa_factors f where f.user_id = (select auth.uid()) and f.status = 'verified')
     or current_setting('app.tenant_admin_mfa_required', true) = 'on' then
    perform public.fn_err('mfa_required');
  end if;
end;
$$;
revoke all on function public.fn_require_step_up() from public, anon, authenticated;

-- ════════════════════════════════════════ internals ════════════════════════════════════════
create or replace function public.fn_device_audit(p_event text, p_scope text, p_user_id uuid, p_detail jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if p_scope = 'platform' then
    perform public.fn_write_admin_audit(p_event, null, p_detail);
  else
    perform public.fn_write_audit(p_event, p_detail, (select p.restaurant_id from public.profiles p where p.id = p_user_id));
  end if;
end;
$$;
revoke all on function public.fn_device_audit(text, text, uuid, jsonb) from public, anon, authenticated;

create or replace function public.fn_revoke_devices_of(p_user_id uuid, p_reason text)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_n integer;
begin
  with r as (
    update public.trusted_devices set revoked_at = now(), revoked_by = (select auth.uid()), revoke_reason = p_reason
     where user_id = p_user_id and revoked_at is null
    returning id
  ) select count(*) into v_n from r;
  delete from public.session_device_attestations where user_id = p_user_id;
  return v_n;
end;
$$;
revoke all on function public.fn_revoke_devices_of(uuid, text) from public, anon, authenticated;

-- may the caller administer the devices of p_user_id? returns the target's scope, else not_found (foreign == unknown)
create or replace function public.fn_device_admin_scope(p_user_id uuid)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_rid uuid;
begin
  if v_uid is null then perform public.fn_err('not_authenticated'); end if;
  if p_user_id = v_uid then
    return case when exists (select 1 from public.platform_admins a where a.id = v_uid) then 'platform' else 'tenant' end;
  end if;
  if exists (select 1 from public.platform_admins a where a.id = v_uid) then
    perform public.fn_platform_guard();
    if exists (select 1 from public.platform_admins a where a.id = p_user_id) then return 'platform'; end if;
    perform public.fn_err('not_found');
  end if;
  v_rid := public.fn_tenant_status_guard(false);
  if not public.is_tenant_admin() then perform public.fn_err('permission_denied'); end if;
  perform public.fn_require_aal2();
  if exists (select 1 from public.profiles p where p.id = p_user_id and p.restaurant_id = v_rid) then return 'tenant'; end if;
  perform public.fn_err('not_found');
end;
$$;
revoke all on function public.fn_device_admin_scope(uuid) from public, anon, authenticated;

create or replace function public.fn_device_json(p_device public.trusted_devices)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('id', p_device.id, 'scope', p_device.scope, 'label', p_device.label,
                            'created_at', p_device.created_at, 'last_seen_at', p_device.last_seen_at,
                            'expires_at', p_device.expires_at,
                            'current', exists (select 1 from public.session_device_attestations s
                                               where s.device_id = p_device.id and s.session_id = public.fn_jwt_session_id()))
$$;
revoke all on function public.fn_device_json(public.trusted_devices) from public, anon, authenticated;

-- ════════════════════════════════════════ client RPCs ════════════════════════════════════════
-- Trust THIS device for 30 days. Needs a TOTP verification of the last 10 minutes (the code was just entered). Returns the raw
-- token ONCE: {device_id, token, expires_at}. The current session is attested too.
create or replace function public.fn_trust_device(p_label text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_scope text;
  v_factor uuid;
  v_token text;
  v_label text;
  v_id uuid;
  v_exp timestamptz := now() + interval '30 days';
  v_sid uuid := public.fn_jwt_session_id();
begin
  if v_uid is null then perform public.fn_err('not_authenticated'); end if;
  if exists (select 1 from public.platform_admins a where a.id = v_uid and a.is_active) then
    v_scope := 'platform';
  else
    perform public.fn_tenant_status_guard(false);
    if not exists (select 1 from public.profiles p where p.id = v_uid and p.is_active and p.auth_method <> 'pin') then
      perform public.fn_err('permission_denied');
    end if;
    v_scope := 'tenant';
  end if;
  perform public.fn_require_recent_totp(interval '10 minutes');
  select f.id into v_factor from auth.mfa_factors f where f.user_id = v_uid and f.status = 'verified' order by f.created_at desc, f.id limit 1;
  if v_factor is null then perform public.fn_err('mfa_required'); end if;
  v_label := left(btrim(regexp_replace(coalesce(p_label, ''), '[[:cntrl:]]', '', 'g')), 120);

  -- at most 10 live devices: the oldest beyond 9 is revoked before the new one is added
  update public.trusted_devices set revoked_at = now(), revoked_by = v_uid, revoke_reason = 'limit'
   where id in (select d.id from public.trusted_devices d where d.user_id = v_uid and d.revoked_at is null
                order by d.created_at desc, d.id offset 9);

  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.trusted_devices (user_id, scope, factor_id, token_hash, label, expires_at)
  values (v_uid, v_scope, v_factor, encode(extensions.digest(convert_to(v_token, 'UTF8'), 'sha256'), 'hex'), v_label, v_exp)
  returning id into v_id;
  if v_sid is not null then
    insert into public.session_device_attestations (session_id, user_id, device_id, expires_at)
    values (v_sid, v_uid, v_id, v_exp)
    on conflict (session_id) do update set device_id = excluded.device_id, expires_at = excluded.expires_at
      where public.session_device_attestations.user_id = excluded.user_id;
  end if;
  perform public.fn_device_audit('device.trusted', v_scope, v_uid, jsonb_build_object('device_id', v_id, 'user_id', v_uid));
  return jsonb_build_object('device_id', v_id, 'token', v_token, 'expires_at', v_exp);
end;
$$;

-- After a password sign-in: is this device trusted? On success THIS session (JWT session_id) is attested, so the portal gates
-- accept it without a TOTP step. Always answers the same shape; {trusted: false} for anything invalid (no detail).
create or replace function public.fn_check_trusted_device(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_sid uuid := public.fn_jwt_session_id();
  d public.trusted_devices%rowtype;
begin
  if v_uid is null then perform public.fn_err('not_authenticated'); end if;
  if v_sid is null or p_token is null or p_token !~ '^[0-9a-f]{64}$' then return jsonb_build_object('trusted', false); end if;
  select * into d from public.trusted_devices t
   where t.token_hash = encode(extensions.digest(convert_to(p_token, 'UTF8'), 'sha256'), 'hex') and t.user_id = v_uid
   for update;
  if not found or not public.fn_device_live(d) then return jsonb_build_object('trusted', false); end if;
  insert into public.session_device_attestations (session_id, user_id, device_id, expires_at)
  values (v_sid, v_uid, d.id, d.expires_at)
  on conflict (session_id) do update set device_id = excluded.device_id, expires_at = excluded.expires_at
    where public.session_device_attestations.user_id = excluded.user_id;
  update public.trusted_devices set last_seen_at = now() where id = d.id;
  perform public.fn_device_audit('device.session_trusted', d.scope, d.user_id, jsonb_build_object('device_id', d.id, 'user_id', v_uid));
  return jsonb_build_object('trusted', true, 'expires_at', d.expires_at);
end;
$$;

create or replace function public.fn_list_my_trusted_devices()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then perform public.fn_err('not_authenticated'); end if;
  return coalesce((select jsonb_agg(public.fn_device_json(d) order by d.created_at desc, d.id)
                   from public.trusted_devices d where d.user_id = v_uid and d.revoked_at is null and d.expires_at > now()), '[]'::jsonb);
end;
$$;

-- a tenant_admin (own tenant's users) or a Super Admin (platform admins) lists another account's devices
create or replace function public.fn_list_user_trusted_devices(p_user_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  perform public.fn_device_admin_scope(p_user_id);
  return coalesce((select jsonb_agg(public.fn_device_json(d) - 'current' order by d.created_at desc, d.id)
                   from public.trusted_devices d where d.user_id = p_user_id and d.revoked_at is null and d.expires_at > now()), '[]'::jsonb);
end;
$$;

create or replace function public.fn_revoke_trusted_device(p_device_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  d public.trusted_devices%rowtype;
begin
  if v_uid is null then perform public.fn_err('not_authenticated'); end if;
  select * into d from public.trusted_devices t where t.id = p_device_id for update;
  if not found then perform public.fn_err('not_found'); end if;
  if d.user_id <> v_uid then perform public.fn_device_admin_scope(d.user_id); end if;
  if d.revoked_at is not null then return jsonb_build_object('device_id', d.id, 'changed', false); end if;
  update public.trusted_devices set revoked_at = now(), revoked_by = v_uid,
         revoke_reason = case when d.user_id = v_uid then 'user' else 'admin' end
   where id = d.id;
  delete from public.session_device_attestations where device_id = d.id;
  perform public.fn_device_audit('device.revoked', d.scope, d.user_id, jsonb_build_object('device_id', d.id, 'user_id', d.user_id));
  return jsonb_build_object('device_id', d.id, 'changed', true);
end;
$$;

-- p_user_id null = the caller's own devices ("sign out of every trusted device")
create or replace function public.fn_revoke_all_trusted_devices(p_user_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_target uuid := coalesce(p_user_id, v_uid);
  v_scope text;
  v_n integer;
begin
  if v_uid is null then perform public.fn_err('not_authenticated'); end if;
  v_scope := public.fn_device_admin_scope(v_target);
  v_n := public.fn_revoke_devices_of(v_target, case when v_target = v_uid then 'user' else 'admin' end);
  if v_n > 0 then
    perform public.fn_device_audit('device.revoked_all', v_scope, v_target, jsonb_build_object('user_id', v_target, 'count', v_n));
  end if;
  return jsonb_build_object('user_id', v_target, 'revoked', v_n);
end;
$$;

revoke all on function public.fn_trust_device(text), public.fn_check_trusted_device(text), public.fn_list_my_trusted_devices(),
  public.fn_list_user_trusted_devices(uuid), public.fn_revoke_trusted_device(uuid), public.fn_revoke_all_trusted_devices(uuid)
  from public, anon;
grant execute on function public.fn_trust_device(text), public.fn_check_trusted_device(text), public.fn_list_my_trusted_devices(),
  public.fn_list_user_trusted_devices(uuid), public.fn_revoke_trusted_device(uuid), public.fn_revoke_all_trusted_devices(uuid)
  to authenticated;

-- ════════════════════════════════════════ revoke with the account ════════════════════════════════════════
create or replace function public.fn_trg_revoke_devices_profile()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if old.is_active and not new.is_active then perform public.fn_revoke_devices_of(new.id, 'user_disabled'); end if;
  return new;
end;
$$;
revoke all on function public.fn_trg_revoke_devices_profile() from public, anon, authenticated;
create trigger trg_revoke_devices_on_disable after update of is_active on public.profiles
  for each row execute function public.fn_trg_revoke_devices_profile();

create or replace function public.fn_trg_revoke_devices_pin()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.pin_hash is distinct from old.pin_hash or (new.must_change_pin and not old.must_change_pin) then
    perform public.fn_revoke_devices_of(new.profile_id, 'pin_reset');
  end if;
  return new;
end;
$$;
revoke all on function public.fn_trg_revoke_devices_pin() from public, anon, authenticated;
create trigger trg_revoke_devices_on_pin_reset after update of pin_hash, must_change_pin on public.profile_secrets
  for each row execute function public.fn_trg_revoke_devices_pin();

create or replace function public.fn_trg_revoke_devices_platform_admin()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if old.is_active and not new.is_active then perform public.fn_revoke_devices_of(new.id, 'admin_disabled'); end if;
  return new;
end;
$$;
revoke all on function public.fn_trg_revoke_devices_platform_admin() from public, anon, authenticated;
create trigger trg_revoke_devices_on_admin_disable after update of is_active on public.platform_admins
  for each row execute function public.fn_trg_revoke_devices_platform_admin();

-- ════════════════════════════════════════ the role matrix asks the code (very sensitive) ════════════════════════════════════════
create or replace function public.fn_update_role_permissions(
  p_role_id uuid,
  p_permission_keys text[],
  p_station_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rid uuid;
  v_role public.roles%rowtype;
  v_keys text[];
  v_stations uuid[];
  v_bad text[];
  v_bad_ids uuid[];
  v_is_admin boolean;
  v_added text[]; v_removed text[]; v_st_added uuid[]; v_st_removed uuid[];
begin
  v_rid := public.fn_tenant_status_guard(true);
  if not public.has_permission('roles.manage') then
    perform public.fn_err('permission_denied');
  end if;
  perform public.fn_require_step_up();
  perform public.fn_require_recent_totp();   -- 0032: the role matrix is a very sensitive action
  if p_role_id is null or p_permission_keys is null or p_station_ids is null then
    perform public.fn_err('invalid_input');
  end if;

  select * into v_role from public.roles r where r.id = p_role_id and r.restaurant_id = v_rid;
  if not found then perform public.fn_err('not_found'); end if;
  if v_role.system_key is not null then perform public.fn_err('system_role_protected'); end if;
  if p_role_id = public.current_role_id() then
    perform public.fn_err('permission_denied', 'cannot edit your own role');
  end if;

  select coalesce(array_agg(distinct k), '{}') into v_keys from unnest(p_permission_keys) k;
  select coalesce(array_agg(distinct s), '{}') into v_stations from unnest(p_station_ids) s;

  select array_agg(k) into v_bad from unnest(v_keys) k
  where not exists (select 1 from public.permissions pm where pm.key = k);
  if v_bad is not null then
    perform public.fn_err('invalid_permission', left(array_to_string(v_bad, ','), 200));
  end if;

  select array_agg(s) into v_bad_ids from unnest(v_stations) s
  where not exists (select 1 from public.stations st where st.id = s and st.restaurant_id = v_rid);
  if v_bad_ids is not null then perform public.fn_err('invalid_station'); end if;

  v_is_admin := public.is_tenant_admin();
  if not v_is_admin then
    -- no escalation: you can only newly grant what you hold yourself
    select array_agg(k) into v_bad from unnest(v_keys) k
    where not public.has_permission(k)
      and not exists (select 1 from public.role_permissions rp join public.permissions pm on pm.id = rp.permission_id
                      where rp.role_id = p_role_id and pm.key = k);
    if v_bad is not null then perform public.fn_err('permission_escalation', left(array_to_string(v_bad, ','), 200)); end if;
    select array_agg(s) into v_bad_ids from unnest(v_stations) s
    where not public.has_station_access(s)
      and not exists (select 1 from public.role_station_access rsa where rsa.role_id = p_role_id and rsa.station_id = s);
    if v_bad_ids is not null then perform public.fn_err('permission_escalation', 'station'); end if;
  end if;

  with del as (
    delete from public.role_permissions rp using public.permissions pm
    where rp.role_id = p_role_id and rp.restaurant_id = v_rid and pm.id = rp.permission_id and pm.key <> all (v_keys)
    returning pm.key
  ) select coalesce(array_agg(key order by key), '{}') into v_removed from del;

  with ins as (
    insert into public.role_permissions (role_id, permission_id, restaurant_id)
    select p_role_id, pm.id, v_rid from public.permissions pm where pm.key = any (v_keys)
    on conflict do nothing
    returning permission_id
  ) select coalesce(array_agg(pm.key order by pm.key), '{}') into v_added
    from ins join public.permissions pm on pm.id = ins.permission_id;

  with del as (
    delete from public.role_station_access rsa
    where rsa.role_id = p_role_id and rsa.restaurant_id = v_rid and rsa.station_id <> all (v_stations)
    returning rsa.station_id
  ) select coalesce(array_agg(station_id), '{}') into v_st_removed from del;

  with ins as (
    insert into public.role_station_access (role_id, station_id, restaurant_id)
    select p_role_id, s, v_rid from unnest(v_stations) s
    on conflict do nothing
    returning station_id
  ) select coalesce(array_agg(station_id), '{}') into v_st_added from ins;

  perform public.fn_write_audit('role.permissions_updated', jsonb_build_object(
    'role_id', p_role_id, 'added', v_added, 'removed', v_removed,
    'stations_added', v_st_added, 'stations_removed', v_st_removed));

  return jsonb_build_object('role_id', p_role_id, 'added', v_added, 'removed', v_removed,
                            'stations_added', v_st_added, 'stations_removed', v_st_removed);
end;
$$;
