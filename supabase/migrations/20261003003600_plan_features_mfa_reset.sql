-- 0036  Plan features in the session context + Tenant Admins on the platform tenant detail + Super Admin MFA reset
--
--  Owner decisions (2026-10-11):
--   (1) A Super Admin may reset a Tenant Admin's lost authenticator, with an audit record.
--   (2) Plan entitlement, "best experience": the UI must know up front what the tenant's plan includes.
--
--  A. fn_get_session_context (0025 body unchanged) + top-level 'plan_features' = the tenant's subscription plan features ({} when
--     the tenant has no subscription). Tenant users only: a platform admin's context carries no such key. Entitlement stays enforced
--     by the RPCs (e.g. fn_generate_voucher reads plans.features.installments); this key is UX only.
--     fn_plan_normalize: a submitted 'features' object without 'installments' is stored with "installments": false (absent already
--     meant "not entitled"; storing it makes the plan editor show the real value), and 'installments' must be a boolean (a string
--     would make the entitlement cast fail at issue time). fn_platform_create_plan stores {"installments": false} when no features
--     are submitted. Existing plans without the key are backfilled with false (same semantics).
--  B. fn_platform_get_tenant (0030 body unchanged) + 'tenant_admins': the profiles of that tenant holding the system tenant_admin
--     role: identity, e-mail (auth.users), is_active, mfa_enrolled (a verified factor exists), trusted_devices (live count). Identity
--     and authenticator state only; no operational data.
--  C. Two-step MFA reset (pattern: staff-pin-reset):
--     fn_platform_prepare_mfa_reset(restaurant, profile, reason)   AS THE CALLER (Super Admin, fn_platform_guard + a real TOTP at most
--        12 h old): target = an ACTIVE tenant_admin profile of that restaurant (anything else, including another tenant's admin, is
--        not_found, same as unknown); refuses invalid_state|no_factor without a verified factor. Audited
--        (admin_audit_log 'tenant_admin.mfa_reset_requested'). Returns the factor ids the Edge Function deletes through GoTrue.
--     fn_platform_complete_mfa_reset(profile, actor, reason)        SERVICE ROLE ONLY: after the factors are gone (refuses
--        invalid_state|factors_remain otherwise) revokes the user's live trusted devices (reason 'mfa_reset'), drops their session
--        attestations and deletes their auth sessions (sign-out everywhere). Audited twice: admin_audit_log 'tenant_admin.mfa_reset'
--        (actor = p_actor, an active Super Admin) and the tenant's audit_logs 'auth.mfa_reset_by_platform' (actor = p_actor,
--        actor_type platform_admin; written directly because fn_write_audit derives the actor from auth.uid(), null here).
--     The Tenant Admin then signs in with the password and must enrol a new authenticator (every tenant-admin gate needs one).

-- ════════════════════════════════════════ C0. revoke reason ════════════════════════════════════════
alter table public.trusted_devices drop constraint trusted_devices_revoke_reason_check;
alter table public.trusted_devices add constraint trusted_devices_revoke_reason_check
  check (revoke_reason in ('user', 'admin', 'limit', 'user_disabled', 'pin_reset', 'admin_disabled', 'mfa_reset'));

-- ════════════════════════════════════════ A. session context ════════════════════════════════════════
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
    'session_timers', public.fn_session_timers_json(r.id),
    -- 0036: the tenant's plan entitlements (UX only: the RPCs enforce them); {} without a subscription
    'plan_features', coalesce((select pl.features from public.subscriptions s join public.plans pl on pl.id = s.plan_id
                               where s.restaurant_id = r.id), '{}'::jsonb)
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

-- ════════════════════════════════════════ A. plan features: explicit installments ════════════════════════════════════════
-- 0030 body + (1) 'installments', when present, must be a boolean; (2) a features object without it gets "installments": false
create or replace function public.fn_plan_normalize(p_patch jsonb)
returns jsonb
language plpgsql immutable set search_path = ''
as $$
declare
  v jsonb := '{}'::jsonb;
  f jsonb;
  k text;
begin
  perform public.fn_check_patch(p_patch, array['name', 'description', 'price_etb_monthly', 'max_staff', 'max_menu_items',
                                               'max_stations', 'max_kiosks', 'max_storage_bytes', 'max_orders_per_month',
                                               'features', 'sort_order']);
  if p_patch ? 'name' then v := v || jsonb_build_object('name', public.fn_json_text(p_patch, 'name', 60, false)); end if;
  if p_patch ? 'description' then v := v || jsonb_build_object('description', public.fn_json_text(p_patch, 'description', 300, true)); end if;
  if p_patch ? 'price_etb_monthly' then
    v := v || jsonb_build_object('price_etb_monthly', public.fn_json_money(p_patch, 'price_etb_monthly', 10000000));
  end if;
  foreach k in array array['max_staff', 'max_menu_items', 'max_stations', 'max_kiosks', 'max_orders_per_month'] loop
    if p_patch ? k then v := v || jsonb_build_object(k, public.fn_json_pos_int(p_patch, k, 2147483647)); end if;
  end loop;
  if p_patch ? 'max_storage_bytes' then
    v := v || jsonb_build_object('max_storage_bytes', public.fn_json_pos_int(p_patch, 'max_storage_bytes', 1099511627776));  -- 1 TiB
  end if;
  if p_patch ? 'sort_order' then
    if jsonb_typeof(p_patch -> 'sort_order') <> 'number' or (p_patch ->> 'sort_order')::numeric <> trunc((p_patch ->> 'sort_order')::numeric)
       or abs((p_patch ->> 'sort_order')::numeric) > 100000 then
      perform public.fn_err('invalid_input', 'sort_order');
    end if;
    v := v || jsonb_build_object('sort_order', (p_patch ->> 'sort_order')::integer);
  end if;
  if p_patch ? 'features' then
    f := p_patch -> 'features';
    if jsonb_typeof(f) <> 'object'
       or (select count(*) from jsonb_object_keys(f)) > 50
       or exists (select 1 from jsonb_each(f) e
                  where e.key !~ '^[a-z][a-z0-9_]{0,39}$'
                     or jsonb_typeof(e.value) not in ('boolean', 'number', 'string')
                     or (jsonb_typeof(e.value) = 'string' and char_length(e.value #>> '{}') > 100))
       or (f ? 'installments' and jsonb_typeof(f -> 'installments') <> 'boolean') then
      perform public.fn_err('invalid_input', 'features');
    end if;
    if not (f ? 'installments') then f := f || '{"installments": false}'::jsonb; end if;
    v := v || jsonb_build_object('features', f);
  end if;
  return v;
end;
$$;
revoke all on function public.fn_plan_normalize(jsonb) from public, anon, authenticated;

-- 0030 body; only the features default changed ('{}' -> {"installments": false})
create or replace function public.fn_platform_create_plan(p_plan jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v jsonb;
  v_id uuid;
begin
  perform public.fn_platform_guard();
  v := public.fn_plan_normalize(p_plan);
  if not (v ? 'name') or v ->> 'name' is null then perform public.fn_err('invalid_input', 'name'); end if;
  if not (v ? 'price_etb_monthly') then perform public.fn_err('invalid_input', 'price_etb_monthly'); end if;
  begin
    insert into public.plans (name, description, price_etb_monthly, max_staff, max_menu_items, max_stations, max_kiosks,
                              max_storage_bytes, max_orders_per_month, features, sort_order)
    values (v ->> 'name', v ->> 'description', (v ->> 'price_etb_monthly')::numeric, (v ->> 'max_staff')::integer,
            (v ->> 'max_menu_items')::integer, (v ->> 'max_stations')::integer, (v ->> 'max_kiosks')::integer,
            (v ->> 'max_storage_bytes')::bigint, (v ->> 'max_orders_per_month')::integer,
            coalesce(v -> 'features', '{"installments": false}'::jsonb), coalesce((v ->> 'sort_order')::integer, 0))
    returning id into v_id;
  exception when unique_violation then
    perform public.fn_err('duplicate_name', v ->> 'name');
  end;
  perform public.fn_write_admin_audit('plan.created', null, jsonb_build_object('plan_id', v_id, 'values', v));
  return public.fn_plan_json(v_id);
end;
$$;
-- (fn_platform_update_plan is unchanged: it stores the normalised features, which now always carry 'installments')

-- backfill: absent already meant "not entitled"; make it explicit (the plans row-audit trigger records the change)
update public.plans set features = features || '{"installments": false}'::jsonb where not (features ? 'installments');

-- ════════════════════════════════════════ B. platform tenant detail + tenant_admins ════════════════════════════════════════
create or replace function public.fn_platform_get_tenant(p_restaurant_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v jsonb;
begin
  perform public.fn_platform_guard();
  if p_restaurant_id is null then perform public.fn_err('invalid_input', 'restaurant_id'); end if;
  v := public.fn_platform_tenant_json(p_restaurant_id);
  if v is null then perform public.fn_err('not_found'); end if;
  perform public.fn_write_admin_audit('tenant.viewed', p_restaurant_id, '{}'::jsonb);
  return v || public.fn_tenant_usage(p_restaurant_id) || jsonb_build_object(
    'invitations', (select coalesce(jsonb_agg(jsonb_build_object(
                       'id', i.id, 'email', i.email, 'status', i.status,
                       'state', public.fn_invitation_state(i.status, i.expires_at, i.send_count, i.created_at),
                       'invited_by_type', i.invited_by_type, 'expires_at', i.expires_at, 'send_count', i.send_count,
                       'last_sent_at', i.last_sent_at, 'accepted_at', i.accepted_at, 'revoked_at', i.revoked_at,
                       'created_at', i.created_at) order by i.created_at desc), '[]'::jsonb)
                    from (select * from public.tenant_admin_invitations x where x.restaurant_id = p_restaurant_id
                          order by x.created_at desc limit 20) i),
    'recent_invoices', (select coalesce(jsonb_agg(jsonb_build_object(
                           'id', iv.id, 'amount', iv.amount, 'period_start', iv.period_start, 'period_end', iv.period_end,
                           'status', iv.status, 'paid_at', iv.paid_at, 'created_at', iv.created_at) order by iv.created_at desc), '[]'::jsonb)
                        from (select * from public.platform_invoices x where x.restaurant_id = p_restaurant_id
                              order by x.created_at desc limit 5) iv),
    -- 0036: the tenant's administrators (identity + authenticator state only), for the MFA reset
    'tenant_admins', (select coalesce(jsonb_agg(jsonb_build_object(
                         'profile_id', p.id, 'first_name', p.first_name, 'middle_name', p.middle_name, 'last_name', p.last_name,
                         'email', u.email, 'is_active', p.is_active,
                         'mfa_enrolled', exists (select 1 from auth.mfa_factors f where f.user_id = p.id and f.status = 'verified'),
                         'trusted_devices', (select count(*) from public.trusted_devices d
                                             where d.user_id = p.id and public.fn_device_live(d)))
                         order by p.created_at, p.id), '[]'::jsonb)
                      from public.profiles p
                      join public.roles ro on ro.id = p.role_id and ro.restaurant_id = p.restaurant_id
                      left join auth.users u on u.id = p.id
                      where p.restaurant_id = p_restaurant_id and ro.system_key = 'tenant_admin'));
end;
$$;

-- ════════════════════════════════════════ C. MFA reset ════════════════════════════════════════
-- step 1 (AS THE CALLER, through the tenant-admin-mfa-reset Edge Function)
create or replace function public.fn_platform_prepare_mfa_reset(p_restaurant_id uuid, p_profile_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := public.fn_platform_guard();
  v_reason text;
  v_factors jsonb;
begin
  perform public.fn_require_recent_totp();
  if p_restaurant_id is null then perform public.fn_err('invalid_input', 'restaurant_id'); end if;
  if p_profile_id is null then perform public.fn_err('invalid_input', 'profile_id'); end if;
  v_reason := public.fn_platform_reason(p_reason);
  if p_profile_id = v_uid then perform public.fn_err('permission_denied'); end if;
  -- an ACTIVE tenant_admin of THAT restaurant; anything else (unknown, other tenant, staff, inactive) answers the same not_found
  perform 1 from public.profiles p join public.roles ro on ro.id = p.role_id and ro.restaurant_id = p.restaurant_id
   where p.id = p_profile_id and p.restaurant_id = p_restaurant_id and p.is_active and ro.system_key = 'tenant_admin';
  if not found then perform public.fn_err('not_found'); end if;
  if not exists (select 1 from auth.mfa_factors f where f.user_id = p_profile_id and f.status = 'verified') then
    perform public.fn_err('invalid_state', 'no_factor');
  end if;
  select coalesce(jsonb_agg(f.id order by f.created_at, f.id), '[]'::jsonb) into v_factors
  from auth.mfa_factors f where f.user_id = p_profile_id;
  perform public.fn_write_admin_audit('tenant_admin.mfa_reset_requested', p_restaurant_id,
                                      jsonb_build_object('profile_id', p_profile_id, 'reason', v_reason));
  return jsonb_build_object('profile_id', p_profile_id, 'user_id', p_profile_id, 'factor_ids', v_factors);
end;
$$;

-- step 3 (SERVICE ROLE, after GoTrue deleted the factors): devices, attestations, sessions, audit
create or replace function public.fn_platform_complete_mfa_reset(p_profile_id uuid, p_actor uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text;
  v_rid uuid;
  v_devices integer;
  v_sessions integer;
begin
  if not public.is_service_role() then perform public.fn_err('permission_denied'); end if;
  if p_profile_id is null then perform public.fn_err('invalid_input', 'profile_id'); end if;
  if p_actor is null or not exists (select 1 from public.platform_admins a
                                    where a.id = p_actor and a.is_active and a.role = 'platform_super_admin') then
    perform public.fn_err('permission_denied');
  end if;
  v_reason := public.fn_platform_reason(p_reason);
  select p.restaurant_id into v_rid
  from public.profiles p join public.roles ro on ro.id = p.role_id and ro.restaurant_id = p.restaurant_id
  where p.id = p_profile_id and p.is_active and ro.system_key = 'tenant_admin'
  for update of p;
  if v_rid is null then perform public.fn_err('not_found'); end if;
  if exists (select 1 from auth.mfa_factors f where f.user_id = p_profile_id and f.status = 'verified') then
    perform public.fn_err('invalid_state', 'factors_remain');
  end if;

  with r as (
    update public.trusted_devices set revoked_at = now(), revoked_by = p_actor, revoke_reason = 'mfa_reset'
     where user_id = p_profile_id and revoked_at is null
    returning id
  ) select count(*) into v_devices from r;
  delete from public.session_device_attestations where user_id = p_profile_id;
  begin
    delete from auth.sessions s where s.user_id = p_profile_id;
    get diagnostics v_sessions = row_count;
  exception when insufficient_privilege then
    v_sessions := null;
  end;

  insert into public.admin_audit_log (platform_admin_id, restaurant_id, action, detail)
  values (p_actor, v_rid, 'tenant_admin.mfa_reset',
          jsonb_build_object('profile_id', p_profile_id, 'reason', v_reason,
                             'sessions_revoked', v_sessions, 'devices_revoked', v_devices));
  insert into public.audit_logs (restaurant_id, actor_id, actor_type, event, action, new_data)
  values (v_rid, p_actor, 'platform_admin', 'auth.mfa_reset_by_platform', 'event',
          jsonb_build_object('profile_id', p_profile_id, 'sessions_revoked', v_sessions, 'devices_revoked', v_devices));
  return jsonb_build_object('profile_id', p_profile_id, 'sessions_revoked', v_sessions, 'devices_revoked', v_devices);
end;
$$;

revoke all on function public.fn_platform_prepare_mfa_reset(uuid, uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.fn_platform_prepare_mfa_reset(uuid, uuid, text) to authenticated;
revoke all on function public.fn_platform_complete_mfa_reset(uuid, uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.fn_platform_complete_mfa_reset(uuid, uuid, text) to service_role;
