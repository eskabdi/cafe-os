-- 0018  Identity lifecycle, staff provisioning, Auth hook, provisioning hardening
--
--  M6 / identity rotation. A demoted tenant_admin keeps a REAL email identity with a usable password. Demotion now
--     marks the profile identity_rotation_pending = true (fn_change_user_role returns requires_identity_rotation):
--       * the profile is not PIN-eligible (no PIN can be set or verified), so it has no profile_secrets row;
--       * fn_guard_profile_auth_method now enforces the synthetic-email rule on UPDATE as well: a 'pin' profile with a
--         non-synthetic email can exist only while the pending flag is set, and the flag can only be cleared once the
--         auth identity really is <username>@<slug>.staff.cafeos.invalid (fn_complete_identity_rotation, service_role);
--       * the Auth password-verification hook below rejects password sign-in for every auth_method = 'pin' profile, so
--         the old password stops working immediately, before the identity has been rotated.
--     The rotation itself (rewrite the auth.users email, set a random password and app_metadata.staff = true) needs the
--     Auth admin API: it belongs to an Edge Function (follow-up, see docs/architecture/auth-flows.md).
--  SM7. fn_auth_password_verification_hook: Supabase Auth "password verification attempt" hook (Postgres function).
--     Input {"user_id": uuid, "valid": bool}; output {"decision":"continue"} or {"decision":"reject","message":...}.
--     PIN staff can never sign in with a password (GoTrue would otherwise let them set one via PUT /user).
--     Callable ONLY by supabase_auth_admin. SECURITY DEFINER, so supabase_auth_admin needs no table grants, only
--     USAGE on schema public (granted here) and EXECUTE on this function.
--  Staff provisioning (pin-login depends on it): fn_prepare_staff_creation (validation + slug for the Edge Function)
--     and fn_create_staff_profile (the profile row for an Auth user the Edge Function created with the service role).
--  Provisioning: fn_provision_tenant refuses an unconfirmed owner email (p_require_confirmed, default true; only
--     service_role may pass false: local/demo flows), and a reserved slug raises invalid_slug (L3), not a raw CHECK error.
--  H2/RPC: fn_change_user_role takes the tenant_admin role row lock before its last-admin precheck; both it and
--     fn_update_role_permissions require step-up (aal2) when the caller has an MFA factor (see 0015).

-- ── schema ──────────────────────────────────────────────────────────────────
alter table public.profiles add column identity_rotation_pending boolean not null default false;

create or replace function public.fn_pin_eligible(p_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    join public.roles ro on ro.id = p.role_id and ro.restaurant_id = p.restaurant_id
    where p.id = p_profile_id
      and p.auth_method = 'pin'
      and not p.identity_rotation_pending
      and ro.system_key is null
      and not exists (select 1 from public.platform_admins a where a.id = p.id)
  )
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

-- ── change role (lock, step-up, rotation marker) ────────────────────────────
create or replace function public.fn_change_user_role(p_profile_id uuid, p_role_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rid uuid;
  v_target record;
  v_role public.roles%rowtype;
  v_is_admin boolean;
  v_to_admin boolean;
  v_email text;
  v_rotation boolean := false;
begin
  v_rid := public.fn_tenant_status_guard(true);
  if not public.has_permission('users.manage') then
    perform public.fn_err('permission_denied');
  end if;
  perform public.fn_require_step_up();
  if p_profile_id is null or p_role_id is null then perform public.fn_err('invalid_input'); end if;

  select p.id, p.role_id, p.is_active, p.identity_rotation_pending, ro.system_key as current_key into v_target
  from public.profiles p
  join public.roles ro on ro.id = p.role_id and ro.restaurant_id = p.restaurant_id
  where p.id = p_profile_id and p.restaurant_id = v_rid;
  if not found then perform public.fn_err('not_found'); end if;

  select * into v_role from public.roles r where r.id = p_role_id and r.restaurant_id = v_rid;
  if not found or not v_role.is_active then perform public.fn_err('invalid_role'); end if;

  if v_role.id = v_target.role_id then
    return jsonb_build_object('profile_id', p_profile_id, 'role_id', p_role_id, 'changed', false,
                              'requires_identity_rotation', v_target.identity_rotation_pending);
  end if;

  v_is_admin := public.is_tenant_admin();
  if (v_role.system_key = 'tenant_admin' or v_target.current_key = 'tenant_admin') and not v_is_admin then
    perform public.fn_err('permission_denied', 'tenant_admin assignment requires tenant_admin');
  end if;
  if p_profile_id = (select auth.uid()) and not v_is_admin then
    perform public.fn_err('permission_denied', 'cannot change your own role');
  end if;

  if not v_is_admin then
    -- no escalation through assignment: the target role may not exceed the caller's own rights
    if not public.fn_caller_covers_role(p_role_id) then
      perform public.fn_err('permission_escalation');
    end if;
  end if;

  if v_target.current_key = 'tenant_admin' then
    -- serialise with every other admin-removing transaction of this tenant (the profiles trigger does the same)
    perform 1 from public.roles r
    where r.restaurant_id = v_rid and r.system_key = 'tenant_admin'
    for no key update;
    if v_target.is_active and not exists (
      select 1 from public.profiles p
      join public.roles r on r.id = p.role_id and r.restaurant_id = p.restaurant_id
      where p.restaurant_id = v_rid and p.id <> p_profile_id and p.is_active and r.system_key = 'tenant_admin'
    ) then
      perform public.fn_err('last_tenant_admin');
    end if;
  end if;

  -- auth method follows the role: promotion => password login (PIN secret destroyed),
  -- demotion => PIN login, but only once the identity has been rotated to the synthetic staff email
  v_to_admin := (v_role.system_key = 'tenant_admin');
  select u.email into v_email from auth.users u where u.id = p_profile_id;
  if v_to_admin and (v_email is null or v_email ~* '\.invalid$') then
    perform public.fn_err('admin_requires_email_identity');
  end if;
  if v_to_admin then
    delete from public.profile_secrets where profile_id = p_profile_id and restaurant_id = v_rid;
  else
    v_rotation := v_email is null or v_email !~* '^[a-z0-9._-]+@[a-z0-9-]+\.staff\.cafeos\.invalid$';
    if v_rotation then
      -- a pending account holds no PIN: any secret is destroyed with the old identity's trust
      delete from public.profile_secrets where profile_id = p_profile_id and restaurant_id = v_rid;
    end if;
  end if;
  update public.profiles
     set role_id = p_role_id,
         auth_method = case when v_to_admin then 'password' else 'pin' end,
         identity_rotation_pending = v_rotation
   where id = p_profile_id and restaurant_id = v_rid;

  perform public.fn_write_audit('user.role_changed', jsonb_build_object(
    'profile_id', p_profile_id, 'from_role_id', v_target.role_id, 'to_role_id', p_role_id,
    'auth_method', case when v_to_admin then 'password' else 'pin' end,
    'requires_identity_rotation', v_rotation));
  return jsonb_build_object('profile_id', p_profile_id, 'role_id', p_role_id, 'changed', true,
    'auth_method', case when v_to_admin then 'password' else 'pin' end,
    'requires_identity_rotation', v_rotation);
end;
$$;

-- ── fn_update_role_permissions (0008 body + step-up) ────────────────────────
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

-- ── identity rotation completion (service_role: called by the Edge Function after it rewrote the auth user) ──
create or replace function public.fn_complete_identity_rotation(p_profile_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record;
begin
  if not public.is_service_role() then perform public.fn_err('permission_denied'); end if;
  select p.id, p.restaurant_id, p.username, p.identity_rotation_pending, r.slug, u.email, u.raw_app_meta_data
    into v
  from public.profiles p
  join public.restaurants r on r.id = p.restaurant_id
  left join auth.users u on u.id = p.id
  where p.id = p_profile_id;
  if not found then perform public.fn_err('not_found'); end if;
  if not v.identity_rotation_pending then perform public.fn_err('invalid_state', 'no rotation pending'); end if;
  if v.email is null or lower(v.email) <> v.username || '@' || v.slug || '.staff.cafeos.invalid'
     or coalesce(v.raw_app_meta_data ->> 'staff', '') <> 'true' then
    perform public.fn_err('identity_not_rotated');
  end if;
  update public.profiles set identity_rotation_pending = false where id = p_profile_id;
  perform public.fn_write_audit('user.identity_rotated', jsonb_build_object('profile_id', p_profile_id), v.restaurant_id);
  return jsonb_build_object('profile_id', p_profile_id, 'rotated', true);
end;
$$;

-- ── staff provisioning ──────────────────────────────────────────────────────
create or replace function public.fn_staff_email(p_username text, p_slug text)
returns text
language sql immutable set search_path = ''
as $$ select p_username || '@' || p_slug || '.staff.cafeos.invalid' $$;
revoke all on function public.fn_staff_email(text, text) from public, anon, authenticated;

-- shared validation of (username, role) for the caller's tenant; returns the tenant's slug
create or replace function public.fn_staff_precheck(p_rid uuid, p_username text, p_role_id uuid)
returns text
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_slug text;
  v_max integer;
begin
  if p_username is null or p_username !~ '^[a-z0-9][a-z0-9._-]{1,31}$' then
    perform public.fn_err('invalid_input', 'username');
  end if;
  if p_role_id is null
     or not exists (select 1 from public.roles ro
                    where ro.id = p_role_id and ro.restaurant_id = p_rid and ro.is_active and ro.system_key is null) then
    perform public.fn_err('invalid_role');
  end if;
  if not public.fn_caller_covers_role(p_role_id) then perform public.fn_err('permission_escalation'); end if;
  if exists (select 1 from public.profiles p where p.restaurant_id = p_rid and p.username = p_username) then
    perform public.fn_err('username_taken');
  end if;
  select pl.max_staff into v_max
  from public.subscriptions s join public.plans pl on pl.id = s.plan_id where s.restaurant_id = p_rid;
  if v_max is not null and (select count(*) from public.profiles p where p.restaurant_id = p_rid and p.is_active) >= v_max then
    perform public.fn_err('staff_limit_reached');
  end if;
  select r.slug into v_slug from public.restaurants r where r.id = p_rid;
  return v_slug;
end;
$$;
revoke all on function public.fn_staff_precheck(uuid, text, uuid) from public, anon, authenticated;

create or replace function public.fn_prepare_staff_creation(p_username text, p_role_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_rid uuid := public.fn_tenant_status_guard(true);
  v_user text := lower(btrim(coalesce(p_username, '')));
begin
  if not public.has_permission('users.manage') then perform public.fn_err('permission_denied'); end if;
  return jsonb_build_object('slug', public.fn_staff_precheck(v_rid, v_user, p_role_id), 'username', v_user);
end;
$$;
revoke all on function public.fn_prepare_staff_creation(text, uuid) from public, anon;
grant execute on function public.fn_prepare_staff_creation(text, uuid) to authenticated;

create or replace function public.fn_create_staff_profile(
  p_auth_user_id uuid,
  p_first_name text,
  p_middle_name text,
  p_last_name text,
  p_username text,
  p_role_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rid uuid := public.fn_tenant_status_guard(true);
  v_user text := lower(btrim(coalesce(p_username, '')));
  v_first text := btrim(coalesce(p_first_name, ''));
  v_middle text := nullif(btrim(coalesce(p_middle_name, '')), '');
  v_last text := nullif(btrim(coalesce(p_last_name, '')), '');
  v_slug text;
  v_email text;
  v_meta jsonb;
begin
  if not public.has_permission('users.manage') then perform public.fn_err('permission_denied'); end if;
  if char_length(v_first) not between 1 and 60
     or (v_middle is not null and char_length(v_middle) > 60)
     or (v_last is not null and char_length(v_last) > 60) then
    perform public.fn_err('invalid_input', 'name');
  end if;
  v_slug := public.fn_staff_precheck(v_rid, v_user, p_role_id);

  -- The auth user must be the synthetic identity of THIS tenant and username (the email embeds the caller's own
  -- slug, so another tenant's accounts can never match), created by the service role (app_metadata.staff = true;
  -- app_metadata is not user-writable), and must not already be a profile / platform admin.
  select u.email, u.raw_app_meta_data into v_email, v_meta from auth.users u where u.id = p_auth_user_id;
  if not found or v_email is null
     or lower(v_email) <> public.fn_staff_email(v_user, v_slug)
     or coalesce(v_meta ->> 'staff', '') <> 'true'
     or exists (select 1 from public.profiles p where p.id = p_auth_user_id)
     or exists (select 1 from public.platform_admins a where a.id = p_auth_user_id) then
    perform public.fn_err('invalid_auth_user');
  end if;

  begin
    insert into public.profiles (id, restaurant_id, first_name, middle_name, last_name, username, role_id, auth_method)
    values (p_auth_user_id, v_rid, v_first, v_middle, v_last, v_user, p_role_id, 'pin');
  exception when unique_violation then
    perform public.fn_err('username_taken');
  end;

  perform public.fn_write_audit('user.created', jsonb_build_object('profile_id', p_auth_user_id, 'role_id', p_role_id));
  return jsonb_build_object('profile_id', p_auth_user_id);
end;
$$;
revoke all on function public.fn_create_staff_profile(uuid, text, text, text, text, uuid) from public, anon;
grant execute on function public.fn_create_staff_profile(uuid, text, text, text, text, uuid) to authenticated;

-- ── Supabase Auth hook: password verification attempt ───────────────────────
create or replace function public.fn_auth_password_verification_hook(event jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
  v_method text;
begin
  begin
    v_uid := (event ->> 'user_id')::uuid;
  exception when others then
    v_uid := null;
  end;
  -- fail closed on a malformed event; the message is GoTrue's own generic one (no enumeration)
  if v_uid is null then
    return jsonb_build_object('decision', 'reject', 'message', 'Invalid login credentials');
  end if;
  select p.auth_method into v_method from public.profiles p where p.id = v_uid;
  if v_method = 'pin' then
    return jsonb_build_object('decision', 'reject', 'message', 'Invalid login credentials');
  end if;
  return jsonb_build_object('decision', 'continue');
end;
$$;
revoke all on function public.fn_auth_password_verification_hook(jsonb) from public, anon, authenticated, service_role;
grant usage on schema public to supabase_auth_admin;
grant execute on function public.fn_auth_password_verification_hook(jsonb) to supabase_auth_admin;

-- ── fn_provision_tenant: confirmed owner email, reserved slug => invalid_slug ─
drop function public.fn_provision_tenant(text, text, uuid, text, text, text, text, uuid, text);

create or replace function public.fn_slug_is_reserved(p_slug text)
returns boolean
language sql immutable set search_path = ''
as $$ select p_slug in ('www','api','app','admin','platform','static','assets','auth','login','r','cdn','mail','support') $$;
revoke all on function public.fn_slug_is_reserved(text) from public, anon, authenticated;

create or replace function public.fn_provision_tenant(
  p_name text,
  p_slug text,
  p_owner_user_id uuid,
  p_owner_email text,
  p_owner_first_name text,
  p_owner_middle_name text,
  p_owner_last_name text,
  p_plan_id uuid,
  p_owner_username text default null,
  p_require_confirmed boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_slug text := lower(btrim(coalesce(p_slug, '')));
  v_name text := btrim(coalesce(p_name, ''));
  v_first text := btrim(coalesce(p_owner_first_name, ''));
  v_username text;
  v_rid uuid;
  v_seed jsonb;
  v_day uuid;
  v_float numeric(12,2);
begin
  if not (public.is_service_role() or public.is_platform_super_admin()) then
    perform public.fn_err('permission_denied');
  end if;
  -- only service flows (local seed, CI) may skip the email-confirmation check
  if not coalesce(p_require_confirmed, true) and not public.is_service_role() then
    perform public.fn_err('permission_denied');
  end if;

  if char_length(v_name) not between 1 and 120 then perform public.fn_err('invalid_input', 'name'); end if;
  if v_slug !~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$' or v_slug ~ '--' or public.fn_slug_is_reserved(v_slug) then
    perform public.fn_err('invalid_slug');
  end if;
  if char_length(v_first) not between 1 and 60 then perform public.fn_err('invalid_input', 'owner_first_name'); end if;
  if p_owner_user_id is null then perform public.fn_err('invalid_input', 'owner_user_id'); end if;

  v_username := lower(coalesce(nullif(btrim(p_owner_username), ''),
                               nullif(regexp_replace(v_first, '[^A-Za-z0-9]', '', 'g'), ''),
                               'owner'));
  if v_username !~ '^[a-z0-9][a-z0-9._-]{1,31}$' then perform public.fn_err('invalid_input', 'owner_username'); end if;

  -- the owner (tenant_admin) signs in with Supabase Auth email + password: a REAL, CONFIRMED email identity
  if not exists (select 1 from auth.users u where u.id = p_owner_user_id) then
    perform public.fn_err('owner_not_found');
  end if;
  if p_owner_email is null or p_owner_email !~* '^[^@\s]+@[^@\s]+\.[a-z]{2,}$' or p_owner_email ~* '\.invalid$'
     or not exists (select 1 from auth.users u where u.id = p_owner_user_id and lower(u.email) = lower(btrim(p_owner_email))) then
    perform public.fn_err('owner_email_mismatch');
  end if;
  if coalesce(p_require_confirmed, true)
     and not exists (select 1 from auth.users u where u.id = p_owner_user_id and u.email_confirmed_at is not null) then
    perform public.fn_err('owner_email_unconfirmed');
  end if;
  if exists (select 1 from public.profiles p where p.id = p_owner_user_id)
     or exists (select 1 from public.platform_admins a where a.id = p_owner_user_id) then
    perform public.fn_err('owner_already_assigned');
  end if;
  if not exists (select 1 from public.plans pl where pl.id = p_plan_id and pl.is_active) then
    perform public.fn_err('invalid_plan');
  end if;
  if exists (select 1 from public.restaurants r where r.slug = v_slug) then
    perform public.fn_err('slug_taken');
  end if;

  begin
    insert into public.restaurants (name, slug, status, onboarded_at)
    values (v_name, v_slug, 'trialing', now())
    returning id, opening_float into v_rid, v_float;
  exception when unique_violation then
    perform public.fn_err('slug_taken');
  end;

  insert into public.subscriptions (restaurant_id, plan_id, status, trial_ends_at, current_period_start, current_period_end)
  values (v_rid, p_plan_id, 'trialing', now() + interval '14 days', now(), now() + interval '14 days');

  v_seed := public.fn_seed_tenant_defaults(v_rid);

  -- owner profile: password auth, deliberately NO profile_secrets row
  insert into public.profiles (id, restaurant_id, first_name, middle_name, last_name, username, role_id, auth_method)
  values (p_owner_user_id, v_rid, v_first,
          nullif(btrim(p_owner_middle_name), ''), nullif(btrim(p_owner_last_name), ''),
          v_username, (v_seed ->> 'admin_role_id')::uuid, 'password');

  insert into public.day_sessions (restaurant_id, day_no, status, opening_float, opened_by)
  values (v_rid, 1, 'open', v_float, p_owner_user_id)
  returning id into v_day;

  perform public.fn_write_audit('tenant.provisioned',
    jsonb_build_object('slug', v_slug, 'plan_id', p_plan_id, 'owner_profile_id', p_owner_user_id), v_rid);
  perform public.fn_write_admin_audit('tenant.provision', v_rid,
    jsonb_build_object('slug', v_slug, 'plan_id', p_plan_id));

  return jsonb_build_object(
    'restaurant_id', v_rid, 'slug', v_slug, 'owner_profile_id', p_owner_user_id,
    'admin_role_id', v_seed ->> 'admin_role_id', 'day_session_id', v_day);
end;
$$;
revoke all on function public.fn_provision_tenant(text, text, uuid, text, text, text, text, uuid, text, boolean) from public, anon;
grant execute on function public.fn_provision_tenant(text, text, uuid, text, text, text, text, uuid, text, boolean)
  to authenticated, service_role;
revoke all on function public.fn_change_user_role(uuid, uuid), public.fn_update_role_permissions(uuid, text[], uuid[])
  from public, anon;
grant execute on function public.fn_change_user_role(uuid, uuid), public.fn_update_role_permissions(uuid, text[], uuid[])
  to authenticated;
revoke all on function public.fn_complete_identity_rotation(uuid) from public, anon, authenticated;
grant execute on function public.fn_complete_identity_rotation(uuid) to service_role;
