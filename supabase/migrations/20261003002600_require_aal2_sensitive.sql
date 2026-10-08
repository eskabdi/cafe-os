-- 0026  A REAL authenticator (aal2) for two sensitive server actions; no pass for users without an MFA factor
--
--  Problem: fn_require_step_up() (0015) refuses (mfa_required) only when the caller HAS a verified TOTP factor or
--  app.tenant_admin_mfa_required is on. A PIN-only staff delegate (no factor, aal1 session) holding the permission therefore
--  passed with just a PIN. For the two actions below that is not acceptable.
--
--  fn_require_aal2()  internal helper (no client EXECUTE): raises P0001 'mfa_required' unless the JWT says aal = 'aal2'.
--                     No factor lookup, no GUC: a caller without any authenticator can never satisfy it.
--  Switched from fn_require_step_up() to fn_require_aal2() (nothing else changes; order stays
--  tenant guard -> permission -> aal2 -> validation):
--    (a) fn_decide_pin_change    behind fn_approve_pin_change / fn_reject_pin_change (0024)
--    (b) fn_store_session_timers behind fn_update_session_timers / fn_reset_session_timers (0025)
--  Every other step-up caller (role changes, kiosk registration, ...) keeps fn_require_step_up() unchanged.
--  Consequence: PIN-only staff cannot approve/reject a PIN change or edit the session timers even if a role grants them the
--  permission; the tenant_admin (or a Supabase Auth delegate with an authenticator) does it on an aal2 session.

create or replace function public.fn_require_aal2()
returns void
language plpgsql stable security definer set search_path = ''
as $$
begin
  if coalesce((select auth.jwt()) ->> 'aal', '') <> 'aal2' then
    perform public.fn_err('mfa_required');
  end if;
end;
$$;
revoke all on function public.fn_require_aal2() from public, anon, authenticated;

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
  perform public.fn_require_aal2();
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
  perform public.fn_require_aal2();

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
