-- 0004  Tenant-identity helpers, status guard and audit writers
--
-- Design (binding):
--  * Tenant, role and permissions are derived from `profiles` via auth.uid() — NEVER from
--    client-controllable JWT claims (app_metadata/user_metadata/custom claims are ignored).
--  * All helpers are STABLE SECURITY DEFINER with search_path = '' so they read profiles/roles
--    without triggering RLS (no policy recursion) and cannot be hijacked via search_path.
--  * Only ACTIVE profiles of tenants whose status is not suspended/cancelled resolve.
--    Writes additionally require status in (trialing, active) — past_due is read-only.

-- ── identity ────────────────────────────────────────────────────────────────
create or replace function public.current_user_id()
returns uuid
language sql stable security definer set search_path = ''
as $$
  select p.id
  from public.profiles p
  join public.restaurants r on r.id = p.restaurant_id
  where p.id = (select auth.uid())
    and p.is_active
    and r.status not in ('suspended', 'cancelled')
$$;

create or replace function public.current_restaurant_id()
returns uuid
language sql stable security definer set search_path = ''
as $$
  select p.restaurant_id
  from public.profiles p
  join public.restaurants r on r.id = p.restaurant_id
  where p.id = (select auth.uid())
    and p.is_active
    and r.status not in ('suspended', 'cancelled')
$$;

create or replace function public.current_role_id()
returns uuid
language sql stable security definer set search_path = ''
as $$
  select p.role_id
  from public.profiles p
  join public.restaurants r on r.id = p.restaurant_id
  where p.id = (select auth.uid())
    and p.is_active
    and r.status not in ('suspended', 'cancelled')
$$;

-- true when the caller's tenant accepts writes (trialing/active). past_due = read-only.
create or replace function public.current_tenant_writable()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce((
    select p.is_active and r.status in ('trialing', 'active')
    from public.profiles p
    join public.restaurants r on r.id = p.restaurant_id
    where p.id = (select auth.uid())
  ), false)
$$;

-- ── platform ────────────────────────────────────────────────────────────────
-- platform_super_admin is NOT a tenant role: it lives only in platform_admins.
create or replace function public.is_platform_admin()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.platform_admins a
    where a.id = (select auth.uid()) and a.is_active
  )
$$;

create or replace function public.is_platform_super_admin()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.platform_admins a
    where a.id = (select auth.uid()) and a.is_active and a.role = 'platform_super_admin'
  )
$$;

create or replace function public.is_service_role()
returns boolean
language sql stable set search_path = ''
as $$
  select coalesce((select auth.role()), '') = 'service_role'
$$;

-- ── authorization ───────────────────────────────────────────────────────────
-- tenant_admin (system_key) holds every catalog permission; everyone else is matrix-driven.
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

-- Structured replacement for the prototype's `station:<uuid>` permission.
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

-- ── tenant status guard for mutating RPCs ───────────────────────────────────
-- Returns the caller's restaurant_id. Raises:
--   not_authenticated  no JWT subject
--   permission_denied  no active profile (indistinguishable from "wrong tenant")
--   tenant_suspended   tenant suspended/cancelled (no access at all)
--   tenant_read_only   tenant past_due and a write was requested
create or replace function public.fn_tenant_status_guard(p_write boolean default true)
returns uuid
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_active boolean;
  v_rid uuid;
  v_status text;
begin
  if v_uid is null then
    perform public.fn_err('not_authenticated');
  end if;
  select p.is_active, p.restaurant_id, r.status
    into v_active, v_rid, v_status
  from public.profiles p
  join public.restaurants r on r.id = p.restaurant_id
  where p.id = v_uid;
  if not found or not v_active then
    perform public.fn_err('permission_denied');
  end if;
  if v_status in ('suspended', 'cancelled') then
    perform public.fn_err('tenant_suspended');
  end if;
  if p_write and v_status = 'past_due' then
    perform public.fn_err('tenant_read_only');
  end if;
  return v_rid;
end;
$$;

-- ── audit writers ───────────────────────────────────────────────────────────
-- fn_write_audit: event row. Actor is ALWAYS auth.uid() (or null for service jobs).
-- Not executable by clients (migration 0009); only definer RPCs call it, so the explicit
-- restaurant/actor overrides below can never be supplied by a client.
create or replace function public.fn_write_audit(
  p_event text,
  p_record jsonb default null,
  p_restaurant_id uuid default null,
  p_actor_id uuid default null
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := coalesce((select auth.uid()), p_actor_id);
  v_rid uuid := coalesce(p_restaurant_id, (select public.current_restaurant_id()));
  v_type text;
begin
  if v_rid is null then
    perform public.fn_err('audit_tenant_unresolved');
  end if;
  v_type := case
    when v_uid is null then 'system'
    when exists (select 1 from public.profiles pr where pr.id = v_uid) then 'user'
    when exists (select 1 from public.platform_admins pa where pa.id = v_uid) then 'platform_admin'
    else 'user'
  end;
  insert into public.audit_logs (restaurant_id, actor_id, actor_type, event, action, new_data)
  values (v_rid, v_uid, v_type, p_event, 'event', p_record);
end;
$$;

-- Platform-level audit (internal).
create or replace function public.fn_write_admin_audit(p_action text, p_restaurant_id uuid, p_detail jsonb default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_admin uuid := (select auth.uid());
begin
  if v_admin is not null and not exists (select 1 from public.platform_admins a where a.id = v_admin) then
    v_admin := null;
  end if;
  insert into public.admin_audit_log (platform_admin_id, restaurant_id, action, detail)
  values (v_admin, p_restaurant_id, p_action, p_detail);
end;
$$;

-- Generic row-level audit trigger. Usage: execute function fn_audit_row('pk_col1,pk_col2') (default 'id').
-- Secrets (hashes) are stripped; UPDATE rows only carry the changed columns.
create or replace function public.fn_audit_row()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_secret text[] := array['pin_hash', 'token_hash', 'session_token_hash', 'public_token_hash'];
  v_old jsonb;
  v_new jsonb;
  v_row jsonb;
  v_keys text[];
  v_pk text[] := string_to_array(coalesce(nullif(tg_argv[0], ''), 'id'), ',');
  v_rid uuid;
  v_record text;
  v_uid uuid := (select auth.uid());
  v_type text;
begin
  if tg_op = 'DELETE' then
    v_row := to_jsonb(old) - v_secret;
    v_old := v_row;
  elsif tg_op = 'INSERT' then
    v_row := to_jsonb(new) - v_secret;
    v_new := v_row;
  else
    v_old := to_jsonb(old) - v_secret - 'updated_at';
    v_new := to_jsonb(new) - v_secret - 'updated_at';
    v_row := v_new;
    select array_agg(k.key) into v_keys
    from jsonb_each(v_new) k
    where v_old -> k.key is distinct from k.value;
    if v_keys is null then
      return null; -- nothing but updated_at changed
    end if;
    select coalesce(jsonb_object_agg(k.key, k.value), '{}'::jsonb) into v_new
    from jsonb_each(v_new) k where k.key = any (v_keys);
    select coalesce(jsonb_object_agg(k.key, k.value), '{}'::jsonb) into v_old
    from jsonb_each(v_old) k where k.key = any (v_keys);
  end if;

  v_rid := case when tg_table_name = 'restaurants' then (v_row ->> 'id')::uuid
                else (v_row ->> 'restaurant_id')::uuid end;
  select string_agg(coalesce(v_row ->> c, ''), ':') into v_record from unnest(v_pk) c;

  v_type := case
    when v_uid is null then 'system'
    when exists (select 1 from public.profiles pr where pr.id = v_uid) then 'user'
    when exists (select 1 from public.platform_admins pa where pa.id = v_uid) then 'platform_admin'
    else 'user'
  end;

  insert into public.audit_logs (restaurant_id, actor_id, actor_type, event, action, table_name, record_id, old_data, new_data)
  values (v_rid, v_uid, v_type, tg_table_name || '.' || lower(tg_op), lower(tg_op), tg_table_name, v_record, v_old, v_new);
  return null;
end;
$$;
