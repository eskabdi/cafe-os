-- 0008  Phase-1 RPCs. Conventions (docs/architecture/rpc-conventions.md):
--  * SECURITY DEFINER + set search_path = '' + fully qualified names
--  * tenant/user derived server-side (fn_tenant_status_guard), never from parameters
--  * errors: RAISE EXCEPTION USING errcode='P0001', message=<stable code>, detail=<safe context> (via fn_err)
--  * every state change is audited (row triggers and/or fn_write_audit events)
--  * EXECUTE grants are finalised in migration 0009 (default: nobody)

-- ═══════════ seeding of per-tenant default DATA (internal) ═══════════
-- Roles, matrix, stations, categories, payment methods, table areas and expense categories are
-- inserted as ordinary rows. No application code depends on these names; tenants rename/extend freely.
create or replace function public.fn_seed_tenant_defaults(p_restaurant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin   uuid; v_cashier uuid; v_waiter uuid; v_kitchen uuid; v_pastry uuid; v_bar uuid;
  v_st_k    uuid; v_st_p uuid; v_st_b uuid;
begin
  if not exists (select 1 from public.restaurants r where r.id = p_restaurant_id) then
    perform public.fn_err('not_found');
  end if;
  if exists (select 1 from public.roles r where r.restaurant_id = p_restaurant_id) then
    perform public.fn_err('already_seeded');
  end if;

  -- roles (exactly one system role: tenant_admin)
  insert into public.roles (restaurant_id, name, description, color, icon, sort_order, is_system, system_key)
  values (p_restaurant_id, 'Administrator', 'Restaurant owner / administrator (system role)', '#dc2626', 'shield-check', 0, true, 'tenant_admin')
  returning id into v_admin;
  insert into public.roles (restaurant_id, name, description, color, icon, sort_order) values
    (p_restaurant_id, 'Cashier', 'Takes payments and issues vouchers', '#16a34a', 'wallet', 10) returning id into v_cashier;
  insert into public.roles (restaurant_id, name, description, color, icon, sort_order) values
    (p_restaurant_id, 'Waiter', 'Takes and submits orders', '#2563eb', 'concierge-bell', 20) returning id into v_waiter;
  insert into public.roles (restaurant_id, name, description, color, icon, sort_order) values
    (p_restaurant_id, 'Kitchen', 'Prepares kitchen tickets', '#f97316', 'chef-hat', 30) returning id into v_kitchen;
  insert into public.roles (restaurant_id, name, description, color, icon, sort_order) values
    (p_restaurant_id, 'Pastry', 'Prepares pastry tickets', '#ec4899', 'croissant', 40) returning id into v_pastry;
  insert into public.roles (restaurant_id, name, description, color, icon, sort_order) values
    (p_restaurant_id, 'Bar', 'Prepares bar tickets', '#0ea5e9', 'coffee', 50) returning id into v_bar;

  -- stations
  insert into public.stations (restaurant_id, name, description, color, icon, sort_order)
  values (p_restaurant_id, 'Kitchen', 'Hot kitchen', '#f97316', 'chef-hat', 10) returning id into v_st_k;
  insert into public.stations (restaurant_id, name, description, color, icon, sort_order)
  values (p_restaurant_id, 'Pastry', 'Bakery and desserts', '#ec4899', 'croissant', 20) returning id into v_st_p;
  insert into public.stations (restaurant_id, name, description, color, icon, sort_order)
  values (p_restaurant_id, 'Bar', 'Coffee and drinks', '#0ea5e9', 'coffee', 30) returning id into v_st_b;

  -- role -> station access (structured equivalent of station:<uuid>)
  insert into public.role_station_access (role_id, station_id, restaurant_id) values
    (v_kitchen, v_st_k, p_restaurant_id), (v_pastry, v_st_p, p_restaurant_id), (v_bar, v_st_b, p_restaurant_id);

  -- permission matrix: tenant_admin gets the whole catalog; others per prototype defaultPermissions()
  insert into public.role_permissions (role_id, permission_id, restaurant_id)
  select v_admin, pm.id, p_restaurant_id from public.permissions pm;

  insert into public.role_permissions (role_id, permission_id, restaurant_id)
  select m.role_id, pm.id, p_restaurant_id
  from (values
    (v_cashier, array['dashboard.view','orders.view','orders.view_all','payments.create','payments.view',
                      'vouchers.view','vouchers.manage','reports.view','menu.view','tables.view']),
    (v_waiter,  array['dashboard.view','orders.view','orders.create','orders.cancel','menu.view','tables.view']),
    (v_kitchen, array['orders.view','inventory.view']),
    (v_pastry,  array['orders.view','inventory.view']),
    (v_bar,     array['orders.view','inventory.view'])
  ) as m(role_id, keys)
  join public.permissions pm on pm.key = any (m.keys);

  insert into public.categories (restaurant_id, name, color, icon, sort_order) values
    (p_restaurant_id, 'Breakfast', '#f59e0b', 'sunrise', 10),
    (p_restaurant_id, 'Lunch', '#ef4444', 'utensils', 20),
    (p_restaurant_id, 'Fast Food', '#f97316', 'sandwich', 30),
    (p_restaurant_id, 'Beverages', '#0ea5e9', 'cup-soda', 40);

  insert into public.payment_methods (restaurant_id, name, color, icon, sort_order, affects_cash_drawer, requires_reference) values
    (p_restaurant_id, 'Cash', '#16a34a', 'banknote', 10, true, false),
    (p_restaurant_id, 'CBE Birr', '#7c3aed', 'landmark', 20, false, true),
    (p_restaurant_id, 'Telebirr', '#0891b2', 'smartphone', 30, false, true),
    (p_restaurant_id, 'Card', '#475569', 'credit-card', 40, false, true);

  insert into public.table_areas (restaurant_id, name, color, icon, sort_order) values
    (p_restaurant_id, 'Main Hall', '#2563eb', 'armchair', 10),
    (p_restaurant_id, 'Terrace', '#16a34a', 'sun', 20),
    (p_restaurant_id, 'VIP', '#a855f7', 'crown', 30);

  insert into public.expense_categories (restaurant_id, name, color, icon, sort_order) values
    (p_restaurant_id, 'Purchases', '#f97316', 'shopping-basket', 10),
    (p_restaurant_id, 'Utilities', '#eab308', 'zap', 20),
    (p_restaurant_id, 'Rent', '#6366f1', 'home', 30),
    (p_restaurant_id, 'Salaries', '#16a34a', 'users', 40),
    (p_restaurant_id, 'Maintenance', '#64748b', 'wrench', 50),
    (p_restaurant_id, 'Transport', '#0ea5e9', 'truck', 60),
    (p_restaurant_id, 'Marketing', '#ec4899', 'megaphone', 70),
    (p_restaurant_id, 'Other', '#94a3b8', 'ellipsis', 80);

  return jsonb_build_object('admin_role_id', v_admin);
end;
$$;

-- ═══════════ tenant provisioning ═══════════
create or replace function public.fn_provision_tenant(
  p_name text,
  p_slug text,
  p_owner_user_id uuid,
  p_owner_email text,
  p_owner_first_name text,
  p_owner_middle_name text,
  p_owner_last_name text,
  p_plan_id uuid,
  p_owner_username text default null
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

  if char_length(v_name) not between 1 and 120 then perform public.fn_err('invalid_input', 'name'); end if;
  if v_slug !~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$' or v_slug ~ '--' then
    perform public.fn_err('invalid_slug');
  end if;
  if char_length(v_first) not between 1 and 60 then perform public.fn_err('invalid_input', 'owner_first_name'); end if;
  if p_owner_user_id is null then perform public.fn_err('invalid_input', 'owner_user_id'); end if;

  v_username := lower(coalesce(nullif(btrim(p_owner_username), ''),
                               nullif(regexp_replace(v_first, '[^A-Za-z0-9]', '', 'g'), ''),
                               'owner'));
  if v_username !~ '^[a-z0-9][a-z0-9._-]{1,31}$' then perform public.fn_err('invalid_input', 'owner_username'); end if;

  -- the owner (tenant_admin) signs in with Supabase Auth email + password: a REAL email identity
  if not exists (select 1 from auth.users u where u.id = p_owner_user_id) then
    perform public.fn_err('owner_not_found');
  end if;
  if p_owner_email is null or p_owner_email !~* '^[^@\s]+@[^@\s]+\.[a-z]{2,}$' or p_owner_email ~* '\.invalid$'
     or not exists (select 1 from auth.users u where u.id = p_owner_user_id and lower(u.email) = lower(btrim(p_owner_email))) then
    perform public.fn_err('owner_email_mismatch');
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
    jsonb_build_object('slug', v_slug, 'plan_id', p_plan_id, 'owner_profile_id', p_owner_user_id),
    v_rid, p_owner_user_id);
  perform public.fn_write_admin_audit('tenant.provision', v_rid,
    jsonb_build_object('slug', v_slug, 'plan_id', p_plan_id));

  return jsonb_build_object(
    'restaurant_id', v_rid, 'slug', v_slug, 'owner_profile_id', p_owner_user_id,
    'admin_role_id', v_seed ->> 'admin_role_id', 'day_session_id', v_day);
end;
$$;

-- ═══════════ role / permission management ═══════════
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
begin
  v_rid := public.fn_tenant_status_guard(true);
  if not public.has_permission('users.manage') then
    perform public.fn_err('permission_denied');
  end if;
  if p_profile_id is null or p_role_id is null then perform public.fn_err('invalid_input'); end if;

  select p.id, p.role_id, p.is_active, ro.system_key as current_key into v_target
  from public.profiles p
  join public.roles ro on ro.id = p.role_id and ro.restaurant_id = p.restaurant_id
  where p.id = p_profile_id and p.restaurant_id = v_rid;
  if not found then perform public.fn_err('not_found'); end if;

  select * into v_role from public.roles r where r.id = p_role_id and r.restaurant_id = v_rid;
  if not found or not v_role.is_active then perform public.fn_err('invalid_role'); end if;

  if v_role.id = v_target.role_id then
    return jsonb_build_object('profile_id', p_profile_id, 'role_id', p_role_id, 'changed', false);
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
    if exists (
      select 1 from public.role_permissions rp join public.permissions pm on pm.id = rp.permission_id
      where rp.role_id = p_role_id and not public.has_permission(pm.key)
    ) or exists (
      select 1 from public.role_station_access rsa
      where rsa.role_id = p_role_id and not public.has_station_access(rsa.station_id)
    ) then
      perform public.fn_err('permission_escalation');
    end if;
  end if;

  if v_target.current_key = 'tenant_admin' and v_target.is_active and not exists (
    select 1 from public.profiles p
    join public.roles r on r.id = p.role_id and r.restaurant_id = p.restaurant_id
    where p.restaurant_id = v_rid and p.id <> p_profile_id and p.is_active and r.system_key = 'tenant_admin'
  ) then
    perform public.fn_err('last_tenant_admin');
  end if;

  -- auth method follows the role: promotion => password login (PIN secret destroyed),
  -- demotion => PIN login (a NEW PIN must be set; none exists until then)
  v_to_admin := (v_role.system_key = 'tenant_admin');
  if v_to_admin and exists (select 1 from auth.users u where u.id = p_profile_id and (u.email is null or u.email ~* '\.invalid$')) then
    perform public.fn_err('admin_requires_email_identity');
  end if;
  if v_to_admin then
    delete from public.profile_secrets where profile_id = p_profile_id and restaurant_id = v_rid;
  end if;
  update public.profiles
     set role_id = p_role_id, auth_method = case when v_to_admin then 'password' else 'pin' end
   where id = p_profile_id and restaurant_id = v_rid;

  perform public.fn_write_audit('user.role_changed', jsonb_build_object(
    'profile_id', p_profile_id, 'from_role_id', v_target.role_id, 'to_role_id', p_role_id,
    'auth_method', case when v_to_admin then 'password' else 'pin' end,
    'pin_requires_reset', not v_to_admin and v_target.current_key = 'tenant_admin'));
  return jsonb_build_object('profile_id', p_profile_id, 'role_id', p_role_id, 'changed', true,
    'auth_method', case when v_to_admin then 'password' else 'pin' end);
end;
$$;

-- ═══════════ PIN management (service_role only: called by the pin-login Edge Function) ═══════════
create or replace function public.fn_set_user_pin(p_profile_id uuid, p_pin text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rid uuid;
begin
  if not public.is_service_role() then perform public.fn_err('permission_denied'); end if;
  if p_pin is null or p_pin !~ '^[0-9]{4,8}$' then perform public.fn_err('invalid_pin'); end if;
  select p.restaurant_id into v_rid from public.profiles p where p.id = p_profile_id;
  if not found then perform public.fn_err('not_found'); end if;
  -- tenant_admin and platform admins authenticate with email + password, never a PIN
  if not public.fn_pin_eligible(p_profile_id) then perform public.fn_err('pin_not_allowed'); end if;

  insert into public.profile_secrets (profile_id, restaurant_id, pin_hash)
  values (p_profile_id, v_rid, extensions.crypt(p_pin, extensions.gen_salt('bf', 10)))
  on conflict (profile_id) do update
    set pin_hash = excluded.pin_hash, failed_attempts = 0, locked_until = null, pin_changed_at = now();

  perform public.fn_write_audit('auth.pin_set', jsonb_build_object('profile_id', p_profile_id), v_rid, p_profile_id);
end;
$$;

create or replace function public.fn_register_pin_failure(p_profile_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempts integer;
  v_locked timestamptz;
  v_rid uuid;
  v_was_locked boolean;
begin
  if not public.is_service_role() then perform public.fn_err('permission_denied'); end if;
  if not public.fn_pin_eligible(p_profile_id) then
    return jsonb_build_object('locked', false, 'failed_attempts', 0);  -- identical to "no such profile"
  end if;

  update public.profile_secrets ps
     set failed_attempts = ps.failed_attempts + 1,
         locked_until = case
           when ps.locked_until is not null and ps.locked_until > now() then ps.locked_until
           when ps.failed_attempts + 1 >= 5 then now() + interval '15 minutes'
           else ps.locked_until end
   where ps.profile_id = p_profile_id
   returning ps.failed_attempts, ps.locked_until, ps.restaurant_id into v_attempts, v_locked, v_rid;
  if not found then
    return jsonb_build_object('locked', false, 'failed_attempts', 0);
  end if;

  v_was_locked := v_locked is not null and v_locked > now();
  perform public.fn_write_audit(case when v_was_locked and v_attempts = 5 then 'auth.account_locked' else 'auth.pin_failed' end,
    jsonb_build_object('profile_id', p_profile_id, 'failed_attempts', v_attempts), v_rid, p_profile_id);
  return jsonb_build_object('locked', v_was_locked, 'locked_until', v_locked, 'failed_attempts', v_attempts);
end;
$$;

-- Returns {status: ok|invalid|locked|inactive, ...}. Never raises on a bad PIN (the failure counter must
-- commit), never returns pin_hash.
create or replace function public.fn_verify_pin(p_profile_id uuid, p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record;
  v_fail jsonb;
begin
  if not public.is_service_role() then perform public.fn_err('permission_denied'); end if;

  select ps.pin_hash, ps.failed_attempts, ps.locked_until,
         p.is_active, p.restaurant_id, r.status as tenant_status,
         p.id, p.first_name, p.middle_name, p.last_name, p.short_name, p.username, p.role_id
    into v
  from public.profile_secrets ps
  join public.profiles p on p.id = ps.profile_id
  join public.restaurants r on r.id = p.restaurant_id
  where ps.profile_id = p_profile_id;

  if not found or p_pin is null or not public.fn_pin_eligible(p_profile_id) then
    perform extensions.crypt(coalesce(p_pin, ''), extensions.gen_salt('bf', 10)); -- uniform cost
    return jsonb_build_object('status', 'invalid');
  end if;
  if not v.is_active or v.tenant_status in ('suspended', 'cancelled') then
    return jsonb_build_object('status', 'inactive');
  end if;
  if v.locked_until is not null and v.locked_until > now() then
    return jsonb_build_object('status', 'locked', 'locked_until', v.locked_until);
  end if;
  if v.locked_until is not null then  -- lock expired: start a fresh window
    update public.profile_secrets set failed_attempts = 0, locked_until = null where profile_id = p_profile_id;
  end if;

  if extensions.crypt(p_pin, v.pin_hash) = v.pin_hash then
    update public.profile_secrets set failed_attempts = 0, locked_until = null where profile_id = p_profile_id;
    perform public.fn_write_audit('auth.pin_success', jsonb_build_object('profile_id', p_profile_id), v.restaurant_id, p_profile_id);
    return jsonb_build_object('status', 'ok', 'profile', jsonb_build_object(
      'id', v.id, 'restaurant_id', v.restaurant_id, 'first_name', v.first_name, 'middle_name', v.middle_name,
      'last_name', v.last_name, 'short_name', v.short_name, 'username', v.username, 'role_id', v.role_id));
  end if;

  v_fail := public.fn_register_pin_failure(p_profile_id);
  if (v_fail ->> 'locked')::boolean then
    return jsonb_build_object('status', 'locked', 'locked_until', v_fail -> 'locked_until');
  end if;
  return jsonb_build_object('status', 'invalid',
    'attempts_left', greatest(0, 5 - (v_fail ->> 'failed_attempts')::integer));
end;
$$;

-- ═══════════ platform: suspend / reactivate / resolve ═══════════
create or replace function public.fn_suspend_tenant(p_restaurant_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  if not public.is_platform_super_admin() then perform public.fn_err('permission_denied'); end if;
  if char_length(v_reason) not between 3 and 500 then perform public.fn_err('invalid_input', 'reason'); end if;

  select r.status into v_status from public.restaurants r where r.id = p_restaurant_id for update;
  if not found then perform public.fn_err('not_found'); end if;
  if v_status = 'suspended' then
    return jsonb_build_object('restaurant_id', p_restaurant_id, 'status', 'suspended', 'changed', false);
  end if;
  if v_status = 'cancelled' then perform public.fn_err('invalid_state', 'cancelled'); end if;

  update public.restaurants
     set status = 'suspended', status_before_suspension = v_status,
         suspended_at = now(), suspension_reason = v_reason
   where id = p_restaurant_id;
  update public.subscriptions set status = 'suspended' where restaurant_id = p_restaurant_id;

  perform public.fn_write_admin_audit('tenant.suspend', p_restaurant_id,
    jsonb_build_object('reason', v_reason, 'previous_status', v_status));
  perform public.fn_write_audit('tenant.suspended', jsonb_build_object('reason', v_reason), p_restaurant_id);
  return jsonb_build_object('restaurant_id', p_restaurant_id, 'status', 'suspended', 'changed', true);
end;
$$;

create or replace function public.fn_reactivate_tenant(p_restaurant_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_prev text;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  if not public.is_platform_super_admin() then perform public.fn_err('permission_denied'); end if;
  if char_length(v_reason) not between 3 and 500 then perform public.fn_err('invalid_input', 'reason'); end if;

  select r.status, coalesce(r.status_before_suspension, 'active') into v_status, v_prev
  from public.restaurants r where r.id = p_restaurant_id for update;
  if not found then perform public.fn_err('not_found'); end if;
  if v_status <> 'suspended' then perform public.fn_err('invalid_state', v_status); end if;

  update public.restaurants
     set status = v_prev, status_before_suspension = null, suspended_at = null, suspension_reason = null
   where id = p_restaurant_id;
  update public.subscriptions set status = v_prev where restaurant_id = p_restaurant_id;

  perform public.fn_write_admin_audit('tenant.reactivate', p_restaurant_id,
    jsonb_build_object('reason', v_reason, 'restored_status', v_prev));
  perform public.fn_write_audit('tenant.reactivated', jsonb_build_object('reason', v_reason), p_restaurant_id);
  return jsonb_build_object('restaurant_id', p_restaurant_id, 'status', v_prev, 'changed', true);
end;
$$;

-- Pre-auth slug resolver (anon-callable). Returns ONLY id, name and branding; unknown, malformed,
-- suspended and cancelled slugs are indistinguishable (NULL). The slug is not a security boundary.
create or replace function public.fn_resolve_tenant_slug(p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
           'id', r.id,
           'name', r.name,
           'branding', jsonb_build_object(
             'logo_path', r.branding -> 'logo_path',
             'primary_color', r.branding -> 'primary_color',
             'accent_color', r.branding -> 'accent_color'))
  from public.restaurants r
  where r.slug = lower(btrim(coalesce(p_slug, '')))
    and r.status not in ('suspended', 'cancelled')
$$;

-- ═══════════ session context for the app shell (authenticated) ═══════════
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
    'permissions', case when not ro.is_active then '[]'::jsonb
      when ro.system_key = 'tenant_admin' then (select coalesce(jsonb_agg(pm.key order by pm.key), '[]'::jsonb) from public.permissions pm)
      else (select coalesce(jsonb_agg(pm.key order by pm.key), '[]'::jsonb)
            from public.role_permissions rp join public.permissions pm on pm.id = rp.permission_id
            where rp.role_id = ro.id) end,
    'station_ids', case when not ro.is_active then '[]'::jsonb
      when ro.system_key = 'tenant_admin' then (select coalesce(jsonb_agg(s.id), '[]'::jsonb) from public.stations s where s.restaurant_id = r.id)
      else (select coalesce(jsonb_agg(rsa.station_id), '[]'::jsonb) from public.role_station_access rsa where rsa.role_id = ro.id) end,
    'tenant_writable', (r.status in ('trialing', 'active'))
  ) into v
  from public.profiles p
  join public.restaurants r on r.id = p.restaurant_id
  join public.roles ro on ro.id = p.role_id and ro.restaurant_id = p.restaurant_id
  where p.id = v_uid and p.is_active and r.status not in ('suspended', 'cancelled');

  if v is null and v_platform is null then
    return null;
  end if;
  return coalesce(v, '{}'::jsonb)
    || case when v_platform is null then '{}'::jsonb else jsonb_build_object('platform_role', v_platform) end;
end;
$$;

-- ═══════════ idempotency infrastructure (used by Phase 4+ command RPCs) ═══════════
create or replace function public.fn_idempotency_begin(p_key text, p_command text, p_request_hash text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rid uuid := public.fn_tenant_status_guard(true);
  v_id uuid;
  v_row public.idempotency_keys%rowtype;
begin
  if p_key is null or char_length(p_key) not between 8 and 128 or p_command is null then
    perform public.fn_err('invalid_input', 'idempotency_key');
  end if;
  insert into public.idempotency_keys (restaurant_id, key, command, request_hash, created_by)
  values (v_rid, p_key, p_command, p_request_hash, (select auth.uid()))
  on conflict (restaurant_id, key) do nothing
  returning id into v_id;
  if v_id is not null then
    return null;  -- first execution: caller proceeds
  end if;
  select * into v_row from public.idempotency_keys k where k.restaurant_id = v_rid and k.key = p_key;
  if v_row.command <> p_command
     or (v_row.request_hash is not null and p_request_hash is not null and v_row.request_hash <> p_request_hash) then
    perform public.fn_err('idempotency_conflict');
  end if;
  return jsonb_build_object('replay', true, 'result', v_row.result);
end;
$$;

create or replace function public.fn_idempotency_complete(p_key text, p_result jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rid uuid := public.fn_tenant_status_guard(true);
begin
  update public.idempotency_keys set result = p_result where restaurant_id = v_rid and key = p_key;
end;
$$;

-- Lets an Auth hook / Edge Function refuse password login for PIN-only staff accounts.
create or replace function public.fn_user_auth_method(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when exists (select 1 from public.platform_admins a where a.id = p_user_id and a.is_active) then 'password'
    else (select p.auth_method from public.profiles p where p.id = p_user_id)
  end
$$;
