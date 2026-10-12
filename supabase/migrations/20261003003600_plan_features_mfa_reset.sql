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
--     are submitted. Backfill: a plan without the key gets false (same semantics); a non-boolean value (legacy string / number) is
--     coerced to a boolean (true only for true/t/yes/on/1, case-insensitive), so the entitlement cast can never fail.
--  B. fn_platform_get_tenant (0030 body unchanged) + 'tenant_admins': the profiles of that tenant holding the system tenant_admin
--     role: identity, e-mail (auth.users), is_active, mfa_enrolled (a verified factor exists), mfa_reset_pending (a half-done reset
--     can be finished, see C), recovery_resend_available (the recovery e-mail can be sent again, see C), trusted_devices (live
--     count). Identity
--     and authenticator state only; no operational data.
--  C. Super Admin MFA reset (pattern: staff-pin-reset), bound by a single-use reset row and forcing credential re-proof:
--     public.mfa_resets   one row per prepare: user, restaurant, requested_by (the Super Admin), reason, the factor ids handed to the
--        Edge Function, created_at, expires_at (created + 5 min), claimed_at (the Edge Function took the row before rotating the
--        password), signed_out_at + sessions_revoked + devices_revoked (the sign-out step), completed_at. RLS enabled + forced, NO
--        policy, NO privilege for any API role (incl. service_role): written and read only by the definer functions below. No
--        DELETE and no TRUNCATE (owner included): the post-reset session rule reads it.
--     The Edge Function's order (nothing irreversible happens before the row is claimed, the factors go LAST):
--        prepare (caller) -> claim (service) -> rotate the password (GoTrue) -> sign out (service) -> delete the factors, re-list them
--        and delete any that appeared meanwhile (GoTrue) -> complete (service) -> recovery e-mail (GoTrue).
--     fn_platform_prepare_mfa_reset(restaurant, profile, reason)   AS THE CALLER (Super Admin, fn_platform_guard + a real TOTP at most
--        12 h old): target = an ACTIVE tenant_admin profile of that restaurant (anything else, including another tenant's admin, is
--        not_found, same as unknown); a suspended / cancelled tenant -> tenant_suspended. Needs a verified factor (else
--        invalid_state|no_factor) UNLESS a half-done reset is pending (fn_mfa_reset_pending: factors already deleted, completion never
--        happened), so a failed completion can always be finished. Inserts the mfa_resets row and returns {reset_id, profile_id,
--        user_id, factor_ids} (factor_ids may be empty when finishing). Audited (admin_audit_log 'tenant_admin.mfa_reset_requested').
--     fn_platform_claim_mfa_reset(reset_id)   SERVICE ROLE ONLY, BEFORE the password rotation. Locks the row and the target profile
--        (serialises every claim / completion for one user) and refuses: unknown -> not_found, completed -> reset_completed, expired
--        -> reset_expired, requested before the user's latest completed reset -> reset_superseded (so a second, concurrently prepared
--        reset can never overwrite the password the user already set from the first recovery link), already claimed or another
--        claimed, unexpired, uncompleted reset of the same user -> reset_in_progress; requester no longer an active Super Admin ->
--        permission_denied; target no longer an active tenant_admin of that restaurant -> not_found; tenant suspended / cancelled ->
--        tenant_suspended. Stamps claimed_at; returns {reset_id, profile_id, user_id, created_at, factor_ids}.
--     fn_platform_mfa_reset_sign_out(reset_id)   SERVICE ROLE ONLY, AFTER the rotation and BEFORE the factors are deleted: a claimed,
--        uncompleted row only. Revokes the live trusted devices (reason 'mfa_reset'), drops the session attestations, deletes the
--        auth sessions (null when the DB role may not) and records the counts on the row. Audited ('tenant_admin.mfa_reset_signed_out').
--     fn_platform_complete_mfa_reset(reset_id)        SERVICE ROLE ONLY. Consumes the row FOR UPDATE: unknown -> not_found, completed ->
--        invalid_state|reset_completed (replay), expired -> invalid_state|reset_expired, requested before the user's latest completed
--        reset -> invalid_state|reset_superseded. Actor, profile, restaurant and reason come
--        from the row, never from the caller. Re-checks the requester is still an active Super Admin, the target still an active
--        tenant_admin of that restaurant and the tenant neither suspended nor cancelled: when that fails AFTER the factors are gone it
--        RETURNS {refused: permission_denied|not_found|tenant_suspended} (no exception, so the admin audit
--        'tenant_admin.mfa_reset_incomplete' AND the tenant's 'auth.mfa_reset_incomplete_by_platform' row, with the reason, persist);
--        otherwise it raises. Refuses invalid_state|factors_remain while a verified factor remains. Then revokes the user's live
--        trusted devices again, drops their session attestations, deletes their auth sessions (null when the DB role may not; totals
--        include the sign-out step), and stamps completed_at. Audited twice: admin_audit_log 'tenant_admin.mfa_reset' and the tenant's
--        audit_logs 'auth.mfa_reset_by_platform' (actor = the requesting Super Admin, actor_type platform_admin, WITH the reason).
--     fn_session_after_mfa_reset() -> fn_mfa_session_ok() (0032) + fn_require_recent_totp() (0032) + fn_require_step_up() (0032): the
--        JWT session (session_id claim -> auth.sessions.created_at) must have been created AFTER (a) the latest completed_at of the
--        user's resets and (b) the created_at of every reset of the user that is not completed and either not expired or claimed
--        (a pending reset cuts the old sessions off at once; a claimed one may have rotated the password, so it keeps cutting them
--        off after it expired). No such session row -> not ok. fn_require_step_up raises mfa_required on a failing session whatever
--        app.tenant_admin_mfa_required says. A session that survived the reset (e.g. hosted Supabase where auth.sessions cannot be
--        deleted, or a stolen password session) can never reach an MFA-gated action again, even after enrolling a new factor. Every
--        aal2 gate goes through one of them (fn_platform_mfa_satisfied, fn_platform_guard, fn_require_aal2 -> fn_mfa_session_ok;
--        fn_require_step_up -> fn_session_after_mfa_reset + fn_mfa_session_ok; fn_trust_device and the step-up actions ->
--        fn_require_recent_totp).
--     fn_platform_prepare_recovery_resend(restaurant, profile, reason)   AS THE CALLER (same guard + recent TOTP + target rules +
--        tenant_suspended as prepare): only when fn_mfa_recovery_resend_available (no verified factor, the user's latest reset is
--        completed, nothing pending or in flight), else invalid_state|recovery_not_available. Audited (admin_audit_log
--        'tenant_admin.recovery_resent' + the tenant's 'auth.recovery_resent_by_platform', with the reason). The Edge Function then
--        sends the recovery e-mail: a Tenant Admin whose recovery link expired is never locked out for good.
--     The Edge Function sends the recovery e-mail after completion: the Tenant Admin proves the e-mail inbox, sets a new password
--     and enrols a new authenticator.

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

-- backfill (the plans row-audit trigger records each change):
--  absent already meant "not entitled": make it explicit; a non-boolean value (string / number / null / array / object) becomes a
--  boolean, true only for the usual truthy spellings, so fn_generate_voucher's ::boolean cast can never fail at issue time
update public.plans set features = features || '{"installments": false}'::jsonb where not (features ? 'installments');
update public.plans
   set features = features || jsonb_build_object('installments',
         coalesce(lower(btrim(features ->> 'installments')) in ('true', 't', 'yes', 'on', '1'), false))
 where jsonb_typeof(features -> 'installments') <> 'boolean';

-- ════════════════════════════════════════ B. platform tenant detail + tenant_admins ════════════════════════════════════════
create or replace function public.fn_platform_get_tenant(p_restaurant_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v jsonb;
  v_writable boolean;
begin
  perform public.fn_platform_guard();
  if p_restaurant_id is null then perform public.fn_err('invalid_input', 'restaurant_id'); end if;
  v := public.fn_platform_tenant_json(p_restaurant_id);
  if v is null then perform public.fn_err('not_found'); end if;
  select r.status not in ('suspended', 'cancelled') into v_writable from public.restaurants r where r.id = p_restaurant_id;
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
                         -- a half-done reset (factors deleted, completion missing): the portal offers "Finish reset"
                         'mfa_reset_pending', public.fn_mfa_reset_pending(p.id),
                         -- a completed reset whose recovery link was never used: the portal offers "Resend recovery email"
                         'recovery_resend_available', p.is_active and v_writable and public.fn_mfa_recovery_resend_available(p.id),
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
-- C1. the single-use reset rows (tenant table: restaurant_id + FK + lock trigger; no client access at all)
create table public.mfa_resets (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.profiles (id) on delete restrict,
  restaurant_id    uuid not null references public.restaurants (id) on delete restrict,
  requested_by     uuid not null references public.platform_admins (id) on delete restrict,
  reason           text not null check (char_length(reason) between 3 and 500),
  factor_ids       uuid[] not null default '{}' check (cardinality(factor_ids) <= 20),
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  -- the Edge Function took the row (fn_platform_claim_mfa_reset) BEFORE rotating the password
  claimed_at       timestamptz,
  -- the sign-out step (fn_platform_mfa_reset_sign_out), after the rotation and before the factors were deleted
  signed_out_at    timestamptz,
  sessions_revoked integer check (sessions_revoked >= 0),
  devices_revoked  integer check (devices_revoked >= 0),
  completed_at     timestamptz,
  check (expires_at > created_at),
  check (claimed_at is null or claimed_at >= created_at),
  check (signed_out_at is null or (claimed_at is not null and signed_out_at >= claimed_at)),
  check (completed_at is null or completed_at >= created_at)
);
create index mfa_resets_user_idx on public.mfa_resets (user_id, created_at desc);
create index mfa_resets_user_completed_idx on public.mfa_resets (user_id, completed_at desc) where completed_at is not null;
create index mfa_resets_restaurant_idx on public.mfa_resets (restaurant_id);
create index mfa_resets_requested_by_idx on public.mfa_resets (requested_by);
alter table public.mfa_resets enable row level security;
alter table public.mfa_resets force row level security;
-- NO policies and NO privileges for any API role: only the definer functions below read / write it
revoke all on public.mfa_resets from public, anon, authenticated, service_role;
create trigger trg_lock_restaurant_id before update on public.mfa_resets
  for each row execute function public.fn_lock_restaurant_id();
create trigger trg_00_no_delete before delete on public.mfa_resets
  for each row execute function public.fn_forbid_mutation();
-- the post-reset session rule reads these rows: wiping them (TRUNCATE skips row triggers) would re-open every surviving session
create trigger trg_00_no_truncate before truncate on public.mfa_resets
  for each statement execute function public.fn_forbid_mutation();

-- the bulk deletes of the sign-out / completion steps and fn_revoke_devices_of filter by user
create index if not exists session_device_attestations_user_idx on public.session_device_attestations (user_id);

-- C2. predicates
-- true unless THIS session (JWT session_id) of the caller was created before the cut-off of an MFA reset of the caller: the latest
-- completed_at, and the created_at of every reset that is not completed and either still unexpired (pending: the Super Admin has
-- started it) or claimed (the password may already have been rotated)
create or replace function public.fn_session_after_mfa_reset()
returns boolean
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_cut timestamptz;
  v_created timestamptz;
begin
  if v_uid is null then return true; end if;   -- no user: the callers' own checks refuse
  select max(case when r.completed_at is not null then r.completed_at else r.created_at end) into v_cut
  from public.mfa_resets r
  where r.user_id = v_uid
    and (r.completed_at is not null or r.expires_at > now() or r.claimed_at is not null);
  if v_cut is null then return true; end if;
  begin
    select s.created_at into v_created from auth.sessions s where s.id = public.fn_jwt_session_id() and s.user_id = v_uid;
  exception when insufficient_privilege then
    return false;   -- fail closed
  end;
  return v_created is not null and v_created > v_cut;
end;
$$;
revoke all on function public.fn_session_after_mfa_reset() from public, anon, authenticated;

-- 0032 body + the post-reset session rule (THE MFA predicate of every portal gate)
create or replace function public.fn_mfa_session_ok()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select ((coalesce((select auth.jwt()) ->> 'aal', '') = 'aal2'
           and exists (select 1 from auth.mfa_factors f where f.user_id = (select auth.uid()) and f.status = 'verified'))
          or public.fn_device_trust_satisfied())
     and public.fn_session_after_mfa_reset()
$$;
revoke all on function public.fn_mfa_session_ok() from public, anon, authenticated;

-- 0032 body + the post-reset session rule (it reads the JWT itself, not fn_mfa_session_ok)
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
                      and to_timestamp((e ->> 'timestamp')::bigint) <= now() + interval '5 minutes')
     or not public.fn_session_after_mfa_reset() then
    perform public.fn_err('step_up_required');
  end if;
end;
$$;
revoke all on function public.fn_require_recent_totp(interval) from public, anon, authenticated;

-- 0032 body + the post-reset session rule FIRST: a session cut off by an MFA reset is refused even when the user has no factor
-- (yet) and app.tenant_admin_mfa_required is off (the 0032 "no factor, no requirement" exemption must not reopen it)
create or replace function public.fn_require_step_up()
returns void
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not public.fn_session_after_mfa_reset() then perform public.fn_err('mfa_required'); end if;
  if public.fn_mfa_session_ok() then return; end if;
  if exists (select 1 from auth.mfa_factors f where f.user_id = (select auth.uid()) and f.status = 'verified')
     or current_setting('app.tenant_admin_mfa_required', true) = 'on' then
    perform public.fn_err('mfa_required');
  end if;
end;
$$;
revoke all on function public.fn_require_step_up() from public, anon, authenticated;

-- a half-done reset: no verified factor any more, and a reset whose factors were handed out for deletion was requested after the
-- latest completed one but never completed itself (the Edge Function died / completion was refused). Finishing it is allowed.
create or replace function public.fn_mfa_reset_pending(p_user_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select not exists (select 1 from auth.mfa_factors f where f.user_id = p_user_id and f.status = 'verified')
     and exists (select 1 from public.mfa_resets r
                 where r.user_id = p_user_id and r.completed_at is null and cardinality(r.factor_ids) > 0
                   and r.created_at > coalesce((select max(c.completed_at) from public.mfa_resets c
                                                where c.user_id = p_user_id and c.completed_at is not null), '-infinity'::timestamptz))
$$;
revoke all on function public.fn_mfa_reset_pending(uuid) from public, anon, authenticated;

-- the recovery e-mail may be sent again: no verified factor, the user's LATEST reset (by request time) is completed, and nothing is
-- pending or in flight (a completed reset whose recovery link expired would otherwise lock the Tenant Admin out for good)
create or replace function public.fn_mfa_recovery_resend_available(p_user_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select not exists (select 1 from auth.mfa_factors f where f.user_id = p_user_id and f.status = 'verified')
     and coalesce((select r.completed_at is not null from public.mfa_resets r where r.user_id = p_user_id
                   order by r.created_at desc, (r.completed_at is not null) desc limit 1), false)
     and not public.fn_mfa_reset_pending(p_user_id)
     and not exists (select 1 from public.mfa_resets r where r.user_id = p_user_id and r.completed_at is null
                       and (r.expires_at > now() or r.claimed_at is not null)
                       and r.created_at > (select max(c.completed_at) from public.mfa_resets c
                                           where c.user_id = p_user_id and c.completed_at is not null))
$$;
revoke all on function public.fn_mfa_recovery_resend_available(uuid) from public, anon, authenticated;

-- the target rules shared by prepare / resend: an ACTIVE tenant_admin of THAT restaurant (anything else answers the same
-- not_found), then the tenant must not be suspended / cancelled (tenant_suspended)
create or replace function public.fn_mfa_reset_target_check(p_restaurant_id uuid, p_profile_id uuid)
returns void
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_status text;
begin
  perform 1 from public.profiles p join public.roles ro on ro.id = p.role_id and ro.restaurant_id = p.restaurant_id
   where p.id = p_profile_id and p.restaurant_id = p_restaurant_id and p.is_active and ro.system_key = 'tenant_admin';
  if not found then perform public.fn_err('not_found'); end if;
  select r.status into v_status from public.restaurants r where r.id = p_restaurant_id;
  if v_status in ('suspended', 'cancelled') then perform public.fn_err('tenant_suspended'); end if;
end;
$$;
revoke all on function public.fn_mfa_reset_target_check(uuid, uuid) from public, anon, authenticated;

-- C3. step 1 (AS THE CALLER, through the tenant-admin-mfa-reset Edge Function)
create or replace function public.fn_platform_prepare_mfa_reset(p_restaurant_id uuid, p_profile_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := public.fn_platform_guard();
  v_reason text;
  v_factors uuid[];
  v_finishing boolean;
  v_id uuid;
begin
  perform public.fn_require_recent_totp();
  if p_restaurant_id is null then perform public.fn_err('invalid_input', 'restaurant_id'); end if;
  if p_profile_id is null then perform public.fn_err('invalid_input', 'profile_id'); end if;
  v_reason := public.fn_platform_reason(p_reason);
  if p_profile_id = v_uid then perform public.fn_err('permission_denied'); end if;
  perform public.fn_mfa_reset_target_check(p_restaurant_id, p_profile_id);
  v_finishing := not exists (select 1 from auth.mfa_factors f where f.user_id = p_profile_id and f.status = 'verified');
  if v_finishing and not public.fn_mfa_reset_pending(p_profile_id) then
    perform public.fn_err('invalid_state', 'no_factor');
  end if;
  select coalesce(array_agg(f.id order by f.created_at, f.id), '{}') into v_factors
  from auth.mfa_factors f where f.user_id = p_profile_id;
  if cardinality(v_factors) > 20 then perform public.fn_err('invalid_state', 'too_many_factors'); end if;
  insert into public.mfa_resets (user_id, restaurant_id, requested_by, reason, factor_ids, expires_at)
  values (p_profile_id, p_restaurant_id, v_uid, v_reason, v_factors, now() + interval '5 minutes')
  returning id into v_id;
  perform public.fn_write_admin_audit('tenant_admin.mfa_reset_requested', p_restaurant_id,
                                      jsonb_build_object('profile_id', p_profile_id, 'reset_id', v_id, 'reason', v_reason,
                                                         'finishing', v_finishing));
  return jsonb_build_object('reset_id', v_id, 'profile_id', p_profile_id, 'user_id', p_profile_id, 'factor_ids', to_jsonb(v_factors));
end;
$$;

-- C3b. step 2 (SERVICE ROLE, BEFORE the password rotation): take the row; every refusal happens here, while nothing has changed yet
create or replace function public.fn_platform_claim_mfa_reset(p_reset_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.mfa_resets%rowtype;
  v_status text;
begin
  if not public.is_service_role() then perform public.fn_err('permission_denied'); end if;
  if p_reset_id is null then perform public.fn_err('invalid_input', 'reset_id'); end if;
  select * into r from public.mfa_resets m where m.id = p_reset_id for update;
  if not found then perform public.fn_err('not_found'); end if;
  -- one claim / completion per user at a time (the same lock order as the completion: reset row, then profile)
  perform 1 from public.profiles p where p.id = r.user_id for update;
  if r.completed_at is not null then perform public.fn_err('invalid_state', 'reset_completed'); end if;
  if r.expires_at <= now() then perform public.fn_err('invalid_state', 'reset_expired'); end if;
  -- a newer reset completed after this one was requested: the user may already have set a password from ITS recovery link
  if exists (select 1 from public.mfa_resets c where c.user_id = r.user_id and c.completed_at > r.created_at) then
    perform public.fn_err('invalid_state', 'reset_superseded');
  end if;
  if r.claimed_at is not null
     or exists (select 1 from public.mfa_resets o
                where o.user_id = r.user_id and o.id <> r.id and o.claimed_at is not null and o.completed_at is null
                  and o.expires_at > now()) then
    perform public.fn_err('invalid_state', 'reset_in_progress');
  end if;
  if not exists (select 1 from public.platform_admins a
                 where a.id = r.requested_by and a.is_active and a.role = 'platform_super_admin') then
    perform public.fn_err('permission_denied');
  end if;
  perform 1 from public.profiles p join public.roles ro on ro.id = p.role_id and ro.restaurant_id = p.restaurant_id
   where p.id = r.user_id and p.restaurant_id = r.restaurant_id and p.is_active and ro.system_key = 'tenant_admin';
  if not found then perform public.fn_err('not_found'); end if;
  select x.status into v_status from public.restaurants x where x.id = r.restaurant_id;
  if v_status in ('suspended', 'cancelled') then perform public.fn_err('tenant_suspended'); end if;

  update public.mfa_resets set claimed_at = clock_timestamp() where id = r.id;
  insert into public.admin_audit_log (platform_admin_id, restaurant_id, action, detail)
  values (r.requested_by, r.restaurant_id, 'tenant_admin.mfa_reset_claimed', jsonb_build_object('profile_id', r.user_id, 'reset_id', r.id));
  return jsonb_build_object('reset_id', r.id, 'profile_id', r.user_id, 'user_id', r.user_id, 'created_at', r.created_at,
                            'factor_ids', to_jsonb(r.factor_ids));
end;
$$;

-- revokes the user's live trusted devices, their session attestations and their auth sessions; counts (sessions null when the DB
-- role may not delete auth.sessions: hosted, the post-reset session rule still shuts every old session out)
create or replace function public.fn_mfa_reset_revoke_access(p_user_id uuid, p_by uuid, out sessions integer, out devices integer)
language plpgsql
security definer
set search_path = ''
as $$
begin
  with x as (
    update public.trusted_devices set revoked_at = now(), revoked_by = p_by, revoke_reason = 'mfa_reset'
     where user_id = p_user_id and revoked_at is null
    returning id
  ) select count(*) into devices from x;
  delete from public.session_device_attestations where user_id = p_user_id;
  begin
    delete from auth.sessions s where s.user_id = p_user_id;
    get diagnostics sessions = row_count;
  exception when insufficient_privilege then
    sessions := null;
  end;
end;
$$;
revoke all on function public.fn_mfa_reset_revoke_access(uuid, uuid) from public, anon, authenticated, service_role;

-- C3c. step 4 (SERVICE ROLE, AFTER the rotation, BEFORE the factors are deleted): sign the user out everywhere
create or replace function public.fn_platform_mfa_reset_sign_out(p_reset_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.mfa_resets%rowtype;
  v record;
begin
  if not public.is_service_role() then perform public.fn_err('permission_denied'); end if;
  if p_reset_id is null then perform public.fn_err('invalid_input', 'reset_id'); end if;
  select * into r from public.mfa_resets m where m.id = p_reset_id for update;
  if not found then perform public.fn_err('not_found'); end if;
  if r.completed_at is not null then perform public.fn_err('invalid_state', 'reset_completed'); end if;
  if r.claimed_at is null then perform public.fn_err('invalid_state', 'reset_not_claimed'); end if;
  -- (no expiry check: signing out only removes access, and the password of a claimed reset may already be rotated)
  select * into v from public.fn_mfa_reset_revoke_access(r.user_id, r.requested_by);
  update public.mfa_resets
     set signed_out_at = clock_timestamp(),
         sessions_revoked = case when v.sessions is null then null else coalesce(sessions_revoked, 0) + v.sessions end,
         devices_revoked = coalesce(devices_revoked, 0) + v.devices
   where id = r.id;
  insert into public.admin_audit_log (platform_admin_id, restaurant_id, action, detail)
  values (r.requested_by, r.restaurant_id, 'tenant_admin.mfa_reset_signed_out',
          jsonb_build_object('profile_id', r.user_id, 'reset_id', r.id, 'sessions_revoked', v.sessions, 'devices_revoked', v.devices));
  return jsonb_build_object('profile_id', r.user_id, 'sessions_revoked', v.sessions, 'devices_revoked', v.devices);
end;
$$;

-- C4. step 6 (SERVICE ROLE, after GoTrue deleted the factors): consume the reset row; devices, attestations, sessions (again: anything
-- that appeared since the sign-out step), completed_at, audit
create or replace function public.fn_platform_complete_mfa_reset(p_reset_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.mfa_resets%rowtype;
  v_factors_gone boolean;
  v_refusal text;
  v_status text;
  v record;
  v_devices integer;
  v_sessions integer;
begin
  if not public.is_service_role() then perform public.fn_err('permission_denied'); end if;
  if p_reset_id is null then perform public.fn_err('invalid_input', 'reset_id'); end if;
  select * into r from public.mfa_resets m where m.id = p_reset_id for update;
  if not found then perform public.fn_err('not_found'); end if;
  if r.completed_at is not null then perform public.fn_err('invalid_state', 'reset_completed'); end if;
  if r.expires_at <= now() then perform public.fn_err('invalid_state', 'reset_expired'); end if;
  -- a reset requested before the user's latest completed one is spent: completing it would only re-stamp completed_at
  if exists (select 1 from public.mfa_resets c where c.user_id = r.user_id and c.completed_at > r.created_at) then
    perform public.fn_err('invalid_state', 'reset_superseded');
  end if;

  v_factors_gone := not exists (select 1 from auth.mfa_factors f where f.user_id = r.user_id and f.status = 'verified');
  if not exists (select 1 from public.platform_admins a
                 where a.id = r.requested_by and a.is_active and a.role = 'platform_super_admin') then
    v_refusal := 'permission_denied';
  else
    perform 1 from public.profiles p join public.roles ro on ro.id = p.role_id and ro.restaurant_id = p.restaurant_id
     where p.id = r.user_id and p.restaurant_id = r.restaurant_id and p.is_active and ro.system_key = 'tenant_admin'
     for update of p;
    if not found then
      v_refusal := 'not_found';
    else
      select x.status into v_status from public.restaurants x where x.id = r.restaurant_id;
      if v_status in ('suspended', 'cancelled') then v_refusal := 'tenant_suspended'; end if;
    end if;
  end if;
  if v_refusal is not null then
    if not v_factors_gone then perform public.fn_err(v_refusal); end if;
    -- the factors are already gone: RETURN (not raise) so these records of the half-done reset survive, in both trails
    insert into public.admin_audit_log (platform_admin_id, restaurant_id, action, detail)
    values (r.requested_by, r.restaurant_id, 'tenant_admin.mfa_reset_incomplete',
            jsonb_build_object('profile_id', r.user_id, 'reset_id', r.id, 'refused', v_refusal, 'reason', r.reason));
    insert into public.audit_logs (restaurant_id, actor_id, actor_type, event, action, new_data)
    values (r.restaurant_id, r.requested_by, 'platform_admin', 'auth.mfa_reset_incomplete_by_platform', 'event',
            jsonb_build_object('profile_id', r.user_id, 'reason', r.reason, 'refused', v_refusal));
    return jsonb_build_object('profile_id', r.user_id, 'refused', v_refusal);
  end if;
  if not v_factors_gone then perform public.fn_err('invalid_state', 'factors_remain'); end if;

  select * into v from public.fn_mfa_reset_revoke_access(r.user_id, r.requested_by);
  -- totals: the sign-out step (when it ran) + this one; unknown (null) as soon as either could not touch auth.sessions
  v_devices := coalesce(r.devices_revoked, 0) + v.devices;
  v_sessions := case when r.signed_out_at is null then v.sessions
                     when r.sessions_revoked is null or v.sessions is null then null
                     else r.sessions_revoked + v.sessions end;
  -- stamped AFTER the sign-out: every session created before this instant fails fn_session_after_mfa_reset
  update public.mfa_resets set completed_at = clock_timestamp() where id = r.id;

  insert into public.admin_audit_log (platform_admin_id, restaurant_id, action, detail)
  values (r.requested_by, r.restaurant_id, 'tenant_admin.mfa_reset',
          jsonb_build_object('profile_id', r.user_id, 'reset_id', r.id, 'reason', r.reason,
                             'sessions_revoked', v_sessions, 'devices_revoked', v_devices));
  insert into public.audit_logs (restaurant_id, actor_id, actor_type, event, action, new_data)
  values (r.restaurant_id, r.requested_by, 'platform_admin', 'auth.mfa_reset_by_platform', 'event',
          jsonb_build_object('profile_id', r.user_id, 'reason', r.reason,
                             'sessions_revoked', v_sessions, 'devices_revoked', v_devices));
  return jsonb_build_object('profile_id', r.user_id, 'sessions_revoked', v_sessions, 'devices_revoked', v_devices);
end;
$$;

-- C5. resend the recovery e-mail (AS THE CALLER, through the same Edge Function, action 'resend_recovery'): a completed reset whose
-- recovery link expired / was lost; the e-mail goes to the registered address only (read by the Edge Function with the service role)
create or replace function public.fn_platform_prepare_recovery_resend(p_restaurant_id uuid, p_profile_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := public.fn_platform_guard();
  v_reason text;
begin
  perform public.fn_require_recent_totp();
  if p_restaurant_id is null then perform public.fn_err('invalid_input', 'restaurant_id'); end if;
  if p_profile_id is null then perform public.fn_err('invalid_input', 'profile_id'); end if;
  v_reason := public.fn_platform_reason(p_reason);
  if p_profile_id = v_uid then perform public.fn_err('permission_denied'); end if;
  perform public.fn_mfa_reset_target_check(p_restaurant_id, p_profile_id);
  -- serialise with a concurrent reset of the same user
  perform 1 from public.profiles p where p.id = p_profile_id for update;
  if not public.fn_mfa_recovery_resend_available(p_profile_id) then
    perform public.fn_err('invalid_state', 'recovery_not_available');
  end if;
  perform public.fn_write_admin_audit('tenant_admin.recovery_resent', p_restaurant_id,
                                      jsonb_build_object('profile_id', p_profile_id, 'reason', v_reason));
  insert into public.audit_logs (restaurant_id, actor_id, actor_type, event, action, new_data)
  values (p_restaurant_id, v_uid, 'platform_admin', 'auth.recovery_resent_by_platform', 'event',
          jsonb_build_object('profile_id', p_profile_id, 'reason', v_reason));
  return jsonb_build_object('profile_id', p_profile_id, 'user_id', p_profile_id);
end;
$$;

revoke all on function public.fn_platform_prepare_mfa_reset(uuid, uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.fn_platform_prepare_mfa_reset(uuid, uuid, text) to authenticated;
revoke all on function public.fn_platform_prepare_recovery_resend(uuid, uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.fn_platform_prepare_recovery_resend(uuid, uuid, text) to authenticated;
revoke all on function public.fn_platform_claim_mfa_reset(uuid) from public, anon, authenticated, service_role;
grant execute on function public.fn_platform_claim_mfa_reset(uuid) to service_role;
revoke all on function public.fn_platform_mfa_reset_sign_out(uuid) from public, anon, authenticated, service_role;
grant execute on function public.fn_platform_mfa_reset_sign_out(uuid) to service_role;
revoke all on function public.fn_platform_complete_mfa_reset(uuid) from public, anon, authenticated, service_role;
grant execute on function public.fn_platform_complete_mfa_reset(uuid) to service_role;
