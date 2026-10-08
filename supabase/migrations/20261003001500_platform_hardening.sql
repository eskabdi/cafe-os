-- 0015  SM6 / M2 / M3: platform-admin hardening.
--
--  1. AUDIT. plans, subscriptions, platform_invoices and platform_admins are directly writable by platform super
--     admins (RLS + grants), so every INSERT/UPDATE/DELETE on them now appends to admin_audit_log through the
--     SECURITY DEFINER trigger fn_audit_admin_row (actor = auth.uid() when that is a platform admin, otherwise NULL =
--     service job). UPDATE rows carry only the changed columns. The RPCs (fn_suspend/reactivate/provision) still write
--     their own semantic rows, so one suspension produces the semantic row plus the status-change rows.
--  2. LAST SUPER ADMIN. The last active platform_super_admin cannot be deleted, deactivated or demoted (advisory-lock
--     serialised, so two super admins cannot remove each other concurrently). platform_admins.id is immutable and
--     the UPDATE grant no longer includes id (or created_at); INSERT is limited to id/full_name/role.
--  3. BILLING INTEGRITY. platform_invoices(restaurant_id, subscription_id) is now a COMPOSITE foreign key to
--     subscriptions(restaurant_id, id): an invoice can only reference its own tenant's subscription.
--  4. STATUS SYNC. restaurants.status is AUTHORITATIVE for access (every RLS helper reads it); subscriptions.status
--     is a mirror kept in step by triggers in both directions:
--       restaurants.status changes  -> subscriptions.status follows (fn_suspend/reactivate_tenant, provisioning, ops)
--       subscriptions.status changes -> restaurants.status follows, EXCEPT anything that enters or leaves
--                                       'suspended': that is only possible through fn_suspend_tenant /
--                                       fn_reactivate_tenant (reason + audit) and is refused here (use_suspend_rpc).
--  5. MFA. is_platform_admin() / is_platform_super_admin() additionally require fn_platform_mfa_satisfied():
--       true  when the JWT carries aal = 'aal2' (TOTP verified in this session), OR
--       true  when app.platform_mfa_required = 'off' AND the user has no VERIFIED MFA factor.
--     Default (GUC unset) = REQUIRED, which is the production posture. Local development / CI opt out with
--     `alter database postgres set app.platform_mfa_required = 'off'` (the pgTAP shim does; the demo seed's platform
--     admin has no factor). Opting out never lets an enrolled admin skip the second factor. Chosen over a JWT-only
--     check because it is testable in plain SQL (tests set request.jwt.claims.aal and the GUC) and fails closed.
--  6. STEP-UP for tenant admins on destructive RPCs: fn_require_step_up() (used by fn_change_user_role /
--     fn_update_role_permissions, migration 0018) refuses (mfa_required) when the caller has a verified factor but
--     is not aal2, and ALWAYS when app.tenant_admin_mfa_required = 'on'.

-- ── 5/6 MFA ─────────────────────────────────────────────────────────────────
create or replace function public.fn_platform_mfa_satisfied()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce((select auth.jwt()) ->> 'aal', '') = 'aal2'
      or (coalesce(current_setting('app.platform_mfa_required', true), 'on') = 'off'
          and not exists (select 1 from auth.mfa_factors f
                          where f.user_id = (select auth.uid()) and f.status = 'verified'))
$$;
-- internal: called by definer helpers / RPCs only
revoke all on function public.fn_platform_mfa_satisfied() from public, anon, authenticated;

create or replace function public.is_platform_admin()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.platform_admins a
    where a.id = (select auth.uid()) and a.is_active
  ) and (select public.fn_platform_mfa_satisfied())
$$;

create or replace function public.is_platform_super_admin()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.platform_admins a
    where a.id = (select auth.uid()) and a.is_active and a.role = 'platform_super_admin'
  ) and (select public.fn_platform_mfa_satisfied())
$$;

create or replace function public.fn_require_step_up()
returns void
language plpgsql stable security definer set search_path = ''
as $$
begin
  if coalesce((select auth.jwt()) ->> 'aal', '') = 'aal2' then return; end if;
  if exists (select 1 from auth.mfa_factors f where f.user_id = (select auth.uid()) and f.status = 'verified')
     or current_setting('app.tenant_admin_mfa_required', true) = 'on' then
    perform public.fn_err('mfa_required');
  end if;
end;
$$;
revoke all on function public.fn_require_step_up() from public, anon, authenticated;

-- ── 1 audit triggers ────────────────────────────────────────────────────────
create or replace function public.fn_audit_admin_row()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_admin uuid;
  v_old jsonb;
  v_new jsonb;
  v_row jsonb;
  v_keys text[];
begin
  if v_uid is not null and exists (select 1 from public.platform_admins a where a.id = v_uid) then
    v_admin := v_uid;
  end if;
  if tg_op = 'DELETE' then
    v_row := to_jsonb(old); v_old := v_row;
  elsif tg_op = 'INSERT' then
    v_row := to_jsonb(new); v_new := v_row;
  else
    v_old := to_jsonb(old) - 'updated_at';
    v_new := to_jsonb(new) - 'updated_at';
    v_row := v_new;
    select array_agg(k.key) into v_keys from jsonb_each(v_new) k where v_old -> k.key is distinct from k.value;
    if v_keys is null then return null; end if;
    select coalesce(jsonb_object_agg(k.key, k.value), '{}'::jsonb) into v_new from jsonb_each(v_new) k where k.key = any (v_keys);
    select coalesce(jsonb_object_agg(k.key, k.value), '{}'::jsonb) into v_old from jsonb_each(v_old) k where k.key = any (v_keys);
  end if;
  insert into public.admin_audit_log (platform_admin_id, restaurant_id, action, detail)
  values (v_admin, (v_row ->> 'restaurant_id')::uuid, tg_table_name || '.' || lower(tg_op),
          jsonb_build_object('record_id', v_row ->> 'id', 'old', v_old, 'new', v_new));
  return null;
end;
$$;
revoke all on function public.fn_audit_admin_row() from public, anon, authenticated;
create trigger trg_audit_admin after insert or update or delete on public.plans
  for each row execute function public.fn_audit_admin_row();
create trigger trg_audit_admin after insert or update or delete on public.subscriptions
  for each row execute function public.fn_audit_admin_row();
create trigger trg_audit_admin after insert or update or delete on public.platform_invoices
  for each row execute function public.fn_audit_admin_row();
create trigger trg_audit_admin after insert or update or delete on public.platform_admins
  for each row execute function public.fn_audit_admin_row();

-- ── 2 last super admin ──────────────────────────────────────────────────────
create or replace function public.fn_guard_last_platform_super_admin()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.id is distinct from old.id then
    perform public.fn_err('immutable_column', 'platform_admins.id');
  end if;
  if old.role = 'platform_super_admin' and old.is_active
     and (tg_op = 'DELETE' or not new.is_active or new.role is distinct from 'platform_super_admin') then
    perform pg_advisory_xact_lock(hashtextextended('cafeos.platform_super_admin', 0));
    if not exists (select 1 from public.platform_admins a
                   where a.id <> old.id and a.is_active and a.role = 'platform_super_admin') then
      perform public.fn_err('last_platform_super_admin');
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
revoke all on function public.fn_guard_last_platform_super_admin() from public, anon, authenticated;
create trigger trg_guard_last_super_admin before update or delete on public.platform_admins
  for each row execute function public.fn_guard_last_platform_super_admin();

revoke update, insert on public.platform_admins from authenticated;
grant update (full_name, role, is_active) on public.platform_admins to authenticated;
grant insert (id, full_name, role) on public.platform_admins to authenticated;

-- ── 3 composite FK ──────────────────────────────────────────────────────────
alter table public.subscriptions add constraint subscriptions_tenant_id_key unique (restaurant_id, id);
alter table public.platform_invoices drop constraint platform_invoices_subscription_id_fkey;
alter table public.platform_invoices add constraint platform_invoices_subscription_fk
  foreign key (restaurant_id, subscription_id) references public.subscriptions (restaurant_id, id) on delete restrict;

-- ── 4 status sync ───────────────────────────────────────────────────────────
create or replace function public.fn_subscription_status_guard()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_tenant_status text;
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then
    return new;
  end if;
  select r.status into v_tenant_status from public.restaurants r where r.id = new.restaurant_id;
  if tg_op = 'UPDATE'
     and (new.status = 'suspended' or old.status = 'suspended')
     and v_tenant_status is distinct from new.status then
    perform public.fn_err('use_suspend_rpc', 'suspension changes go through fn_suspend_tenant / fn_reactivate_tenant');
  end if;
  return new;
end;
$$;
revoke all on function public.fn_subscription_status_guard() from public, anon, authenticated;
create trigger trg_subscription_status_guard before insert or update of status on public.subscriptions
  for each row execute function public.fn_subscription_status_guard();

create or replace function public.fn_sync_status_from_subscription()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.status is distinct from old.status then
    update public.restaurants r set status = new.status
    where r.id = new.restaurant_id and r.status is distinct from new.status;
  end if;
  return null;
end;
$$;
revoke all on function public.fn_sync_status_from_subscription() from public, anon, authenticated;
create trigger trg_sync_status_from_subscription after update of status on public.subscriptions
  for each row execute function public.fn_sync_status_from_subscription();

create or replace function public.fn_sync_subscription_from_restaurant()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.status is distinct from old.status then
    update public.subscriptions s set status = new.status
    where s.restaurant_id = new.id and s.status is distinct from new.status;
  end if;
  return null;
end;
$$;
revoke all on function public.fn_sync_subscription_from_restaurant() from public, anon, authenticated;
create trigger trg_sync_subscription_from_restaurant after update of status on public.restaurants
  for each row execute function public.fn_sync_subscription_from_restaurant();
