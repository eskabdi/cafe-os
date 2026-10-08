-- 0014  SM3 + L2: PIN verification hardening.
--
--  * PEPPER. The database NEVER sees a raw PIN any more. The pin-login / staff-create Edge Functions compute
--    digest = hex(HMAC-SHA256(pin, PIN_PEPPER)) with a secret that lives only in the Edge Function environment and
--    pass the 64-hex digest to fn_set_user_pin / fn_verify_pin, which bcrypt (cost 10) that digest. A leaked database
--    (backup, replica, SQL injection) therefore cannot be brute-forced offline without the pepper: the PIN space is
--    only 10^4 for four digits, which bcrypt alone would not protect (the lockout is what limits ONLINE guessing).
--    Consequence: the weak-PIN policy (exactly 4 digits, no repeated / sequential / common PINs) is enforced where the raw PIN is
--    visible, in the Edge Functions (supabase/functions/_shared/pin.ts). SQL can only insist on the digest format
--    (a raw 4-digit PIN, or anything else, is refused with invalid_pin).
--    Pre-existing hashes were bcrypt(raw PIN) and no longer verify: PINs must be set again (seed does so).
--  * SERIALISATION. fn_verify_pin first takes the profile_secrets row FOR UPDATE, so concurrent guesses against one
--    account are evaluated strictly one after the other: the 4th..Nth concurrent guess sees the lock set by the 3rd.
--    (Measured before this change: 60 concurrent sessions drove failed_attempts well past the threshold.)
--  * ESCALATING, NON-RESETTING LOCK. failed_attempts only returns to 0 after a successful verify or an explicit
--    fn_reset_pin_lockout (users.manage, audited). It no longer resets when a lock merely expires, so an attacker
--    cannot farm a fresh window every 15 minutes. From the 3rd failure on EVERY further failure re-locks:
--    failures 3-5 => 15 minutes, 6-8 => 1 hour, 9+ => 24 hours. While locked, a PIN is rejected WITHOUT being
--    evaluated (no counter change, no success path), at the same bcrypt cost as a real check.
--  * NO STATE ORACLE (L2). unknown / not PIN-eligible / inactive / tenant suspended / locked / wrong PIN all return
--    exactly {"status":"invalid"}. attempts_left and locked_until are no longer returned. (An attacker who knows a
--    username can still lock that user out; that DoS is inherent to lockouts and is mitigated by the admin reset.)

drop function public.fn_set_user_pin(uuid, text);
drop function public.fn_verify_pin(uuid, text);
drop function public.fn_register_pin_failure(uuid);

create or replace function public.fn_pin_lock_duration(p_failed integer)
returns interval
language sql immutable set search_path = ''
as $$
  select case when p_failed >= 9 then interval '24 hours'
              when p_failed >= 6 then interval '1 hour'
              when p_failed >= 3  then interval '15 minutes'
              else null end
$$;
revoke all on function public.fn_pin_lock_duration(integer) from public, anon, authenticated;

create or replace function public.fn_set_user_pin(p_profile_id uuid, p_pin_digest text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rid uuid;
begin
  if not public.is_service_role() then perform public.fn_err('permission_denied'); end if;
  -- only a peppered digest is accepted: 64 lowercase hex characters (never a raw PIN)
  if p_pin_digest is null or p_pin_digest !~ '^[0-9a-f]{64}$' then perform public.fn_err('invalid_pin'); end if;
  select p.restaurant_id into v_rid from public.profiles p where p.id = p_profile_id;
  if not found then perform public.fn_err('not_found'); end if;
  -- tenant_admin, platform admins and accounts awaiting identity rotation never get a PIN
  if not public.fn_pin_eligible(p_profile_id) then perform public.fn_err('pin_not_allowed'); end if;

  insert into public.profile_secrets (profile_id, restaurant_id, pin_hash)
  values (p_profile_id, v_rid, extensions.crypt(p_pin_digest, extensions.gen_salt('bf', 10)))
  on conflict (profile_id) do update
    set pin_hash = excluded.pin_hash, failed_attempts = 0, locked_until = null, pin_changed_at = now();

  perform public.fn_write_audit('auth.pin_set', jsonb_build_object('profile_id', p_profile_id), v_rid);
end;
$$;

-- Registers one failed attempt (internal building block of fn_verify_pin; also service-callable).
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
  v_dur interval;
begin
  if not public.is_service_role() then perform public.fn_err('permission_denied'); end if;
  if not public.fn_pin_eligible(p_profile_id) then
    return jsonb_build_object('locked', false, 'failed_attempts', 0);  -- identical to "no such profile"
  end if;

  update public.profile_secrets ps
     set failed_attempts = ps.failed_attempts + 1,
         locked_until = case
           when public.fn_pin_lock_duration(ps.failed_attempts + 1) is null then ps.locked_until
           else greatest(coalesce(ps.locked_until, '-infinity'::timestamptz),
                         now() + public.fn_pin_lock_duration(ps.failed_attempts + 1))
         end
   where ps.profile_id = p_profile_id
   returning ps.failed_attempts, ps.locked_until, ps.restaurant_id into v_attempts, v_locked, v_rid;
  if not found then
    return jsonb_build_object('locked', false, 'failed_attempts', 0);
  end if;

  v_dur := public.fn_pin_lock_duration(v_attempts);
  perform public.fn_write_audit(case when v_dur is not null then 'auth.account_locked' else 'auth.pin_failed' end,
    jsonb_build_object('profile_id', p_profile_id, 'failed_attempts', v_attempts), v_rid);
  return jsonb_build_object('locked', v_locked is not null and v_locked > now(),
                            'locked_until', v_locked, 'failed_attempts', v_attempts);
end;
$$;

-- Returns {"status":"ok","profile":{...}} or {"status":"invalid"} (the only two shapes). Never raises on a bad
-- PIN (the failure counter must commit) and never returns pin_hash.
create or replace function public.fn_verify_pin(p_profile_id uuid, p_pin_digest text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record;
  v_valid_shape boolean := p_pin_digest is not null and p_pin_digest ~ '^[0-9a-f]{64}$';
begin
  if not public.is_service_role() then perform public.fn_err('permission_denied'); end if;

  -- serialise every attempt against this account (row lock held until the surrounding transaction ends)
  select ps.pin_hash, ps.locked_until,
         p.is_active, p.restaurant_id, r.status as tenant_status,
         p.id, p.first_name, p.middle_name, p.last_name, p.short_name, p.username, p.role_id
    into v
  from public.profile_secrets ps
  join public.profiles p on p.id = ps.profile_id
  join public.restaurants r on r.id = p.restaurant_id
  where ps.profile_id = p_profile_id
  for update of ps;

  if not found or not v_valid_shape or not public.fn_pin_eligible(p_profile_id)
     or not v.is_active or v.tenant_status in ('suspended', 'cancelled')
     or (v.locked_until is not null and v.locked_until > now()) then
    -- unknown / ineligible / inactive / locked: NOT evaluated, same bcrypt cost, same answer
    perform extensions.crypt(coalesce(p_pin_digest, ''), extensions.gen_salt('bf', 10));
    return jsonb_build_object('status', 'invalid');
  end if;

  if extensions.crypt(p_pin_digest, v.pin_hash) = v.pin_hash then
    update public.profile_secrets set failed_attempts = 0, locked_until = null where profile_id = p_profile_id;
    perform public.fn_write_audit('auth.pin_success', jsonb_build_object('profile_id', p_profile_id), v.restaurant_id);
    return jsonb_build_object('status', 'ok', 'profile', jsonb_build_object(
      'id', v.id, 'restaurant_id', v.restaurant_id, 'first_name', v.first_name, 'middle_name', v.middle_name,
      'last_name', v.last_name, 'short_name', v.short_name, 'username', v.username, 'role_id', v.role_id));
  end if;

  perform public.fn_register_pin_failure(p_profile_id);
  return jsonb_build_object('status', 'invalid');
end;
$$;

-- non-escalation helper (also used by the profile guards): may the caller hold the target role's rights?
-- tenant_admin covers everything; others must already hold every permission and station of that role.
create or replace function public.fn_caller_covers_role(p_role_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select case
    when (select public.is_tenant_admin()) then true
    else not exists (
           select 1 from public.role_permissions rp join public.permissions pm on pm.id = rp.permission_id
           where rp.role_id = p_role_id and not public.has_permission(pm.key))
         and not exists (
           select 1 from public.role_station_access rsa
           where rsa.role_id = p_role_id and not (rsa.station_id = any (((select public.current_station_ids()))::uuid[])))
  end
$$;
-- internal: only definer RPCs / triggers call it
revoke all on function public.fn_caller_covers_role(uuid) from public, anon, authenticated;

-- Admin reset of a PIN lockout (the ONLY way, besides a successful verify, for the counter to return to 0).
create or replace function public.fn_reset_pin_lockout(p_profile_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rid uuid;
  v_role uuid;
begin
  v_rid := public.fn_tenant_status_guard(true);
  if not public.has_permission('users.manage') then perform public.fn_err('permission_denied'); end if;
  if p_profile_id is null then perform public.fn_err('invalid_input'); end if;

  select p.role_id into v_role
  from public.profile_secrets ps join public.profiles p on p.id = ps.profile_id
  where ps.profile_id = p_profile_id and ps.restaurant_id = v_rid;
  if not found then perform public.fn_err('not_found'); end if;   -- same answer for foreign and unknown ids
  if not public.fn_caller_covers_role(v_role) then perform public.fn_err('permission_escalation'); end if;

  update public.profile_secrets set failed_attempts = 0, locked_until = null
  where profile_id = p_profile_id and restaurant_id = v_rid;

  perform public.fn_write_audit('auth.pin_lockout_reset', jsonb_build_object('profile_id', p_profile_id));
  return jsonb_build_object('profile_id', p_profile_id, 'reset', true);
end;
$$;
revoke all on function public.fn_reset_pin_lockout(uuid) from public, anon;
grant execute on function public.fn_reset_pin_lockout(uuid) to authenticated;

revoke all on function public.fn_set_user_pin(uuid, text), public.fn_verify_pin(uuid, text),
                       public.fn_register_pin_failure(uuid) from public, anon, authenticated;
grant execute on function public.fn_set_user_pin(uuid, text), public.fn_verify_pin(uuid, text),
                          public.fn_register_pin_failure(uuid) to service_role;
