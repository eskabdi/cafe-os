-- 0021  Cashier PIN length (user decision 2026-10-03): the role named 'Cashier' uses a 6-digit PIN, every other PIN
--       role exactly 4 digits.
--
--  DOCUMENTED EXCEPTION to the dynamic-domain rule (roles are rows, never keyed by name). It is the ONE name-keyed rule
--  and is isolated to fn_pin_length_for_role_name() below (SQL) and CASHIER_ROLE_NAME in
--  supabase/functions/_shared/pin.ts (TypeScript). Everything else asks fn_pin_length_for_role(role_id).
--  The comparison uses the same normalisation as roles.normalized_name, so 'cashier ' / 'CASHIER' are the Cashier role.
--
--  * profile_secrets.pin_length (4 | 6): recorded by fn_set_user_pin. The DB never sees the PIN itself, so the Edge
--    Function proves the length and the DB checks the CLAIM against the role: a 4-digit claim for a Cashier (or a
--    6-digit claim for anyone else) raises pin_length_mismatch.
--  * fn_change_user_role: when the new role needs a different length than the stored secret, the secret is destroyed
--    (no PIN login until a PIN of the right length is issued); the result carries pin_reset_required.
--  * Renaming a role into or out of 'Cashier' changes the required length for all its users: their secrets are
--    destroyed by trigger (otherwise a rename would be a way around the rule).

alter table public.profile_secrets add column pin_length smallint not null default 4 check (pin_length in (4, 6));

-- forbidden-patterns: allow-seed-data  (documented user-decided exception: Cashier PIN length; the only name-keyed rule)
create or replace function public.fn_pin_length_for_role_name(p_name text)
returns integer
language sql immutable set search_path = ''
as $$
  select case when lower(regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g')) = 'cashier' then 6 else 4 end
$$;
-- forbidden-patterns: end

create or replace function public.fn_pin_length_for_role(p_role_id uuid)
returns integer
language sql stable security definer set search_path = ''
as $$
  select public.fn_pin_length_for_role_name((select r.name from public.roles r where r.id = p_role_id))
$$;
revoke all on function public.fn_pin_length_for_role_name(text), public.fn_pin_length_for_role(uuid) from public, anon, authenticated;

-- ── fn_set_user_pin(profile, digest, claimed length) ────────────────────────
drop function public.fn_set_user_pin(uuid, text);
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
  -- the caller (Edge Function) states the length of the PIN it hashed; it must be the one this role requires.
  -- Omitted = the caller asserts nothing (seed/tests) and the required length is recorded.
  if p_pin_length is not null and p_pin_length is distinct from v_len then
    perform public.fn_err('pin_length_mismatch');
  end if;

  insert into public.profile_secrets (profile_id, restaurant_id, pin_hash, pin_length)
  values (p_profile_id, v_rid, extensions.crypt(p_pin_digest, extensions.gen_salt('bf', 10)), v_len)
  on conflict (profile_id) do update
    set pin_hash = excluded.pin_hash, pin_length = excluded.pin_length,
        failed_attempts = 0, locked_until = null, pin_changed_at = now();

  perform public.fn_write_audit('auth.pin_set', jsonb_build_object('profile_id', p_profile_id), v_rid);
end;
$$;
revoke all on function public.fn_set_user_pin(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.fn_set_user_pin(uuid, text, integer) to service_role;

-- ── role rename into/out of Cashier ─────────────────────────────────────────
create or replace function public.fn_role_rename_pin_reset()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if public.fn_pin_length_for_role_name(new.name) is distinct from public.fn_pin_length_for_role_name(old.name) then
    delete from public.profile_secrets ps using public.profiles p
    where p.id = ps.profile_id and p.role_id = new.id and p.restaurant_id = new.restaurant_id;
  end if;
  return new;
end;
$$;
revoke all on function public.fn_role_rename_pin_reset() from public, anon, authenticated;
create trigger trg_role_rename_pin_reset after update of name on public.roles
  for each row execute function public.fn_role_rename_pin_reset();

-- ── fn_prepare_staff_creation: also returns the role name (server-side lookup) so the Edge Function can apply the PIN rule ──
create or replace function public.fn_prepare_staff_creation(p_username text, p_role_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
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

-- ── fn_change_user_role: PIN length follows the role ────────────────────────
-- (body of 0018 + the pin_length block; see the marker comments)
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
  v_pin_reset boolean := false;
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
  -- PIN length follows the role (Cashier = 6 digits, others 4): a stored secret of the wrong length is destroyed,
  -- so the user cannot sign in until a PIN of the right length is issued
  if not v_to_admin and not v_rotation then
    with d as (delete from public.profile_secrets
    where profile_id = p_profile_id and restaurant_id = v_rid and pin_length <> public.fn_pin_length_for_role(p_role_id) returning 1)
    select exists (select 1 from d) into v_pin_reset;
  end if;
  update public.profiles
     set role_id = p_role_id,
         auth_method = case when v_to_admin then 'password' else 'pin' end,
         identity_rotation_pending = v_rotation
   where id = p_profile_id and restaurant_id = v_rid;

  perform public.fn_write_audit('user.role_changed', jsonb_build_object(
    'profile_id', p_profile_id, 'from_role_id', v_target.role_id, 'to_role_id', p_role_id,
    'auth_method', case when v_to_admin then 'password' else 'pin' end,
    'requires_identity_rotation', v_rotation, 'pin_reset_required', v_pin_reset));
  return jsonb_build_object('profile_id', p_profile_id, 'role_id', p_role_id, 'changed', true,
    'auth_method', case when v_to_admin then 'password' else 'pin' end,
    'requires_identity_rotation', v_rotation, 'pin_reset_required', v_pin_reset);
end;
$$;
revoke all on function public.fn_change_user_role(uuid, uuid), public.fn_prepare_staff_creation(text, uuid) from public, anon;
grant execute on function public.fn_change_user_role(uuid, uuid), public.fn_prepare_staff_creation(text, uuid) to authenticated;
