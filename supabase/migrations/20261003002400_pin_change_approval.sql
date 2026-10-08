-- 0024  Maker-checker for a FORCED PIN change
--
--  User decision (2026-10-04): when a PIN staff member is flagged (profile_secrets.must_change_pin, set by the single-session
--  rule of 0023) and changes the PIN, the account does NOT regain access until a tenant_admin APPROVES the change.
--
--  State machine on profile_secrets (never both flags):
--      none --(fn_staff_login_blocked)--> required (must_change_pin)
--      required --(fn_complete_forced_pin_change)--> pending_approval (pin_change_pending, pin_change_requested_at)
--      pending_approval --(fn_approve_pin_change)--> none            (audit auth.pin_change_approved, notify subject)
--      pending_approval --(fn_reject_pin_change)---> required        (audit auth.pin_change_rejected, notify subject)
--      pending_approval --(fn_set_user_pin: admin-set / provisioning)--> none (an admin-set PIN is itself the admin's decision)
--      pending_approval --(fn_staff_login_blocked: PIN exposed again)--> required
--  A voluntary PIN change (no flag) needs no approval. A PIN change while already pending stays pending (no bypass).
--
--  Enforcement: fn_pin_restricted(user) = must_change_pin or pin_change_pending (tenant_admin exempt) is the ONE predicate used
--  by has_permission / has_station_access / current_station_ids and the session context. Restricted users hold no permission and
--  no station; they keep identity, own notifications (recipient-only policy, no has_permission) and the pin-change function.
--
--  Functions:
--    fn_pin_restricted(user_id)                      internal helper (no client EXECUTE)
--    fn_complete_forced_pin_change(profile, digest, claimed_length?) -> {pending_approval}   service_role only
--    fn_approve_pin_change(profile) / fn_reject_pin_change(profile)  authenticated; users.manage + step-up; tenant from identity;
--                                                    unknown / foreign / not-pending ids are all not_found; never the subject
--    fn_list_pending_pin_changes()                   authenticated; users.manage; caller's tenant only
--  Session context: + pin_change_status ('none'|'required'|'pending_approval'), + pin_length (4, 6 for Cashier via the existing
--  fn_pin_length_for_role_name). must_change_pin stays and is true only while status = 'required'.

-- ── state ───────────────────────────────────────────────────────────────────
alter table public.profile_secrets
  add column pin_change_pending boolean not null default false,
  add column pin_change_requested_at timestamptz,
  add constraint profile_secrets_pin_change_exclusive check (not (must_change_pin and pin_change_pending));

-- ── the single restriction predicate ────────────────────────────────────────
create or replace function public.fn_pin_restricted(p_user_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1
    from public.profile_secrets ps
    join public.profiles p on p.id = ps.profile_id and p.restaurant_id = ps.restaurant_id
    join public.roles ro on ro.id = p.role_id and ro.restaurant_id = p.restaurant_id
    where ps.profile_id = p_user_id
      and (ps.must_change_pin or ps.pin_change_pending)
      and ro.system_key is distinct from 'tenant_admin'   -- exempt, as before (such a row cannot exist for an admin anyway)
  )
$$;
revoke all on function public.fn_pin_restricted(uuid) from public, anon, authenticated;

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
      and not public.fn_pin_restricted(p.id)   -- forced PIN change required or awaiting approval: no permission at all
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
      and not public.fn_pin_restricted(p.id)
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
      and not public.fn_pin_restricted(p.id)
  ), '{}'::uuid[])
$$;

-- ── session context ─────────────────────────────────────────────────────────
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
                 from public.day_sessions d where d.restaurant_id = r.id and d.status = 'open')
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

-- ── fn_set_user_pin: admin-set / provisioning PINs never leave anyone pending ──
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
        failed_attempts = 0, locked_until = null, pin_changed_at = now(), must_change_pin = false,
        pin_change_pending = false, pin_change_requested_at = null;

  perform public.fn_write_audit('auth.pin_set', jsonb_build_object('profile_id', p_profile_id), v_rid);
end;
$$;
revoke all on function public.fn_set_user_pin(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.fn_set_user_pin(uuid, text, integer) to service_role;

-- ── fn_complete_forced_pin_change (service only; called by the pin-change Edge Function for EVERY change) ──
-- The "was it forced?" decision is taken here under the secret row lock, so there is no check-then-act gap in the Edge Function.
--   forced (must_change_pin)  -> store PIN, clear the flag, set pending_approval, notify tenant_admins, audit
--   already pending           -> store PIN, stay pending (a second change can never skip the approval; no new notification)
--   otherwise                 -> exactly fn_set_user_pin (voluntary change)
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

  -- serialise with approve / reject / blocked-login on the same row
  select ps.must_change_pin, ps.pin_change_pending into v_forced, v_pending
  from public.profile_secrets ps where ps.profile_id = p_profile_id for update;

  if not found or not (v_forced or v_pending) then
    perform public.fn_set_user_pin(p_profile_id, p_pin_digest, p_pin_length);
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
  -- every active tenant_admin of THIS tenant, once per (admin, subject) per 5 minutes (a reject/resubmit loop cannot spam)
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

-- ── approve / reject ────────────────────────────────────────────────────────
-- One body for both decisions. Not exposed itself: the two public wrappers fix the decision.
create or replace function public.fn_decide_pin_change(p_profile_id uuid, p_approve boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rid uuid;
  v_uid uuid := (select auth.uid());
  v_role uuid;
  v_name text;
  v_kind text := case when p_approve then 'approved' else 'rejected' end;
begin
  v_rid := public.fn_tenant_status_guard(true);
  if not public.has_permission('users.manage') then perform public.fn_err('permission_denied'); end if;
  perform public.fn_require_step_up();
  if p_profile_id is null then perform public.fn_err('invalid_input'); end if;
  if p_profile_id = v_uid then perform public.fn_err('permission_denied'); end if;   -- never the subject (a restricted user holds no users.manage anyway)

  -- lock the pending row of THIS tenant; foreign / unknown / not-pending all fall through to the same not_found
  select p.role_id, p.short_name into v_role, v_name
  from public.profile_secrets ps join public.profiles p on p.id = ps.profile_id and p.restaurant_id = ps.restaurant_id
  where ps.profile_id = p_profile_id and ps.restaurant_id = v_rid and ps.pin_change_pending
  for update of ps;
  if not found then perform public.fn_err('not_found'); end if;
  if not public.fn_caller_covers_role(v_role) then perform public.fn_err('permission_escalation'); end if;

  if p_approve then
    update public.profile_secrets set pin_change_pending = false, pin_change_requested_at = null
     where profile_id = p_profile_id and restaurant_id = v_rid;
  else
    update public.profile_secrets set pin_change_pending = false, pin_change_requested_at = null, must_change_pin = true
     where profile_id = p_profile_id and restaurant_id = v_rid;
  end if;

  insert into public.user_notifications (restaurant_id, recipient_id, kind, payload)
  values (v_rid, p_profile_id, 'security.pin_change_' || v_kind,
          jsonb_build_object('profile_id', p_profile_id, 'user_name', v_name, 'at', now()));

  perform public.fn_write_audit('auth.pin_change_' || v_kind, jsonb_build_object('profile_id', p_profile_id), v_rid);
  return jsonb_build_object('profile_id', p_profile_id, 'status', v_kind);
end;
$$;
revoke all on function public.fn_decide_pin_change(uuid, boolean) from public, anon, authenticated;

create or replace function public.fn_approve_pin_change(p_profile_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.fn_tenant_status_guard(true);   -- (also repeated inside; keeps the authorisation visible in this body)
  return public.fn_decide_pin_change(p_profile_id, true);
end;
$$;

create or replace function public.fn_reject_pin_change(p_profile_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.fn_tenant_status_guard(true);
  return public.fn_decide_pin_change(p_profile_id, false);
end;
$$;
revoke all on function public.fn_approve_pin_change(uuid), public.fn_reject_pin_change(uuid) from public, anon;
grant execute on function public.fn_approve_pin_change(uuid), public.fn_reject_pin_change(uuid) to authenticated;

-- ── pending list ────────────────────────────────────────────────────────────
create or replace function public.fn_list_pending_pin_changes()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_rid uuid := public.fn_tenant_status_guard(false);
begin
  if not public.has_permission('users.manage') then perform public.fn_err('permission_denied'); end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('profile_id', p.id, 'user_name', p.short_name,
                                        'role_label', ro.name, 'requested_at', ps.pin_change_requested_at)
                     order by ps.pin_change_requested_at, p.id)
    from public.profile_secrets ps
    join public.profiles p on p.id = ps.profile_id and p.restaurant_id = ps.restaurant_id
    join public.roles ro on ro.id = p.role_id and ro.restaurant_id = p.restaurant_id
    where ps.restaurant_id = v_rid and ps.pin_change_pending and p.is_active
  ), '[]'::jsonb);
end;
$$;
revoke all on function public.fn_list_pending_pin_changes() from public, anon;
grant execute on function public.fn_list_pending_pin_changes() to authenticated;

-- ── fn_staff_login_blocked: the PIN is exposed AGAIN while pending => back to "required" (keeps the exclusive CHECK) ──
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

  perform pg_advisory_xact_lock(hashtextextended('login_blocked:' || p_profile_id::text, 0));

  if p_kiosk_token_hash is not null then
    select k.name into v_kiosk from public.kiosk_devices k
    where k.token_hash = p_kiosk_token_hash and k.restaurant_id = v_rid and k.revoked_at is null;
  end if;

  update public.profile_secrets
     set must_change_pin = true, pin_change_pending = false, pin_change_requested_at = null
   where profile_id = p_profile_id and not must_change_pin;

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

  perform public.fn_write_audit('auth.concurrent_login_blocked',
    jsonb_build_object('profile_id', p_profile_id, 'kiosk_name', v_kiosk, 'notified', v_notify), v_rid);
  return jsonb_build_object('notified', v_notify);
end;
$$;
revoke all on function public.fn_staff_login_blocked(uuid, text) from public, anon, authenticated;
grant execute on function public.fn_staff_login_blocked(uuid, text) to service_role;
