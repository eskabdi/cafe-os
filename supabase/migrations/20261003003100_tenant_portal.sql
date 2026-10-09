-- 0031  Phase 3B (part 2): Tenant Portal administration, database layer (execution prompt §34A, Phase 3B)
--
--  Actor: the tenant's tenant_admin (or a delegate holding the permission). Tenant from identity (fn_tenant_status_guard), never a
--  parameter. Order in every command: tenant guard -> permission -> step-up / aal2 -> input validation -> lookup + lock -> rules
--  -> write -> audit event. Unknown and foreign ids both answer not_found.
--
--  1. WRITE PATH. roles (INSERT / UPDATE / DELETE), profiles (UPDATE) and restaurants (UPDATE) lose their client privileges; the
--     RPCs below are the only client write path (dependency guard, step-up, structured errors, semantic audit). SELECT under the
--     0007 policies stays. The trigger guards (system role, last tenant_admin, non-escalation, auth method, branding CHECKs) keep
--     applying to every path.
--  2. ROLES (roles.manage + step-up): fn_list_roles, fn_create_role, fn_update_role (name / description / color / icon /
--     sort_order), fn_set_role_active (deactivation refused with role_in_use while ACTIVE users hold the role), fn_delete_role (only
--     a role no profile ever held; its matrix rows go with it), fn_set_role_station_access (station access only; the matrix itself
--     stays fn_update_role_permissions). tenant_admin (system role): system_role_protected for every edit. A non-tenant_admin
--     caller may only touch roles it fully covers (permission_escalation) and never its own role (permission_denied).
--  3. USERS (users.view / users.manage): fn_list_users, fn_update_user (names), fn_set_user_active (step-up; never yourself; a
--     tenant_admin target needs a tenant_admin caller; reactivation needs an active role and a free staff slot),
--     fn_prepare_pin_reset (step 1 of the staff-pin-reset Edge Function). Creation stays staff-create, role assignment stays
--     fn_change_user_role, lockout reset stays fn_reset_pin_lockout, tenant_admin invitations are 0030.
--  4. RESTAURANT (settings.manage): fn_get_restaurant_profile, fn_update_restaurant_profile (name / phone / address / timezone,
--     step-up), fn_update_business_settings (tin / vat_rate / opening_float / auto_consume_stock, aal2 like the other money
--     settings), fn_update_restaurant_branding (strict #rrggbb colours, logo object in the private bucket tenant-branding at
--     restaurants/<own id>/branding/<file>.(png|jpg|jpeg|webp), step-up), fn_get_subscription_usage (own plan, limits, aggregate
--     usage; the same counters the Platform Admin Portal sees).
--  5. STORAGE. Private bucket tenant-branding (1 MiB, png / jpeg / webp; no SVG: script-capable). Policies like menu-images
--     (0029): case-sensitive own-tenant prefix derived from the caller's profile; read for every member of the tenant (the shell
--     shows the logo), write / delete with settings.manage on a writable tenant; the CURRENT logo can be neither renamed nor
--     deleted. Real Supabase Storage refuses a direct DELETE on storage.objects (the API removes objects); the policies still
--     describe who may remove an object through the Storage API.

-- ════════════════════════════════════════ 1. write path ════════════════════════════════════════
revoke insert, update, delete on public.roles from authenticated;
revoke update on public.profiles from authenticated;
revoke update on public.restaurants from authenticated;

-- ════════════════════════════════════════ 5. storage: tenant-branding ════════════════════════════════════════
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('tenant-branding', 'tenant-branding', false, 1048576, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update
  set public = false, file_size_limit = 1048576, allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp'];

create policy tenant_branding_select on storage.objects for select to authenticated
  using (bucket_id = 'tenant-branding'
         and name ~ ('^restaurants/' || (select public.current_restaurant_id())::text || '/branding/[A-Za-z0-9._-]{1,120}$'));
create policy tenant_branding_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'tenant-branding'
              and name ~ ('^restaurants/' || (select public.current_restaurant_id())::text
                          || '/branding/[A-Za-z0-9._-]{1,115}\.([pP][nN][gG]|[jJ][pP][eE]?[gG]|[wW][eE][bB][pP])$')
              and name !~ '\.\.'
              and (select public.has_permission('settings.manage'))
              and (select public.current_tenant_writable()));
create policy tenant_branding_update on storage.objects for update to authenticated
  using (bucket_id = 'tenant-branding'
         and name ~ ('^restaurants/' || (select public.current_restaurant_id())::text || '/branding/[A-Za-z0-9._-]{1,120}$')
         and (select public.has_permission('settings.manage')) and (select public.current_tenant_writable())
         and not exists (select 1 from public.restaurants r where r.branding ->> 'logo_path' = storage.objects.name))
  with check (bucket_id = 'tenant-branding'
              and name ~ ('^restaurants/' || (select public.current_restaurant_id())::text
                          || '/branding/[A-Za-z0-9._-]{1,115}\.([pP][nN][gG]|[jJ][pP][eE]?[gG]|[wW][eE][bB][pP])$')
              and name !~ '\.\.'
              and (select public.has_permission('settings.manage')) and (select public.current_tenant_writable()));
create policy tenant_branding_delete on storage.objects for delete to authenticated
  using (bucket_id = 'tenant-branding'
         and name ~ ('^restaurants/' || (select public.current_restaurant_id())::text || '/branding/[A-Za-z0-9._-]{1,120}$')
         and (select public.has_permission('settings.manage')) and (select public.current_tenant_writable())
         and not exists (select 1 from public.restaurants r where r.branding ->> 'logo_path' = storage.objects.name));

-- ════════════════════════════════════════ 2. roles ════════════════════════════════════════
create or replace function public.fn_role_json(p_role_id uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'id', ro.id, 'name', ro.name, 'description', ro.description, 'color', ro.color, 'icon', ro.icon,
    'sort_order', ro.sort_order, 'is_active', ro.is_active, 'is_system', ro.is_system, 'system_key', ro.system_key,
    'active_users', (select count(*) from public.profiles p where p.role_id = ro.id and p.restaurant_id = ro.restaurant_id and p.is_active),
    'total_users', (select count(*) from public.profiles p where p.role_id = ro.id and p.restaurant_id = ro.restaurant_id),
    'permission_keys', case when ro.system_key = 'tenant_admin'
                            then (select coalesce(jsonb_agg(pm.key order by pm.key), '[]'::jsonb) from public.permissions pm)
                            else (select coalesce(jsonb_agg(pm.key order by pm.key), '[]'::jsonb)
                                  from public.role_permissions rp join public.permissions pm on pm.id = rp.permission_id
                                  where rp.role_id = ro.id and rp.restaurant_id = ro.restaurant_id) end,
    'station_ids', case when ro.system_key = 'tenant_admin'
                        then (select coalesce(jsonb_agg(s.id order by s.sort_order, s.id), '[]'::jsonb) from public.stations s where s.restaurant_id = ro.restaurant_id)
                        else (select coalesce(jsonb_agg(rsa.station_id order by rsa.station_id), '[]'::jsonb)
                              from public.role_station_access rsa where rsa.role_id = ro.id and rsa.restaurant_id = ro.restaurant_id) end,
    'created_at', ro.created_at, 'updated_at', ro.updated_at)
  from public.roles ro where ro.id = p_role_id
$$;
revoke all on function public.fn_role_json(uuid) from public, anon, authenticated;

-- presentation fields of a role: name / description / color (#rrggbb, stored lower-case) / icon / sort_order
create or replace function public.fn_role_normalize(p_patch jsonb)
returns jsonb
language plpgsql immutable set search_path = ''
as $$
declare
  v jsonb := '{}'::jsonb;
  c text;
  i text;
begin
  perform public.fn_check_patch(p_patch, array['name', 'description', 'color', 'icon', 'sort_order']);
  if p_patch ? 'name' then v := v || jsonb_build_object('name', public.fn_json_text(p_patch, 'name', 60, false)); end if;
  if p_patch ? 'description' then v := v || jsonb_build_object('description', public.fn_json_text(p_patch, 'description', 300, true)); end if;
  if p_patch ? 'color' then
    c := public.fn_json_text(p_patch, 'color', 7, true);
    if c is not null and c !~ '^#[0-9a-fA-F]{6}$' then perform public.fn_err('invalid_input', 'color'); end if;
    v := v || jsonb_build_object('color', lower(c));
  end if;
  if p_patch ? 'icon' then
    i := public.fn_json_text(p_patch, 'icon', 40, true);
    if i is not null and i !~ '^[a-z0-9][a-z0-9-]{0,39}$' then perform public.fn_err('invalid_input', 'icon'); end if;
    v := v || jsonb_build_object('icon', i);
  end if;
  if p_patch ? 'sort_order' then
    if jsonb_typeof(p_patch -> 'sort_order') <> 'number' or (p_patch ->> 'sort_order')::numeric <> trunc((p_patch ->> 'sort_order')::numeric)
       or abs((p_patch ->> 'sort_order')::numeric) > 100000 then
      perform public.fn_err('invalid_input', 'sort_order');
    end if;
    v := v || jsonb_build_object('sort_order', (p_patch ->> 'sort_order')::integer);
  end if;
  return v;
end;
$$;
revoke all on function public.fn_role_normalize(jsonb) from public, anon, authenticated;

-- the role row of the caller's tenant, locked, with the shared edit rules. Returns system_key-free rows only.
create or replace function public.fn_role_for_edit(p_rid uuid, p_role_id uuid)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_key text;
begin
  if p_role_id is null then perform public.fn_err('invalid_input', 'role_id'); end if;
  select ro.system_key into v_key from public.roles ro where ro.id = p_role_id and ro.restaurant_id = p_rid for update;
  if not found then perform public.fn_err('not_found'); end if;
  if v_key is not null then perform public.fn_err('system_role_protected'); end if;
  if p_role_id = public.current_role_id() then perform public.fn_err('permission_denied', 'cannot edit your own role'); end if;
  if not public.fn_caller_covers_role(p_role_id) then perform public.fn_err('permission_escalation'); end if;
  return p_role_id;
end;
$$;
revoke all on function public.fn_role_for_edit(uuid, uuid) from public, anon, authenticated;

create or replace function public.fn_list_roles()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_rid uuid := public.fn_tenant_status_guard(false);
begin
  if not public.has_permission('roles.manage') then perform public.fn_err('permission_denied'); end if;
  return (select coalesce(jsonb_agg(public.fn_role_json(ro.id) order by ro.sort_order, ro.normalized_name), '[]'::jsonb)
          from public.roles ro where ro.restaurant_id = v_rid);
end;
$$;

create or replace function public.fn_create_role(p_role jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rid uuid;
  v jsonb;
  v_id uuid;
begin
  v_rid := public.fn_tenant_status_guard(true);
  if not public.has_permission('roles.manage') then perform public.fn_err('permission_denied'); end if;
  perform public.fn_require_step_up();
  v := public.fn_role_normalize(p_role);
  if not (v ? 'name') then perform public.fn_err('invalid_input', 'name'); end if;
  begin
    insert into public.roles (restaurant_id, name, description, color, icon, sort_order)
    values (v_rid, v ->> 'name', v ->> 'description', v ->> 'color', v ->> 'icon', coalesce((v ->> 'sort_order')::integer, 0))
    returning id into v_id;
  exception when unique_violation then
    perform public.fn_err('duplicate_name', v ->> 'name');
  end;
  perform public.fn_write_audit('role.created', jsonb_build_object('role_id', v_id, 'name', v ->> 'name'));
  return public.fn_role_json(v_id);
end;
$$;

create or replace function public.fn_update_role(p_role_id uuid, p_patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rid uuid;
  v jsonb;
  v_old jsonb;
  v_new jsonb;
begin
  v_rid := public.fn_tenant_status_guard(true);
  if not public.has_permission('roles.manage') then perform public.fn_err('permission_denied'); end if;
  perform public.fn_require_step_up();
  v := public.fn_role_normalize(p_patch);
  perform public.fn_role_for_edit(v_rid, p_role_id);

  select to_jsonb(ro) into v_old from public.roles ro where ro.id = p_role_id;
  begin
    update public.roles ro set
      name = case when v ? 'name' then v ->> 'name' else ro.name end,
      description = case when v ? 'description' then v ->> 'description' else ro.description end,
      color = case when v ? 'color' then v ->> 'color' else ro.color end,
      icon = case when v ? 'icon' then v ->> 'icon' else ro.icon end,
      sort_order = case when v ? 'sort_order' then (v ->> 'sort_order')::integer else ro.sort_order end
    where ro.id = p_role_id and ro.restaurant_id = v_rid;
  exception when unique_violation then
    perform public.fn_err('duplicate_name', v ->> 'name');
  end;
  select to_jsonb(ro) into v_new from public.roles ro where ro.id = p_role_id;
  if (v_new - 'updated_at' - 'normalized_name') is distinct from (v_old - 'updated_at' - 'normalized_name') then
    perform public.fn_write_audit('role.updated', jsonb_build_object('role_id', p_role_id, 'patch', v));
  end if;
  return public.fn_role_json(p_role_id);
end;
$$;

create or replace function public.fn_set_role_active(p_role_id uuid, p_active boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rid uuid;
  v_old boolean;
  v_users bigint;
begin
  v_rid := public.fn_tenant_status_guard(true);
  if not public.has_permission('roles.manage') then perform public.fn_err('permission_denied'); end if;
  perform public.fn_require_step_up();
  if p_active is null then perform public.fn_err('invalid_input', 'active'); end if;
  perform public.fn_role_for_edit(v_rid, p_role_id);
  select ro.is_active into v_old from public.roles ro where ro.id = p_role_id;
  if v_old = p_active then return public.fn_role_json(p_role_id) || jsonb_build_object('changed', false); end if;

  if not p_active then
    -- the dependency guard: never strip every right from people still working under this role
    select count(*) into v_users from public.profiles p where p.role_id = p_role_id and p.restaurant_id = v_rid and p.is_active;
    if v_users > 0 then perform public.fn_err('role_in_use', 'active_users:' || v_users); end if;
  end if;
  update public.roles set is_active = p_active where id = p_role_id and restaurant_id = v_rid;
  perform public.fn_write_audit(case when p_active then 'role.reactivated' else 'role.deactivated' end,
                                jsonb_build_object('role_id', p_role_id));
  return public.fn_role_json(p_role_id) || jsonb_build_object('changed', true);
end;
$$;

-- hard delete ONLY of a role no profile holds or ever held (audit trail); its matrix and station rows are configuration and go with it
create or replace function public.fn_delete_role(p_role_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rid uuid;
  v_name text;
  v_users bigint;
begin
  v_rid := public.fn_tenant_status_guard(true);
  if not public.has_permission('roles.manage') then perform public.fn_err('permission_denied'); end if;
  perform public.fn_require_step_up();
  perform public.fn_role_for_edit(v_rid, p_role_id);
  select count(*) into v_users from public.profiles p where p.role_id = p_role_id and p.restaurant_id = v_rid;
  if v_users > 0 then perform public.fn_err('role_in_use', 'users:' || v_users); end if;
  -- review 7: a role that ANY account ever held (a user / profile event in the tenant's trail mentions it: user.created,
  -- user.role_changed, the profiles row audit, ...) is history: refuse (deactivate it instead). Only the role's own
  -- configuration events (role.*, roles / role_permissions / role_station_access rows) do not count.
  if exists (select 1 from public.audit_logs a
             where a.restaurant_id = v_rid
               and a.event not like 'role.%'
               and coalesce(a.table_name, '') not in ('roles', 'role_permissions', 'role_station_access')
               and (strpos(coalesce(a.new_data::text, ''), p_role_id::text) > 0 or strpos(coalesce(a.old_data::text, ''), p_role_id::text) > 0)) then
    perform public.fn_err('role_in_use', 'history');
  end if;
  select ro.name into v_name from public.roles ro where ro.id = p_role_id;
  delete from public.role_permissions where role_id = p_role_id and restaurant_id = v_rid;
  delete from public.role_station_access where role_id = p_role_id and restaurant_id = v_rid;
  delete from public.roles where id = p_role_id and restaurant_id = v_rid;
  perform public.fn_write_audit('role.deleted', jsonb_build_object('role_id', p_role_id, 'name', v_name));
  return jsonb_build_object('role_id', p_role_id, 'deleted', true);
end;
$$;

-- station access only: keeps the role's permission keys and delegates to fn_update_role_permissions (same checks, same audit)
create or replace function public.fn_set_role_station_access(p_role_id uuid, p_station_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rid uuid;
  v_keys text[];
begin
  v_rid := public.fn_tenant_status_guard(true);
  if not public.has_permission('roles.manage') then perform public.fn_err('permission_denied'); end if;
  if p_role_id is null or p_station_ids is null then perform public.fn_err('invalid_input'); end if;
  if array_length(p_station_ids, 1) > 200 then perform public.fn_err('invalid_input', 'station_ids'); end if;
  perform public.fn_role_for_edit(v_rid, p_role_id);   -- coverage rule first: not_found / system_role_protected / own role / escalation
  select coalesce(array_agg(pm.key order by pm.key), '{}') into v_keys
  from public.role_permissions rp join public.permissions pm on pm.id = rp.permission_id
  where rp.role_id = p_role_id and rp.restaurant_id = v_rid;
  return public.fn_update_role_permissions(p_role_id, v_keys, p_station_ids);
end;
$$;

-- ════════════════════════════════════════ 3. users ════════════════════════════════════════
create or replace function public.fn_user_json(p_profile_id uuid, p_with_secrets boolean)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'id', p.id, 'first_name', p.first_name, 'middle_name', p.middle_name, 'last_name', p.last_name,
    'short_name', p.short_name, 'full_name', p.full_name, 'username', p.username, 'is_active', p.is_active,
    'auth_method', p.auth_method,
    'identity_rotation_pending', case when p_with_secrets then p.identity_rotation_pending end,
    'role', jsonb_build_object('id', ro.id, 'name', ro.name, 'color', ro.color, 'icon', ro.icon,
                               'system_key', ro.system_key, 'is_active', ro.is_active),
    -- only password accounts (tenant admins) have a real, displayable e-mail; staff identities are synthetic
    -- review 12: e-mail / MFA state / identity rotation only for users.manage callers (p_with_secrets); users.view sees names,
    -- role and status. Keys stay present (null) so the payload shape is stable.
    'email', case when p_with_secrets and p.auth_method = 'password' then (select u.email from auth.users u where u.id = p.id) end,
    'mfa_enrolled', case when p_with_secrets and p.auth_method = 'password'
                         then exists (select 1 from auth.mfa_factors f where f.user_id = p.id and f.status = 'verified') end,
    'pin', case when p_with_secrets and p.auth_method = 'pin' then
             (select jsonb_build_object('set', true, 'length', ps.pin_length, 'locked', coalesce(ps.locked_until > now(), false),
                                        'locked_until', ps.locked_until, 'failed_attempts', ps.failed_attempts,
                                        'must_change', ps.must_change_pin, 'pending_approval', ps.pin_change_pending,
                                        'changed_at', ps.pin_changed_at)
              from public.profile_secrets ps where ps.profile_id = p.id) end,
    'created_at', p.created_at, 'updated_at', p.updated_at)
  from public.profiles p join public.roles ro on ro.id = p.role_id and ro.restaurant_id = p.restaurant_id
  where p.id = p_profile_id
$$;
revoke all on function public.fn_user_json(uuid, boolean) from public, anon, authenticated;

create or replace function public.fn_list_users(p_include_inactive boolean default true)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_rid uuid := public.fn_tenant_status_guard(false);
  v_manage boolean;
begin
  v_manage := public.has_permission('users.manage');
  if not (v_manage or public.has_permission('users.view')) then perform public.fn_err('permission_denied'); end if;
  return (select coalesce(jsonb_agg(public.fn_user_json(p.id, v_manage) order by p.is_active desc, p.first_name, p.username), '[]'::jsonb)
          from public.profiles p
          where p.restaurant_id = v_rid and (coalesce(p_include_inactive, true) or p.is_active));
end;
$$;

-- the target profile of the caller's tenant, locked; a tenant_admin target needs a tenant_admin caller
create or replace function public.fn_user_for_edit(p_rid uuid, p_profile_id uuid)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_key text;
begin
  if p_profile_id is null then perform public.fn_err('invalid_input', 'profile_id'); end if;
  select ro.system_key into v_key
  from public.profiles p join public.roles ro on ro.id = p.role_id and ro.restaurant_id = p.restaurant_id
  where p.id = p_profile_id and p.restaurant_id = p_rid
  for update of p;
  if not found then perform public.fn_err('not_found'); end if;
  if v_key = 'tenant_admin' and not public.is_tenant_admin() then
    perform public.fn_err('permission_denied', 'tenant_admin accounts require tenant_admin');
  end if;
  return p_profile_id;
end;
$$;
revoke all on function public.fn_user_for_edit(uuid, uuid) from public, anon, authenticated;

create or replace function public.fn_update_user(p_profile_id uuid, p_patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rid uuid;
  v jsonb := '{}'::jsonb;
  v_old jsonb;
  v_new jsonb;
begin
  v_rid := public.fn_tenant_status_guard(true);
  if not public.has_permission('users.manage') then perform public.fn_err('permission_denied'); end if;
  perform public.fn_check_patch(p_patch, array['first_name', 'middle_name', 'last_name']);
  if p_patch ? 'first_name' then v := v || jsonb_build_object('first_name', public.fn_json_text(p_patch, 'first_name', 60, false)); end if;
  if p_patch ? 'middle_name' then v := v || jsonb_build_object('middle_name', public.fn_json_text(p_patch, 'middle_name', 60, true)); end if;
  if p_patch ? 'last_name' then v := v || jsonb_build_object('last_name', public.fn_json_text(p_patch, 'last_name', 60, true)); end if;
  perform public.fn_user_for_edit(v_rid, p_profile_id);

  select jsonb_build_object('first_name', p.first_name, 'middle_name', p.middle_name, 'last_name', p.last_name) into v_old
  from public.profiles p where p.id = p_profile_id;
  update public.profiles p set
    first_name = case when v ? 'first_name' then v ->> 'first_name' else p.first_name end,
    middle_name = case when v ? 'middle_name' then v ->> 'middle_name' else p.middle_name end,
    last_name = case when v ? 'last_name' then v ->> 'last_name' else p.last_name end
  where p.id = p_profile_id and p.restaurant_id = v_rid;      -- trg_guard_profile_update: permission_escalation for a stronger target
  select jsonb_build_object('first_name', p.first_name, 'middle_name', p.middle_name, 'last_name', p.last_name) into v_new
  from public.profiles p where p.id = p_profile_id;
  if v_new is distinct from v_old then
    perform public.fn_write_audit('user.updated', jsonb_build_object('profile_id', p_profile_id, 'old', v_old, 'new', v_new));
  end if;
  return public.fn_user_json(p_profile_id, true);
end;
$$;

create or replace function public.fn_set_user_active(p_profile_id uuid, p_active boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rid uuid;
  v_old boolean;
  v_role_active boolean;
begin
  v_rid := public.fn_tenant_status_guard(true);
  if not public.has_permission('users.manage') then perform public.fn_err('permission_denied'); end if;
  perform public.fn_require_step_up();
  if p_active is null then perform public.fn_err('invalid_input', 'active'); end if;
  perform public.fn_user_for_edit(v_rid, p_profile_id);
  if p_profile_id = (select auth.uid()) then perform public.fn_err('permission_denied', 'cannot change your own account state'); end if;

  select p.is_active, ro.is_active into v_old, v_role_active
  from public.profiles p join public.roles ro on ro.id = p.role_id and ro.restaurant_id = p.restaurant_id
  where p.id = p_profile_id;
  if v_old = p_active then
    return jsonb_build_object('profile_id', p_profile_id, 'is_active', p_active, 'changed', false);
  end if;
  if p_active then
    if not v_role_active then perform public.fn_err('invalid_role', 'role is inactive'); end if;
    perform public.fn_staff_quota_check(v_rid);   -- active profiles + live pending invitations, per-tenant lock
  end if;
  -- triggers: trg_guard_profile_update (permission_escalation), trg_guard_last_admin (last_tenant_admin, serialised)
  update public.profiles set is_active = p_active where id = p_profile_id and restaurant_id = v_rid;
  perform public.fn_write_audit(case when p_active then 'user.reactivated' else 'user.deactivated' end,
                                jsonb_build_object('profile_id', p_profile_id));
  return jsonb_build_object('profile_id', p_profile_id, 'is_active', p_active, 'changed', true);
end;
$$;

-- step 1 of the staff-pin-reset Edge Function (AS THE CALLER); step 2 is fn_set_user_pin with the service role
create or replace function public.fn_prepare_pin_reset(p_profile_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rid uuid;
  v_role uuid;
  v_name text;
  v_active boolean;
begin
  v_rid := public.fn_tenant_status_guard(true);
  if not public.has_permission('users.manage') then perform public.fn_err('permission_denied'); end if;
  perform public.fn_require_step_up();
  if p_profile_id is null then perform public.fn_err('invalid_input', 'profile_id'); end if;
  select p.role_id, ro.name, p.is_active into v_role, v_name, v_active
  from public.profiles p join public.roles ro on ro.id = p.role_id and ro.restaurant_id = p.restaurant_id
  where p.id = p_profile_id and p.restaurant_id = v_rid;
  if not found then perform public.fn_err('not_found'); end if;
  if p_profile_id = (select auth.uid()) then perform public.fn_err('permission_denied', 'use pin-change for your own PIN'); end if;
  if not public.fn_pin_eligible(p_profile_id) then perform public.fn_err('pin_not_allowed'); end if;
  if not v_active then perform public.fn_err('invalid_state', 'inactive'); end if;
  if not public.fn_caller_covers_role(v_role) then perform public.fn_err('permission_escalation'); end if;
  perform public.fn_write_audit('auth.pin_reset_requested', jsonb_build_object('profile_id', p_profile_id));
  return jsonb_build_object('profile_id', p_profile_id, 'role_name', v_name, 'pin_length', public.fn_pin_length_for_role(v_role));
end;
$$;

-- ── staff-create precheck (review H1 + H3): one quota rule, invitation usernames reserved ──
-- VOLATILE now (was stable): the quota helper takes a per-tenant advisory lock and the lazy expiry writes; a stable function would
-- count with the snapshot taken BEFORE the lock. fn_create_staff_profile (the insert) runs it in the same transaction as the insert,
-- so the lock covers check + insert.
create or replace function public.fn_staff_precheck(p_rid uuid, p_username text, p_role_id uuid)
returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_slug text;
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
  perform public.fn_expire_tenant_admin_invitations(p_rid, null);
  if exists (select 1 from public.profiles p where p.restaurant_id = p_rid and p.username = p_username)
     or exists (select 1 from public.tenant_admin_invitations i
                where i.restaurant_id = p_rid and i.username = p_username and i.status = 'pending') then
    perform public.fn_err('username_taken');
  end if;
  perform public.fn_staff_quota_check(p_rid);
  select r.slug into v_slug from public.restaurants r where r.id = p_rid;
  return v_slug;
end;
$$;
revoke all on function public.fn_staff_precheck(uuid, text, uuid) from public, anon, authenticated;

create or replace function public.fn_prepare_staff_creation(p_username text, p_role_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_rid uuid := public.fn_tenant_status_guard(true);
  v_user text := lower(btrim(coalesce(p_username, '')));
  v_slug text;
begin
  if not public.has_permission('users.manage') then perform public.fn_err('permission_denied'); end if;
  v_slug := public.fn_staff_precheck(v_rid, v_user, p_role_id);
  return jsonb_build_object('slug', v_slug, 'username', v_user,
    'role_name', (select r.name from public.roles r where r.id = p_role_id and r.restaurant_id = v_rid));
end;
$$;

-- ── admin PIN reset (review 11 + owner decision 5) ──────────────────────────
-- must_change_reason tells WHY a change is required: 'security' (single-session rule, 0023: the change then needs a tenant_admin's
-- approval, 0024) or 'admin_reset' (an admin set a temporary PIN: the person picks their own PIN, no approval needed, because the
-- admin already decided). Cleared automatically whenever the flag is cleared.
alter table public.profile_secrets
  add column must_change_reason text check (must_change_reason is null or must_change_reason in ('security', 'admin_reset'));
create or replace function public.fn_profile_secret_reason()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if not new.must_change_pin then new.must_change_reason := null;
  elsif new.must_change_reason is null then new.must_change_reason := 'security';
  end if;
  return new;
end;
$$;
revoke all on function public.fn_profile_secret_reason() from public, anon, authenticated;
create trigger trg_profile_secret_reason before insert or update on public.profile_secrets
  for each row execute function public.fn_profile_secret_reason();
update public.profile_secrets set must_change_reason = 'security' where must_change_pin;

-- step 2 of staff-pin-reset (SERVICE ROLE, after fn_prepare_pin_reset AS THE CALLER): set the temporary PIN (fn_set_user_pin:
-- bcrypt, lockout cleared), then FORCE a change at the next sign-in (must_change_pin, reason admin_reset; until then every permission
-- helper answers "nothing", 0023) and SIGN THE PERSON OUT: every GoTrue session row of the user is deleted (refresh tokens go
-- with it; the single-session rule then sees no active session). Access tokens already issued stay signed until they expire
-- (<= 1 h) but carry no permission while the change is pending. Returns {profile_id, sessions_revoked}; sessions_revoked is null
-- when this database role may not touch auth.sessions (then the Edge Function reports it; the permission lock still applies).
create or replace function public.fn_admin_reset_user_pin(p_profile_id uuid, p_pin_digest text, p_pin_length integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rid uuid;
  v_n integer;
begin
  if not public.is_service_role() then perform public.fn_err('permission_denied'); end if;
  perform public.fn_set_user_pin(p_profile_id, p_pin_digest, p_pin_length);
  select p.restaurant_id into v_rid from public.profiles p where p.id = p_profile_id;
  update public.profile_secrets
     set must_change_pin = true, must_change_reason = 'admin_reset', pin_change_pending = false, pin_change_requested_at = null
   where profile_id = p_profile_id;
  begin
    delete from auth.sessions s where s.user_id = p_profile_id;
    get diagnostics v_n = row_count;
  exception when insufficient_privilege then
    v_n := null;
  end;
  perform public.fn_write_audit('auth.pin_reset_by_admin', jsonb_build_object('profile_id', p_profile_id, 'sessions_revoked', v_n), v_rid);
  return jsonb_build_object('profile_id', p_profile_id, 'sessions_revoked', v_n, 'must_change_pin', true);
end;
$$;
revoke all on function public.fn_admin_reset_user_pin(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.fn_admin_reset_user_pin(uuid, text, integer) to service_role;

-- fn_complete_forced_pin_change (0024 body) + the admin_reset branch: the person replacing an admin-set temporary PIN is a
-- voluntary change (no approval round-trip); a 'security' flag keeps the maker-checker flow unchanged.
create or replace function public.fn_complete_forced_pin_change(p_profile_id uuid, p_pin_digest text, p_pin_length integer default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rid uuid;
  v_role uuid;
  v_name text;
  v_len integer;
  v_forced boolean;
  v_pending boolean;
  v_reason text;
  v_payload jsonb;
begin
  if not public.is_service_role() then perform public.fn_err('permission_denied'); end if;
  if p_pin_digest is null or p_pin_digest !~ '^[0-9a-f]{64}$' then perform public.fn_err('invalid_pin'); end if;
  select p.restaurant_id, p.role_id, p.short_name into v_rid, v_role, v_name from public.profiles p where p.id = p_profile_id;
  if not found then perform public.fn_err('not_found'); end if;
  if not public.fn_pin_eligible(p_profile_id) then perform public.fn_err('pin_not_allowed'); end if;

  v_len := public.fn_pin_length_for_role(v_role);
  if p_pin_length is not null and p_pin_length is distinct from v_len then
    perform public.fn_err('pin_length_mismatch');
  end if;

  select ps.must_change_pin, ps.pin_change_pending, ps.must_change_reason into v_forced, v_pending, v_reason
  from public.profile_secrets ps where ps.profile_id = p_profile_id for update;

  if not found or not (v_forced or v_pending) or (v_forced and v_reason = 'admin_reset') then
    perform public.fn_set_user_pin(p_profile_id, p_pin_digest, p_pin_length);
    if v_forced and v_reason = 'admin_reset' then
      perform public.fn_write_audit('auth.pin_changed_after_reset', jsonb_build_object('profile_id', p_profile_id), v_rid);
    end if;
    return jsonb_build_object('pending_approval', false);
  end if;

  update public.profile_secrets
     set pin_hash = extensions.crypt(p_pin_digest, extensions.gen_salt('bf', 10)), pin_length = v_len,
         failed_attempts = 0, locked_until = null, pin_changed_at = now(),
         must_change_pin = false, pin_change_pending = true,
         pin_change_requested_at = case when v_pending then pin_change_requested_at else now() end
   where profile_id = p_profile_id;

  if v_pending then
    perform public.fn_write_audit('auth.pin_set', jsonb_build_object('profile_id', p_profile_id, 'while_pending', true), v_rid);
    return jsonb_build_object('pending_approval', true);
  end if;

  v_payload := jsonb_build_object('profile_id', p_profile_id, 'user_name', v_name, 'at', now());
  insert into public.user_notifications (restaurant_id, recipient_id, kind, payload)
  select v_rid, a.id, 'security.pin_change_pending_approval', v_payload
  from public.profiles a
  join public.roles ro on ro.id = a.role_id and ro.restaurant_id = a.restaurant_id
  where a.restaurant_id = v_rid and a.is_active and ro.is_active and ro.system_key = 'tenant_admin'
    and not exists (
      select 1 from public.user_notifications n
      where n.restaurant_id = v_rid and n.recipient_id = a.id and n.kind = 'security.pin_change_pending_approval'
        and n.payload ->> 'profile_id' = p_profile_id::text and n.created_at > now() - interval '5 minutes');

  perform public.fn_write_audit('auth.pin_change_requested', jsonb_build_object('profile_id', p_profile_id), v_rid);
  return jsonb_build_object('pending_approval', true);
end;
$$;
revoke all on function public.fn_complete_forced_pin_change(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.fn_complete_forced_pin_change(uuid, text, integer) to service_role;

-- ════════════════════════════════════════ 4. restaurant profile, business settings, branding ════════════════════════════════════════
create or replace function public.fn_restaurant_profile_json(p_rid uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('id', r.id, 'name', r.name, 'slug', r.slug, 'status', r.status, 'phone', r.phone, 'address', r.address,
                            'timezone', r.timezone, 'tin', r.tin, 'vat_rate', r.vat_rate, 'opening_float', r.opening_float,
                            'auto_consume_stock', r.auto_consume_stock, 'stock_stepup_threshold', r.stock_stepup_threshold,
                            'branding', r.branding, 'updated_at', r.updated_at)
  from public.restaurants r where r.id = p_rid
$$;
revoke all on function public.fn_restaurant_profile_json(uuid) from public, anon, authenticated;

create or replace function public.fn_get_restaurant_profile()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_rid uuid := public.fn_tenant_status_guard(false);
begin
  if not public.has_permission('settings.manage') then perform public.fn_err('permission_denied'); end if;
  return public.fn_restaurant_profile_json(v_rid);
end;
$$;

create or replace function public.fn_update_restaurant_profile(p_patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rid uuid;
  v jsonb := '{}'::jsonb;
  t text;
  v_old jsonb;
  v_new jsonb;
begin
  v_rid := public.fn_tenant_status_guard(true);
  if not public.has_permission('settings.manage') then perform public.fn_err('permission_denied'); end if;
  perform public.fn_require_step_up();
  perform public.fn_check_patch(p_patch, array['name', 'phone', 'address', 'timezone']);
  if p_patch ? 'name' then v := v || jsonb_build_object('name', public.fn_json_text(p_patch, 'name', 120, false)); end if;
  if p_patch ? 'phone' then
    t := public.fn_json_text(p_patch, 'phone', 40, true);
    if t is not null and t !~ '^\+?[0-9][0-9 ()-]{2,38}$' then perform public.fn_err('invalid_input', 'phone'); end if;
    v := v || jsonb_build_object('phone', t);
  end if;
  if p_patch ? 'address' then v := v || jsonb_build_object('address', public.fn_json_text(p_patch, 'address', 300, true)); end if;
  if p_patch ? 'timezone' then
    t := public.fn_json_text(p_patch, 'timezone', 64, false);
    if not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = t) then perform public.fn_err('invalid_timezone'); end if;
    v := v || jsonb_build_object('timezone', t);
  end if;

  select jsonb_build_object('name', r.name, 'phone', r.phone, 'address', r.address, 'timezone', r.timezone) into v_old
  from public.restaurants r where r.id = v_rid for update;
  update public.restaurants r set
    name = case when v ? 'name' then v ->> 'name' else r.name end,
    phone = case when v ? 'phone' then v ->> 'phone' else r.phone end,
    address = case when v ? 'address' then v ->> 'address' else r.address end,
    timezone = case when v ? 'timezone' then v ->> 'timezone' else r.timezone end
  where r.id = v_rid;
  select jsonb_build_object('name', r.name, 'phone', r.phone, 'address', r.address, 'timezone', r.timezone) into v_new
  from public.restaurants r where r.id = v_rid;
  if v_new is distinct from v_old then
    perform public.fn_write_audit('settings.restaurant_profile_updated', jsonb_build_object('old', v_old, 'new', v_new));
  end if;
  return public.fn_restaurant_profile_json(v_rid);
end;
$$;

-- money-relevant settings: aal2 (a live authenticator), like the session timers and the stock step-up threshold
create or replace function public.fn_update_business_settings(p_patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rid uuid;
  v jsonb := '{}'::jsonb;
  t text;
  n numeric;
  v_old jsonb;
  v_new jsonb;
begin
  v_rid := public.fn_tenant_status_guard(true);
  if not public.has_permission('settings.manage') then perform public.fn_err('permission_denied'); end if;
  perform public.fn_require_aal2();
  perform public.fn_check_patch(p_patch, array['tin', 'vat_rate', 'opening_float', 'auto_consume_stock']);
  if p_patch ? 'tin' then
    t := public.fn_json_text(p_patch, 'tin', 40, true);
    if t is not null and t !~ '^[A-Za-z0-9/-]{1,40}$' then perform public.fn_err('invalid_input', 'tin'); end if;
    v := v || jsonb_build_object('tin', t);
  end if;
  if p_patch ? 'vat_rate' then
    n := public.fn_json_money(p_patch, 'vat_rate', 100);
    v := v || jsonb_build_object('vat_rate', n);
  end if;
  if p_patch ? 'opening_float' then v := v || jsonb_build_object('opening_float', public.fn_json_money(p_patch, 'opening_float', 1000000000)); end if;
  if p_patch ? 'auto_consume_stock' then
    if jsonb_typeof(p_patch -> 'auto_consume_stock') <> 'boolean' then perform public.fn_err('invalid_input', 'auto_consume_stock'); end if;
    v := v || jsonb_build_object('auto_consume_stock', p_patch -> 'auto_consume_stock');
  end if;

  select jsonb_build_object('tin', r.tin, 'vat_rate', r.vat_rate, 'opening_float', r.opening_float, 'auto_consume_stock', r.auto_consume_stock)
    into v_old from public.restaurants r where r.id = v_rid for update;
  update public.restaurants r set
    tin = case when v ? 'tin' then v ->> 'tin' else r.tin end,
    vat_rate = case when v ? 'vat_rate' then (v ->> 'vat_rate')::numeric else r.vat_rate end,
    opening_float = case when v ? 'opening_float' then (v ->> 'opening_float')::numeric else r.opening_float end,
    auto_consume_stock = case when v ? 'auto_consume_stock' then (v ->> 'auto_consume_stock')::boolean else r.auto_consume_stock end
  where r.id = v_rid;
  select jsonb_build_object('tin', r.tin, 'vat_rate', r.vat_rate, 'opening_float', r.opening_float, 'auto_consume_stock', r.auto_consume_stock)
    into v_new from public.restaurants r where r.id = v_rid;
  if v_new is distinct from v_old then
    perform public.fn_write_audit('settings.business_updated', jsonb_build_object('old', v_old, 'new', v_new));
  end if;
  return public.fn_restaurant_profile_json(v_rid);
end;
$$;

create or replace function public.fn_update_restaurant_branding(p_primary_color text, p_accent_color text, p_logo_path text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rid uuid;
  v_primary text := lower(btrim(coalesce(p_primary_color, '')));
  v_accent text := lower(btrim(coalesce(p_accent_color, '')));
  v_logo text := nullif(btrim(coalesce(p_logo_path, '')), '');
  v_old jsonb;
  v_new jsonb;
begin
  v_rid := public.fn_tenant_status_guard(true);
  if not public.has_permission('settings.manage') then perform public.fn_err('permission_denied'); end if;
  perform public.fn_require_step_up();
  if v_primary !~ '^#[0-9a-f]{6}$' then perform public.fn_err('invalid_input', 'primary_color'); end if;
  if v_accent !~ '^#[0-9a-f]{6}$' then perform public.fn_err('invalid_input', 'accent_color'); end if;
  if v_logo is not null then
    -- case-sensitive like the Storage policies (only the extension may vary in case); the object must really be uploaded
    if v_logo !~ ('^restaurants/' || v_rid::text || '/branding/[A-Za-z0-9._-]{1,115}\.([pP][nN][gG]|[jJ][pP][eE]?[gG]|[wW][eE][bB][pP])$')
       or v_logo ~ '\.\.'
       or not exists (select 1 from storage.objects o where o.bucket_id = 'tenant-branding' and o.name = v_logo) then
      perform public.fn_err('invalid_input', 'logo_path');
    end if;
  end if;
  v_new := jsonb_build_object('primary_color', v_primary, 'accent_color', v_accent, 'logo_path', v_logo);
  select r.branding into v_old from public.restaurants r where r.id = v_rid for update;
  if v_old is distinct from v_new then
    update public.restaurants set branding = v_new where id = v_rid;
    perform public.fn_write_audit('settings.branding_updated', jsonb_build_object('old', v_old, 'new', v_new));
  end if;
  return public.fn_restaurant_profile_json(v_rid);
end;
$$;

create or replace function public.fn_get_subscription_usage()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_rid uuid := public.fn_tenant_status_guard(false);
begin
  if not public.has_permission('settings.manage') then perform public.fn_err('permission_denied'); end if;
  return public.fn_tenant_usage(v_rid) || jsonb_build_object('subscription',
    (select jsonb_build_object('status', s.status, 'trial_ends_at', s.trial_ends_at, 'current_period_start', s.current_period_start,
                               'current_period_end', s.current_period_end,
                               'plan', jsonb_build_object('id', pl.id, 'name', pl.name, 'description', pl.description,
                                                          'price_etb_monthly', pl.price_etb_monthly, 'features', pl.features))
     from public.subscriptions s join public.plans pl on pl.id = s.plan_id where s.restaurant_id = v_rid));
end;
$$;

-- ════════════════════════════════════════ grants ════════════════════════════════════════
revoke all on function
  public.fn_list_roles(), public.fn_create_role(jsonb), public.fn_update_role(uuid, jsonb), public.fn_set_role_active(uuid, boolean),
  public.fn_delete_role(uuid), public.fn_set_role_station_access(uuid, uuid[]),
  public.fn_list_users(boolean), public.fn_update_user(uuid, jsonb), public.fn_set_user_active(uuid, boolean), public.fn_prepare_pin_reset(uuid),
  public.fn_get_restaurant_profile(), public.fn_update_restaurant_profile(jsonb), public.fn_update_business_settings(jsonb),
  public.fn_update_restaurant_branding(text, text, text), public.fn_get_subscription_usage()
from public, anon, authenticated, service_role;
grant execute on function
  public.fn_list_roles(), public.fn_create_role(jsonb), public.fn_update_role(uuid, jsonb), public.fn_set_role_active(uuid, boolean),
  public.fn_delete_role(uuid), public.fn_set_role_station_access(uuid, uuid[]),
  public.fn_list_users(boolean), public.fn_update_user(uuid, jsonb), public.fn_set_user_active(uuid, boolean), public.fn_prepare_pin_reset(uuid),
  public.fn_get_restaurant_profile(), public.fn_update_restaurant_profile(jsonb), public.fn_update_business_settings(jsonb),
  public.fn_update_restaurant_branding(text, text, text), public.fn_get_subscription_usage()
to authenticated;
