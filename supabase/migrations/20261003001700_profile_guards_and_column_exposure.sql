-- 0017  SL3 non-escalation on user lifecycle, SL5 narrower exposure of financial/billing columns.
--
--  SL3. profiles.is_active (and role_id) of ANOTHER user can only be changed by a caller who holds every permission
--       and station of that user's current role (tenant_admin always does): users.manage no longer lets a limited
--       manager deactivate or demote someone with stronger rights. Enforced in a trigger so it covers direct UPDATEs
--       and fn_change_user_role alike. Service/owner contexts (no auth.uid()) are not tenant actors and are exempt.
--  SL5. * restaurants.tin and restaurants.opening_float leave the client SELECT grant. They are read through
--         fn_get_restaurant_settings() (settings.manage or reports.view). Writes still go through the existing
--         UPDATE column grant (settings.manage RLS policy).
--       * subscriptions (plan, trial and billing period) are readable only with settings.manage (or by platform admins).
--       * day_sessions rows (cash float, counted cash, variances, snapshots) are readable only with reports.view,
--         day_close.execute or day.open. Operational staff (waiters, cashiers, kitchen) get the OPEN day through
--         fn_get_open_day() and the session context: id, day_no, opened_at only.
--         Realtime on day_sessions therefore only reaches those privileged roles.
--       fn_get_session_context() is redefined: same shape as before plus open_day and platform_mfa
--       (the second tells a platform admin the console is locked until a TOTP step is completed).

-- ── SL3 ─────────────────────────────────────────────────────────────────────
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
  if (new.is_active is distinct from old.is_active or new.role_id is distinct from old.role_id)
     and not public.fn_caller_covers_role(old.role_id) then
    perform public.fn_err('permission_escalation', 'target holds rights the caller does not');
  end if;
  return new;
end;
$$;
revoke all on function public.fn_guard_profile_update() from public, anon, authenticated;
create trigger trg_guard_profile_update before update on public.profiles
  for each row execute function public.fn_guard_profile_update();

-- ── SL5 restaurants ─────────────────────────────────────────────────────────
revoke select on public.restaurants from authenticated;
grant select (id, name, slug, custom_domain, branding, status, vat_rate, auto_consume_stock, timezone, phone, address,
              suspended_at, suspension_reason, status_before_suspension, onboarded_at, created_at, updated_at)
  on public.restaurants to authenticated;

create or replace function public.fn_get_restaurant_settings()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_rid uuid := public.fn_tenant_status_guard(false);
begin
  if not (public.has_permission('settings.manage') or public.has_permission('reports.view')) then
    perform public.fn_err('permission_denied');
  end if;
  return (select jsonb_build_object('tin', r.tin, 'opening_float', r.opening_float)
          from public.restaurants r where r.id = v_rid);
end;
$$;
revoke all on function public.fn_get_restaurant_settings() from public, anon;
grant execute on function public.fn_get_restaurant_settings() to authenticated;

-- ── SL5 subscriptions ───────────────────────────────────────────────────────
alter policy subscriptions_select on public.subscriptions
  using ((restaurant_id = (select public.current_restaurant_id()) and (select public.has_permission('settings.manage')))
         or (select public.is_platform_admin()));

-- ── SL5 day_sessions ────────────────────────────────────────────────────────
alter policy day_sessions_select on public.day_sessions
  using (restaurant_id = (select public.current_restaurant_id())
         and ((select public.has_permission('reports.view'))
              or (select public.has_permission('day_close.execute'))
              or (select public.has_permission('day.open'))));

create or replace function public.fn_get_open_day()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_rid uuid := public.fn_tenant_status_guard(false);
begin
  return (select jsonb_build_object('id', d.id, 'day_no', d.day_no, 'opened_at', d.opened_at)
          from public.day_sessions d where d.restaurant_id = v_rid and d.status = 'open');
end;
$$;
revoke all on function public.fn_get_open_day() from public, anon;
grant execute on function public.fn_get_open_day() to authenticated;

-- ── session context (adds open_day, platform_mfa) ───────────────────────────
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
    'tenant_writable', (r.status in ('trialing', 'active')),
    'open_day', (select jsonb_build_object('id', d.id, 'day_no', d.day_no, 'opened_at', d.opened_at)
                 from public.day_sessions d where d.restaurant_id = r.id and d.status = 'open')
  ) into v
  from public.profiles p
  join public.restaurants r on r.id = p.restaurant_id
  join public.roles ro on ro.id = p.role_id and ro.restaurant_id = p.restaurant_id
  where p.id = v_uid and p.is_active and r.status not in ('suspended', 'cancelled');

  if v is null and v_platform is null then
    return null;
  end if;
  return coalesce(v, '{}'::jsonb)
    || case when v_platform is null then '{}'::jsonb
            else jsonb_build_object('platform_role', v_platform, 'platform_mfa', public.fn_platform_mfa_satisfied()) end;
end;
$$;
