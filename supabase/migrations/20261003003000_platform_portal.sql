-- 0030  Phase 3B (part 1): Platform Admin Portal, database layer (execution prompt §34A, Phase 3B)
--
--  Actor: platform_super_admin (table platform_admins, Supabase Auth email + password + TOTP, never PIN, never a tenant profile).
--
--  1. GUARD. fn_platform_guard() is the single gate of every platform RPC: an ACTIVE platform_super_admin AND a JWT with
--     aal = 'aal2' AND a verified MFA factor that the account still owns (same predicate as fn_require_aal2, 0028). No GUC opt-out:
--     app.platform_mfa_required = 'off' (local demo) still relaxes the RLS helper is_platform_admin() for reads, never a platform
--     command. Errors: not_authenticated | permission_denied (anyone who is not an active super admin, including every tenant user)
--     | mfa_required. fn_suspend_tenant / fn_reactivate_tenant / fn_provision_tenant (platform path) now use it too.
--     fn_platform_mfa_satisfied() additionally requires a verified factor behind an aal2 claim (a token outliving its factor no
--     longer satisfies the read helpers either).
--  2. WRITE PATH. plans, subscriptions, platform_invoices and platform_admins lose every client INSERT / UPDATE / DELETE privilege:
--     the platform RPCs below are the only client write path (aal2 + semantic admin_audit_log rows on top of the 0015 row triggers).
--     SELECT under the 0007 policies stays. service_role (billing webhook, ops) keeps its table privileges.
--  3. PLANS. New quota columns (NULL = unlimited): max_stations, max_kiosks, max_storage_bytes, max_orders_per_month; plus
--     description and sort_order. Catalogue CRUD: fn_platform_create_plan / _update_plan / _set_plan_active / _list_plans. No delete
--     (subscriptions reference plans ON DELETE RESTRICT): deactivate instead.
--  4. TENANTS. fn_platform_list_tenants (search / status / plan, offset paging), fn_platform_get_tenant (metadata, subscription,
--     plan limits, AGGREGATE usage counters vs quotas, invitations, latest invoices; never an operational row),
--     fn_platform_create_tenant (provisioning WITHOUT an owner: the first Tenant Admin is invited, see 5), fn_platform_change_plan,
--     fn_platform_set_billing_status (trialing / active / past_due), fn_platform_cancel_tenant (terminal; slug confirmation).
--  5. TENANT ADMIN INVITATIONS. Table tenant_admin_invitations (deny-all to clients; RPC access only). The tenant-admin-invite
--     Edge Function (service role confined there) runs: fn_prepare_tenant_admin_invitation AS THE CALLER (platform super admin for a
--     named tenant, or the tenant's own tenant_admin on aal2) -> auth.admin.inviteUserByEmail (service role) ->
--     fn_attach_tenant_admin_invitation (service role) / fn_abort_tenant_admin_invitation on failure. The invitee, signed in from
--     the e-mail link (confirmed e-mail), calls fn_accept_tenant_admin_invitation(): THAT binds the auth user as the tenant's
--     tenant_admin profile (auth_method 'password', no PIN). Resend and revoke are caller RPCs (rate limited, audited).
--  6. INVOICES. fn_platform_list_invoices (keyset), fn_platform_create_invoice, fn_platform_set_invoice_status.
--  7. HEALTH + BACKUPS. fn_platform_system_health() (DB-side checks only; the portal pings Edge Functions itself). Table
--     platform_backup_runs (written ONLY by service_role: the ops backup job; Supabase PITR / daily backups are managed by
--     Supabase and recorded by the same job) + fn_platform_list_backup_runs.
--  8. AUDIT + ACCOUNTS. fn_platform_list_audit_log (keyset on (created_at, id)), fn_platform_list_admins,
--     fn_platform_set_admin_active (0015 last-super-admin guard applies), fn_ops_register_platform_admin (service_role ONLY:
--     adding a Super Admin is an ops procedure, docs/architecture/auth-flows.md).
--  9. IDENTITY DISJOINTNESS RACE. The profiles <-> platform_admins guards both take the same per-user advisory lock before their
--     check, so two concurrent transactions can no longer make one auth user both a tenant profile and a platform admin.
--
--  Platform RPCs accept a restaurant_id (they act on a named tenant); tenant RPCs never do. Every platform write appends a
--  semantic row to admin_audit_log (actor = the super admin) and, when it concerns a tenant, an audit_logs event of that tenant
--  (actor_type platform_admin).

-- ════════════════════════════════════════ 1. guard ════════════════════════════════════════
create or replace function public.fn_platform_mfa_satisfied()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select (coalesce((select auth.jwt()) ->> 'aal', '') = 'aal2'
          and exists (select 1 from auth.mfa_factors f where f.user_id = (select auth.uid()) and f.status = 'verified'))
      or (coalesce(current_setting('app.platform_mfa_required', true), 'on') = 'off'
          and not exists (select 1 from auth.mfa_factors f
                          where f.user_id = (select auth.uid()) and f.status = 'verified'))
$$;
revoke all on function public.fn_platform_mfa_satisfied() from public, anon, authenticated;

create or replace function public.fn_platform_guard()
returns uuid
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then perform public.fn_err('not_authenticated'); end if;
  if not exists (select 1 from public.platform_admins a
                 where a.id = v_uid and a.is_active and a.role = 'platform_super_admin') then
    perform public.fn_err('permission_denied');
  end if;
  if coalesce((select auth.jwt()) ->> 'aal', '') <> 'aal2'
     or not exists (select 1 from auth.mfa_factors f where f.user_id = v_uid and f.status = 'verified') then
    perform public.fn_err('mfa_required');
  end if;
  return v_uid;
end;
$$;
revoke all on function public.fn_platform_guard() from public, anon, authenticated;

-- ════════════════════════════════════════ 9. identity disjointness (race) ════════════════════════════════════════
create or replace function public.fn_identity_lock(p_user_id uuid)
returns void
language sql volatile set search_path = ''
as $$ select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('cafeos.identity:' || p_user_id::text, 0)) $$;
revoke all on function public.fn_identity_lock(uuid) from public, anon, authenticated;

create or replace function public.fn_guard_platform_admin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.fn_identity_lock(new.id);
  if exists (select 1 from public.profiles p where p.id = new.id) then
    perform public.fn_err('auth_method_mismatch', 'tenant staff cannot become platform admins');
  end if;
  return new;
end;
$$;
revoke all on function public.fn_guard_platform_admin() from public, anon, authenticated;

create or replace function public.fn_guard_profile_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.fn_identity_lock(new.id);
  if exists (select 1 from public.platform_admins a where a.id = new.id) then
    perform public.fn_err('auth_method_mismatch', 'platform admins cannot hold a tenant profile');
  end if;
  return new;
end;
$$;
revoke all on function public.fn_guard_profile_identity() from public, anon, authenticated;
-- sorts before trg_guard_profile_auth_method: the lock is held before the older check runs
create trigger trg_00_identity_disjoint before insert or update of id on public.profiles
  for each row execute function public.fn_guard_profile_identity();

-- ════════════════════════════════════════ 2. platform tables: RPC-only writes ════════════════════════════════════════
revoke insert, update, delete on public.plans, public.subscriptions, public.platform_invoices from authenticated;
revoke insert, update, delete on public.platform_admins from authenticated;

-- ════════════════════════════════════════ 3. plans: quota columns ════════════════════════════════════════
alter table public.plans
  add column description          text check (description is null or char_length(description) <= 300),
  add column max_stations         integer check (max_stations is null or max_stations > 0),
  add column max_kiosks           integer check (max_kiosks is null or max_kiosks > 0),
  add column max_storage_bytes    bigint  check (max_storage_bytes is null or max_storage_bytes > 0),
  add column max_orders_per_month integer check (max_orders_per_month is null or max_orders_per_month > 0),
  add column sort_order           integer not null default 0;

-- ── small validators (internal) ─────────────────────────────────────────────
-- positive integer (<= p_max) or null; anything else is invalid_input with the key as detail
create or replace function public.fn_json_pos_int(p_obj jsonb, p_key text, p_max bigint)
returns bigint
language plpgsql immutable set search_path = ''
as $$
declare
  v jsonb := p_obj -> p_key;
  n numeric;
begin
  if v is null or jsonb_typeof(v) = 'null' then return null; end if;
  if jsonb_typeof(v) <> 'number' then perform public.fn_err('invalid_input', p_key); end if;
  n := (v #>> '{}')::numeric;
  if n <> trunc(n) or n < 1 or n > p_max then perform public.fn_err('invalid_input', p_key); end if;
  return n::bigint;
end;
$$;
revoke all on function public.fn_json_pos_int(jsonb, text, bigint) from public, anon, authenticated;

-- non-blank text of at most p_max chars (trimmed) or null when p_nullable; else invalid_input / key
create or replace function public.fn_json_text(p_obj jsonb, p_key text, p_max integer, p_nullable boolean)
returns text
language plpgsql immutable set search_path = ''
as $$
declare
  v jsonb := p_obj -> p_key;
  t text;
begin
  if v is null or jsonb_typeof(v) = 'null' then
    if p_nullable then return null; end if;
    perform public.fn_err('invalid_input', p_key);
  end if;
  if jsonb_typeof(v) <> 'string' then perform public.fn_err('invalid_input', p_key); end if;
  t := btrim(v #>> '{}');
  if t = '' then
    if p_nullable then return null; end if;
    perform public.fn_err('invalid_input', p_key);
  end if;
  if char_length(t) > p_max then perform public.fn_err('invalid_input', p_key); end if;
  return t;
end;
$$;
revoke all on function public.fn_json_text(jsonb, text, integer, boolean) from public, anon, authenticated;

-- money: number >= 0, <= p_max, at most 2 decimals (never rounded silently)
create or replace function public.fn_json_money(p_obj jsonb, p_key text, p_max numeric)
returns numeric
language plpgsql immutable set search_path = ''
as $$
declare
  v jsonb := p_obj -> p_key;
  n numeric;
begin
  if v is null or jsonb_typeof(v) <> 'number' then perform public.fn_err('invalid_input', p_key); end if;
  n := (v #>> '{}')::numeric;
  if n < 0 or n > p_max or n <> round(n, 2) then perform public.fn_err('invalid_input', p_key); end if;
  return n;
end;
$$;
revoke all on function public.fn_json_money(jsonb, text, numeric) from public, anon, authenticated;

-- a patch object whose keys are all in p_allowed (closed key list); invalid_input / patch otherwise
create or replace function public.fn_check_patch(p_patch jsonb, p_allowed text[])
returns void
language plpgsql immutable set search_path = ''
as $$
begin
  if p_patch is null or jsonb_typeof(p_patch) <> 'object'
     or exists (select 1 from jsonb_object_keys(p_patch) k where k <> all (p_allowed)) then
    perform public.fn_err('invalid_input', 'patch');
  end if;
end;
$$;
revoke all on function public.fn_check_patch(jsonb, text[]) from public, anon, authenticated;

-- reason text for platform state changes: 3..500 chars
create or replace function public.fn_platform_reason(p_reason text)
returns text
language plpgsql immutable set search_path = ''
as $$
declare
  v text := btrim(coalesce(p_reason, ''));
begin
  if char_length(v) not between 3 and 500 then perform public.fn_err('invalid_input', 'reason'); end if;
  return v;
end;
$$;
revoke all on function public.fn_platform_reason(text) from public, anon, authenticated;

-- ════════════════════════════════════════ usage counters (internal) ════════════════════════════════════════
-- AGGREGATES ONLY: counts and byte sums of one tenant. Never a row, a name or an id of an operational record.
create or replace function public.fn_tenant_usage(p_rid uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_tz text;
  v_usage jsonb;
  v_limits jsonb;
  v_over jsonb;
begin
  select r.timezone into v_tz from public.restaurants r where r.id = p_rid;
  if not found then perform public.fn_err('not_found'); end if;

  select jsonb_build_object(
    'active_staff',        (select count(*) from public.profiles p where p.restaurant_id = p_rid and p.is_active),
    'active_tenant_admins', (select count(*) from public.profiles p join public.roles ro on ro.id = p.role_id and ro.restaurant_id = p.restaurant_id
                            where p.restaurant_id = p_rid and p.is_active and ro.system_key = 'tenant_admin'),
    'menu_items',          (select count(*) from public.menu_items m where m.restaurant_id = p_rid and m.is_active),
    'stations',            (select count(*) from public.stations s where s.restaurant_id = p_rid and s.is_active),
    'kiosks',              (select count(*) from public.kiosk_devices k where k.restaurant_id = p_rid and k.revoked_at is null),
    'storage_bytes',       (select coalesce(sum(case when (o.metadata ->> 'size') ~ '^[0-9]{1,18}$' then (o.metadata ->> 'size')::bigint else 0 end), 0)
                            from storage.objects o where starts_with(o.name, 'restaurants/' || p_rid::text || '/')),
    'storage_objects',     (select count(*) from storage.objects o where starts_with(o.name, 'restaurants/' || p_rid::text || '/')),
    'orders_last_30_days', (select count(*) from public.orders o where o.restaurant_id = p_rid and o.created_at >= now() - interval '30 days'),
    'orders_this_month',   (select count(*) from public.orders o where o.restaurant_id = p_rid
                            and o.created_at >= (date_trunc('month', now() at time zone v_tz) at time zone v_tz)),
    'pending_invitations', (select count(*) from public.tenant_admin_invitations i where i.restaurant_id = p_rid and i.status = 'pending')
  ) into v_usage;

  select jsonb_build_object(
    'max_staff', pl.max_staff, 'max_menu_items', pl.max_menu_items, 'max_stations', pl.max_stations,
    'max_kiosks', pl.max_kiosks, 'max_storage_bytes', pl.max_storage_bytes, 'max_orders_per_month', pl.max_orders_per_month)
    into v_limits
  from public.subscriptions s join public.plans pl on pl.id = s.plan_id where s.restaurant_id = p_rid;
  v_limits := coalesce(v_limits, '{}'::jsonb);

  select coalesce(jsonb_agg(m.metric order by m.metric), '[]'::jsonb) into v_over
  from (values ('staff', 'active_staff', 'max_staff'), ('menu_items', 'menu_items', 'max_menu_items'),
               ('stations', 'stations', 'max_stations'), ('kiosks', 'kiosks', 'max_kiosks'),
               ('storage', 'storage_bytes', 'max_storage_bytes'), ('orders', 'orders_this_month', 'max_orders_per_month')) m(metric, used, lim)
  where jsonb_typeof(v_limits -> m.lim) = 'number' and (v_usage ->> m.used)::numeric > (v_limits ->> m.lim)::numeric;

  return jsonb_build_object('usage', v_usage, 'limits', v_limits, 'over_quota', v_over);
end;
$$;
revoke all on function public.fn_tenant_usage(uuid) from public, anon, authenticated;

-- ════════════════════════════════════════ 5. invitations: table ════════════════════════════════════════
create table public.tenant_admin_invitations (
  id               uuid primary key default gen_random_uuid(),
  restaurant_id    uuid not null references public.restaurants(id) on delete restrict,
  email            text not null check (char_length(email) <= 254 and email = lower(email)
                                        and email ~ '^[^@\s]+@[^@\s]+\.[a-z]{2,}$' and email !~ '\.invalid$'),
  first_name       text not null check (char_length(btrim(first_name)) between 1 and 60),
  middle_name      text check (middle_name is null or char_length(btrim(middle_name)) between 1 and 60),
  last_name        text check (last_name is null or char_length(btrim(last_name)) between 1 and 60),
  username         text not null check (username ~ '^[a-z0-9][a-z0-9._-]{1,31}$'),
  auth_user_id     uuid,                 -- set by fn_attach_tenant_admin_invitation once Auth created the invited user
  status           text not null default 'pending' check (status in ('pending', 'accepted', 'revoked')),
  invited_by       uuid not null,        -- auth.uid() of the inviter; deliberately no FK (platform admin OR tenant profile)
  invited_by_type  text not null check (invited_by_type in ('platform_admin', 'tenant_admin')),
  expires_at       timestamptz not null,
  send_count       integer not null default 1 check (send_count between 0 and 100),
  last_sent_at     timestamptz not null default now(),
  accepted_at      timestamptz,
  revoked_at       timestamptz,
  revoked_by       uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint tenant_admin_invitations_tenant_id_key unique (restaurant_id, id),
  constraint tenant_admin_invitations_accepted_check check ((status = 'accepted') = (accepted_at is not null)),
  constraint tenant_admin_invitations_revoked_check check ((status = 'revoked') = (revoked_at is not null)),
  constraint tenant_admin_invitations_accepted_user_check check (status <> 'accepted' or auth_user_id is not null)
);
-- an e-mail can be invited by ONE pending invitation platform-wide (an auth user belongs to one tenant at most)
create unique index tenant_admin_invitations_pending_email_idx on public.tenant_admin_invitations (email) where status = 'pending';
create unique index tenant_admin_invitations_pending_user_idx on public.tenant_admin_invitations (auth_user_id)
  where status = 'pending' and auth_user_id is not null;
create unique index tenant_admin_invitations_pending_username_idx on public.tenant_admin_invitations (restaurant_id, username)
  where status = 'pending';
create index tenant_admin_invitations_tenant_idx on public.tenant_admin_invitations (restaurant_id, created_at desc);

alter table public.tenant_admin_invitations enable row level security;
alter table public.tenant_admin_invitations force row level security;
-- NO policies and NO client privileges: read and written only by the definer RPCs below (and service_role).
revoke all on public.tenant_admin_invitations from public, anon, authenticated, service_role;
grant select, insert, update on public.tenant_admin_invitations to service_role;
create trigger trg_set_updated_at before update on public.tenant_admin_invitations
  for each row execute function public.fn_set_updated_at();
create trigger trg_lock_restaurant_id before update on public.tenant_admin_invitations
  for each row execute function public.fn_lock_restaurant_id();
create trigger trg_00_no_delete before delete on public.tenant_admin_invitations
  for each row execute function public.fn_forbid_mutation();

-- ════════════════════════════════════════ 7. backups: table ════════════════════════════════════════
create table public.platform_backup_runs (
  id               uuid primary key default gen_random_uuid(),
  kind             text not null check (kind in ('supabase_daily', 'supabase_pitr', 'logical_dump', 'storage_copy', 'restore_drill')),
  status           text not null default 'running' check (status in ('running', 'succeeded', 'failed')),
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  size_bytes       bigint check (size_bytes is null or size_bytes >= 0),
  location         text check (location is null or (char_length(location) <= 300 and location !~ '[?#@]')),  -- no query strings / credentials
  checksum_sha256  text check (checksum_sha256 is null or checksum_sha256 ~ '^[0-9a-f]{64}$'),
  error_code       text check (error_code is null or error_code ~ '^[a-z0-9_.-]{1,80}$'),
  note             text check (note is null or char_length(note) <= 500),
  created_at       timestamptz not null default now(),
  constraint platform_backup_runs_finished_check check ((status = 'running') = (finished_at is null)),
  constraint platform_backup_runs_order_check check (finished_at is null or finished_at >= started_at),
  constraint platform_backup_runs_error_check check (status = 'failed' or error_code is null)
);
create index platform_backup_runs_started_idx on public.platform_backup_runs (started_at desc, id desc);
create index platform_backup_runs_success_idx on public.platform_backup_runs (finished_at desc) where status = 'succeeded';
alter table public.platform_backup_runs enable row level security;
alter table public.platform_backup_runs force row level security;
revoke all on public.platform_backup_runs from public, anon, authenticated, service_role;
-- the ops backup job (service role) is the ONLY writer; a finished run is immutable, nothing is ever deleted
grant select, insert on public.platform_backup_runs to service_role;
grant update (status, finished_at, size_bytes, location, checksum_sha256, error_code, note) on public.platform_backup_runs to service_role;

create or replace function public.fn_guard_backup_run()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then perform public.fn_err('immutable_record', 'backup runs are never deleted'); end if;
  if old.status <> 'running' then perform public.fn_err('immutable_record', 'a finished backup run is immutable'); end if;
  if new.kind is distinct from old.kind or new.started_at is distinct from old.started_at or new.id is distinct from old.id then
    perform public.fn_err('immutable_column', 'kind/started_at');
  end if;
  return new;
end;
$$;
revoke all on function public.fn_guard_backup_run() from public, anon, authenticated;
create trigger trg_guard_backup_run before update or delete on public.platform_backup_runs
  for each row execute function public.fn_guard_backup_run();
create trigger trg_audit_admin after insert or update on public.platform_backup_runs
  for each row execute function public.fn_audit_admin_row();

create index admin_audit_log_keyset_idx on public.admin_audit_log (created_at desc, id desc);

-- ════════════════════════════════════════ existing platform RPCs: strict guard ════════════════════════════════════════
create or replace function public.fn_suspend_tenant(p_restaurant_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_reason text;
begin
  perform public.fn_platform_guard();
  v_reason := public.fn_platform_reason(p_reason);

  select r.status into v_status from public.restaurants r where r.id = p_restaurant_id for update;
  if not found then perform public.fn_err('not_found'); end if;
  if v_status = 'suspended' then
    return jsonb_build_object('restaurant_id', p_restaurant_id, 'status', 'suspended', 'changed', false);
  end if;
  if v_status = 'cancelled' then perform public.fn_err('invalid_state', 'cancelled'); end if;

  update public.restaurants
     set status = 'suspended', status_before_suspension = v_status,
         suspended_at = now(), suspension_reason = v_reason
   where id = p_restaurant_id;
  update public.subscriptions set status = 'suspended' where restaurant_id = p_restaurant_id;

  perform public.fn_write_admin_audit('tenant.suspend', p_restaurant_id,
    jsonb_build_object('reason', v_reason, 'previous_status', v_status));
  perform public.fn_write_audit('tenant.suspended', jsonb_build_object('reason', v_reason), p_restaurant_id);
  return jsonb_build_object('restaurant_id', p_restaurant_id, 'status', 'suspended', 'changed', true);
end;
$$;

create or replace function public.fn_reactivate_tenant(p_restaurant_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_prev text;
  v_reason text;
begin
  perform public.fn_platform_guard();
  v_reason := public.fn_platform_reason(p_reason);

  select r.status, coalesce(r.status_before_suspension, 'active') into v_status, v_prev
  from public.restaurants r where r.id = p_restaurant_id for update;
  if not found then perform public.fn_err('not_found'); end if;
  if v_status <> 'suspended' then perform public.fn_err('invalid_state', v_status); end if;

  update public.restaurants
     set status = v_prev, status_before_suspension = null, suspended_at = null, suspension_reason = null
   where id = p_restaurant_id;
  update public.subscriptions set status = v_prev where restaurant_id = p_restaurant_id;

  perform public.fn_write_admin_audit('tenant.reactivate', p_restaurant_id,
    jsonb_build_object('reason', v_reason, 'restored_status', v_prev));
  perform public.fn_write_audit('tenant.reactivated', jsonb_build_object('reason', v_reason), p_restaurant_id);
  return jsonb_build_object('restaurant_id', p_restaurant_id, 'status', v_prev, 'changed', true);
end;
$$;

-- fn_provision_tenant (0018 body): the platform path now needs fn_platform_guard (aal2); service_role unchanged.
create or replace function public.fn_provision_tenant(
  p_name text,
  p_slug text,
  p_owner_user_id uuid,
  p_owner_email text,
  p_owner_first_name text,
  p_owner_middle_name text,
  p_owner_last_name text,
  p_plan_id uuid,
  p_owner_username text default null,
  p_require_confirmed boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_slug text := lower(btrim(coalesce(p_slug, '')));
  v_name text := btrim(coalesce(p_name, ''));
  v_first text := btrim(coalesce(p_owner_first_name, ''));
  v_username text;
  v_rid uuid;
  v_seed jsonb;
  v_day uuid;
  v_float numeric(12,2);
begin
  if not public.is_service_role() then
    perform public.fn_platform_guard();
  end if;
  -- only service flows (local seed, CI) may skip the email-confirmation check
  if not coalesce(p_require_confirmed, true) and not public.is_service_role() then
    perform public.fn_err('permission_denied');
  end if;

  if char_length(v_name) not between 1 and 120 then perform public.fn_err('invalid_input', 'name'); end if;
  if v_slug !~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$' or v_slug ~ '--' or public.fn_slug_is_reserved(v_slug) then
    perform public.fn_err('invalid_slug');
  end if;
  if char_length(v_first) not between 1 and 60 then perform public.fn_err('invalid_input', 'owner_first_name'); end if;
  if p_owner_user_id is null then perform public.fn_err('invalid_input', 'owner_user_id'); end if;

  v_username := lower(coalesce(nullif(btrim(p_owner_username), ''),
                               nullif(regexp_replace(v_first, '[^A-Za-z0-9]', '', 'g'), ''),
                               'owner'));
  if v_username !~ '^[a-z0-9][a-z0-9._-]{1,31}$' then perform public.fn_err('invalid_input', 'owner_username'); end if;

  if not exists (select 1 from auth.users u where u.id = p_owner_user_id) then
    perform public.fn_err('owner_not_found');
  end if;
  if p_owner_email is null or p_owner_email !~* '^[^@\s]+@[^@\s]+\.[a-z]{2,}$' or p_owner_email ~* '\.invalid$'
     or not exists (select 1 from auth.users u where u.id = p_owner_user_id and lower(u.email) = lower(btrim(p_owner_email))) then
    perform public.fn_err('owner_email_mismatch');
  end if;
  if coalesce(p_require_confirmed, true)
     and not exists (select 1 from auth.users u where u.id = p_owner_user_id and u.email_confirmed_at is not null) then
    perform public.fn_err('owner_email_unconfirmed');
  end if;
  if exists (select 1 from public.profiles p where p.id = p_owner_user_id)
     or exists (select 1 from public.platform_admins a where a.id = p_owner_user_id) then
    perform public.fn_err('owner_already_assigned');
  end if;
  if not exists (select 1 from public.plans pl where pl.id = p_plan_id and pl.is_active) then
    perform public.fn_err('invalid_plan');
  end if;
  if exists (select 1 from public.restaurants r where r.slug = v_slug) then
    perform public.fn_err('slug_taken');
  end if;

  begin
    insert into public.restaurants (name, slug, status, onboarded_at)
    values (v_name, v_slug, 'trialing', now())
    returning id, opening_float into v_rid, v_float;
  exception when unique_violation then
    perform public.fn_err('slug_taken');
  end;

  insert into public.subscriptions (restaurant_id, plan_id, status, trial_ends_at, current_period_start, current_period_end)
  values (v_rid, p_plan_id, 'trialing', now() + interval '14 days', now(), now() + interval '14 days');

  v_seed := public.fn_seed_tenant_defaults(v_rid);

  insert into public.profiles (id, restaurant_id, first_name, middle_name, last_name, username, role_id, auth_method)
  values (p_owner_user_id, v_rid, v_first,
          nullif(btrim(p_owner_middle_name), ''), nullif(btrim(p_owner_last_name), ''),
          v_username, (v_seed ->> 'admin_role_id')::uuid, 'password');

  insert into public.day_sessions (restaurant_id, day_no, status, opening_float, opened_by)
  values (v_rid, 1, 'open', v_float, p_owner_user_id)
  returning id into v_day;

  perform public.fn_write_audit('tenant.provisioned',
    jsonb_build_object('slug', v_slug, 'plan_id', p_plan_id, 'owner_profile_id', p_owner_user_id), v_rid);
  perform public.fn_write_admin_audit('tenant.provision', v_rid,
    jsonb_build_object('slug', v_slug, 'plan_id', p_plan_id));

  return jsonb_build_object(
    'restaurant_id', v_rid, 'slug', v_slug, 'owner_profile_id', p_owner_user_id,
    'admin_role_id', v_seed ->> 'admin_role_id', 'day_session_id', v_day);
end;
$$;
revoke all on function public.fn_provision_tenant(text, text, uuid, text, text, text, text, uuid, text, boolean) from public, anon;
grant execute on function public.fn_provision_tenant(text, text, uuid, text, text, text, text, uuid, text, boolean)
  to authenticated, service_role;

-- ════════════════════════════════════════ 4. tenants ════════════════════════════════════════
-- tenant METADATA (no vat / float / auto-consume settings, no operational data)
create or replace function public.fn_platform_tenant_json(p_rid uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'id', r.id, 'name', r.name, 'slug', r.slug, 'status', r.status, 'custom_domain', r.custom_domain,
    'timezone', r.timezone, 'phone', r.phone, 'address', r.address, 'tin', r.tin,
    'onboarded_at', r.onboarded_at, 'suspended_at', r.suspended_at, 'suspension_reason', r.suspension_reason,
    'created_at', r.created_at, 'updated_at', r.updated_at,
    'subscription', (select jsonb_build_object('id', s.id, 'status', s.status, 'trial_ends_at', s.trial_ends_at,
                                                'current_period_start', s.current_period_start, 'current_period_end', s.current_period_end,
                                                'cancel_at_period_end', s.cancel_at_period_end,
                                                'plan', jsonb_build_object('id', pl.id, 'name', pl.name, 'price_etb_monthly', pl.price_etb_monthly,
                                                                           'is_active', pl.is_active))
                     from public.subscriptions s join public.plans pl on pl.id = s.plan_id where s.restaurant_id = r.id))
  from public.restaurants r where r.id = p_rid
$$;
revoke all on function public.fn_platform_tenant_json(uuid) from public, anon, authenticated;

create or replace function public.fn_platform_list_tenants(
  p_search text default null,
  p_status text default null,
  p_plan_id uuid default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_like text;
  v_total bigint;
  v_items jsonb;
begin
  perform public.fn_platform_guard();
  if v_search is not null and char_length(v_search) > 100 then perform public.fn_err('invalid_input', 'search'); end if;
  if p_status is not null and p_status not in ('trialing', 'active', 'past_due', 'suspended', 'cancelled') then
    perform public.fn_err('invalid_input', 'status');
  end if;
  if p_limit is null or p_limit not between 1 and 100 then perform public.fn_err('invalid_input', 'limit'); end if;
  if p_offset is null or p_offset not between 0 and 100000 then perform public.fn_err('invalid_input', 'offset'); end if;
  v_like := case when v_search is null then null
                 else '%' || replace(replace(replace(lower(v_search), '\', '\\'), '%', '\%'), '_', '\_') || '%' end;

  select count(*) into v_total
  from public.restaurants r left join public.subscriptions s on s.restaurant_id = r.id
  where (v_like is null or lower(r.name) like v_like or r.slug like v_like)
    and (p_status is null or r.status = p_status)
    and (p_plan_id is null or s.plan_id = p_plan_id);

  select coalesce(jsonb_agg(t.j order by t.created_at desc, t.id desc), '[]'::jsonb) into v_items
  from (
    select r.id, r.created_at,
           jsonb_build_object('id', r.id, 'name', r.name, 'slug', r.slug, 'status', r.status, 'created_at', r.created_at,
                              'suspended_at', r.suspended_at,
                              'plan', case when pl.id is null then null else jsonb_build_object('id', pl.id, 'name', pl.name) end,
                              'subscription_status', s.status, 'trial_ends_at', s.trial_ends_at,
                              'current_period_end', s.current_period_end) j
    from public.restaurants r
    left join public.subscriptions s on s.restaurant_id = r.id
    left join public.plans pl on pl.id = s.plan_id
    where (v_like is null or lower(r.name) like v_like or r.slug like v_like)
      and (p_status is null or r.status = p_status)
      and (p_plan_id is null or s.plan_id = p_plan_id)
    order by r.created_at desc, r.id desc
    limit p_limit offset p_offset
  ) t;

  return jsonb_build_object('total', v_total, 'limit', p_limit, 'offset', p_offset, 'items', v_items);
end;
$$;

create or replace function public.fn_platform_get_tenant(p_restaurant_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v jsonb;
begin
  perform public.fn_platform_guard();
  if p_restaurant_id is null then perform public.fn_err('invalid_input', 'restaurant_id'); end if;
  v := public.fn_platform_tenant_json(p_restaurant_id);
  if v is null then perform public.fn_err('not_found'); end if;
  return v || public.fn_tenant_usage(p_restaurant_id) || jsonb_build_object(
    'invitations', (select coalesce(jsonb_agg(jsonb_build_object(
                       'id', i.id, 'email', i.email, 'status', i.status,
                       'state', case when i.status = 'pending' and i.expires_at <= now() then 'expired' else i.status end,
                       'invited_by_type', i.invited_by_type, 'expires_at', i.expires_at, 'send_count', i.send_count,
                       'last_sent_at', i.last_sent_at, 'accepted_at', i.accepted_at, 'revoked_at', i.revoked_at,
                       'created_at', i.created_at) order by i.created_at desc), '[]'::jsonb)
                    from (select * from public.tenant_admin_invitations x where x.restaurant_id = p_restaurant_id
                          order by x.created_at desc limit 20) i),
    'recent_invoices', (select coalesce(jsonb_agg(jsonb_build_object(
                           'id', iv.id, 'amount', iv.amount, 'period_start', iv.period_start, 'period_end', iv.period_end,
                           'status', iv.status, 'paid_at', iv.paid_at, 'created_at', iv.created_at) order by iv.created_at desc), '[]'::jsonb)
                        from (select * from public.platform_invoices x where x.restaurant_id = p_restaurant_id
                              order by x.created_at desc limit 5) iv));
end;
$$;

-- Provisioning without an owner: restaurant + trial subscription + default configuration rows + day 1. The first Tenant Admin is
-- invited (tenant-admin-invite) and bound when they accept. Retrying with the same slug answers slug_taken (no double tenant).
create or replace function public.fn_platform_create_tenant(
  p_name text,
  p_slug text,
  p_plan_id uuid,
  p_trial_days integer default 14,
  p_timezone text default 'Africa/Addis_Ababa'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_slug text := lower(btrim(coalesce(p_slug, '')));
  v_name text := btrim(coalesce(p_name, ''));
  v_tz text := btrim(coalesce(p_timezone, ''));
  v_rid uuid;
  v_seed jsonb;
  v_day uuid;
  v_float numeric(12,2);
begin
  perform public.fn_platform_guard();
  if char_length(v_name) not between 1 and 120 then perform public.fn_err('invalid_input', 'name'); end if;
  if v_slug !~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$' or v_slug ~ '--' or public.fn_slug_is_reserved(v_slug) then
    perform public.fn_err('invalid_slug');
  end if;
  if p_trial_days is null or p_trial_days not between 0 and 90 then perform public.fn_err('invalid_input', 'trial_days'); end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = v_tz) then perform public.fn_err('invalid_timezone'); end if;
  if p_plan_id is null or not exists (select 1 from public.plans pl where pl.id = p_plan_id and pl.is_active) then
    perform public.fn_err('invalid_plan');
  end if;
  if exists (select 1 from public.restaurants r where r.slug = v_slug) then perform public.fn_err('slug_taken'); end if;

  begin
    insert into public.restaurants (name, slug, status, timezone, onboarded_at)
    values (v_name, v_slug, case when p_trial_days > 0 then 'trialing' else 'active' end, v_tz, now())
    returning id, opening_float into v_rid, v_float;
  exception when unique_violation then
    perform public.fn_err('slug_taken');
  end;

  insert into public.subscriptions (restaurant_id, plan_id, status, trial_ends_at, current_period_start, current_period_end)
  values (v_rid, p_plan_id, case when p_trial_days > 0 then 'trialing' else 'active' end,
          case when p_trial_days > 0 then now() + make_interval(days => p_trial_days) end,
          now(), now() + make_interval(days => greatest(p_trial_days, 30)));

  v_seed := public.fn_seed_tenant_defaults(v_rid);

  insert into public.day_sessions (restaurant_id, day_no, status, opening_float, opened_by)
  values (v_rid, 1, 'open', v_float, null)
  returning id into v_day;

  perform public.fn_write_audit('tenant.provisioned', jsonb_build_object('slug', v_slug, 'plan_id', p_plan_id, 'owner_profile_id', null), v_rid);
  perform public.fn_write_admin_audit('tenant.provision', v_rid,
    jsonb_build_object('slug', v_slug, 'plan_id', p_plan_id, 'trial_days', p_trial_days, 'owner', 'invitation'));

  return jsonb_build_object('restaurant_id', v_rid, 'slug', v_slug, 'status',
                            case when p_trial_days > 0 then 'trialing' else 'active' end, 'day_session_id', v_day);
end;
$$;

create or replace function public.fn_platform_change_plan(p_restaurant_id uuid, p_plan_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text;
  v_status text;
  v_old uuid;
  v_usage jsonb;
begin
  perform public.fn_platform_guard();
  v_reason := public.fn_platform_reason(p_reason);
  if p_restaurant_id is null or p_plan_id is null then perform public.fn_err('invalid_input'); end if;

  select r.status into v_status from public.restaurants r where r.id = p_restaurant_id for update;
  if not found then perform public.fn_err('not_found'); end if;
  if v_status = 'cancelled' then perform public.fn_err('invalid_state', 'cancelled'); end if;
  if not exists (select 1 from public.plans pl where pl.id = p_plan_id and pl.is_active) then perform public.fn_err('invalid_plan'); end if;

  select s.plan_id into v_old from public.subscriptions s where s.restaurant_id = p_restaurant_id for update;
  if not found then perform public.fn_err('invalid_state', 'no subscription'); end if;
  if v_old = p_plan_id then
    return jsonb_build_object('restaurant_id', p_restaurant_id, 'plan_id', p_plan_id, 'changed', false,
                              'over_quota', public.fn_tenant_usage(p_restaurant_id) -> 'over_quota');
  end if;

  update public.subscriptions set plan_id = p_plan_id where restaurant_id = p_restaurant_id;
  v_usage := public.fn_tenant_usage(p_restaurant_id);

  perform public.fn_write_admin_audit('subscription.plan_changed', p_restaurant_id,
    jsonb_build_object('from_plan_id', v_old, 'to_plan_id', p_plan_id, 'reason', v_reason, 'over_quota', v_usage -> 'over_quota'));
  perform public.fn_write_audit('subscription.plan_changed', jsonb_build_object('from_plan_id', v_old, 'to_plan_id', p_plan_id), p_restaurant_id);
  -- a downgrade below current usage is allowed (existing rows stay); the tenant's create paths refuse new rows over the cap
  return jsonb_build_object('restaurant_id', p_restaurant_id, 'plan_id', p_plan_id, 'changed', true, 'over_quota', v_usage -> 'over_quota');
end;
$$;

-- billing status of a NON-suspended, non-cancelled tenant (suspension has its own RPCs, cancellation is terminal)
create or replace function public.fn_platform_set_billing_status(p_restaurant_id uuid, p_status text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text;
  v_status text;
begin
  perform public.fn_platform_guard();
  v_reason := public.fn_platform_reason(p_reason);
  if p_status is null or p_status not in ('trialing', 'active', 'past_due') then perform public.fn_err('invalid_input', 'status'); end if;

  select r.status into v_status from public.restaurants r where r.id = p_restaurant_id for update;
  if not found then perform public.fn_err('not_found'); end if;
  if v_status in ('suspended', 'cancelled') then perform public.fn_err('invalid_state', v_status); end if;
  if v_status = p_status then
    return jsonb_build_object('restaurant_id', p_restaurant_id, 'status', p_status, 'changed', false);
  end if;

  update public.restaurants set status = p_status where id = p_restaurant_id;   -- the 0015 trigger mirrors it to subscriptions
  perform public.fn_write_admin_audit('subscription.status_changed', p_restaurant_id,
    jsonb_build_object('from', v_status, 'to', p_status, 'reason', v_reason));
  perform public.fn_write_audit('subscription.status_changed', jsonb_build_object('from', v_status, 'to', p_status), p_restaurant_id);
  return jsonb_build_object('restaurant_id', p_restaurant_id, 'status', p_status, 'changed', true);
end;
$$;

-- Cancellation is TERMINAL (no reactivation RPC); every row is kept (ON DELETE RESTRICT). p_confirm_slug must repeat the slug.
create or replace function public.fn_platform_cancel_tenant(p_restaurant_id uuid, p_reason text, p_confirm_slug text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text;
  v_status text;
  v_slug text;
  v_revoked integer;
begin
  perform public.fn_platform_guard();
  v_reason := public.fn_platform_reason(p_reason);

  select r.status, r.slug into v_status, v_slug from public.restaurants r where r.id = p_restaurant_id for update;
  if not found then perform public.fn_err('not_found'); end if;
  if p_confirm_slug is null or lower(btrim(p_confirm_slug)) <> v_slug then perform public.fn_err('invalid_input', 'confirm_slug'); end if;
  if v_status = 'cancelled' then
    return jsonb_build_object('restaurant_id', p_restaurant_id, 'status', 'cancelled', 'changed', false);
  end if;

  update public.restaurants set status = 'cancelled', status_before_suspension = null where id = p_restaurant_id;
  update public.tenant_admin_invitations set status = 'revoked', revoked_at = now(), revoked_by = (select auth.uid())
   where restaurant_id = p_restaurant_id and status = 'pending';
  get diagnostics v_revoked = row_count;

  perform public.fn_write_admin_audit('tenant.cancel', p_restaurant_id,
    jsonb_build_object('reason', v_reason, 'previous_status', v_status, 'invitations_revoked', v_revoked));
  perform public.fn_write_audit('tenant.cancelled', jsonb_build_object('reason', v_reason), p_restaurant_id);
  return jsonb_build_object('restaurant_id', p_restaurant_id, 'status', 'cancelled', 'changed', true);
end;
$$;

-- ════════════════════════════════════════ 3. plans catalogue ════════════════════════════════════════
create or replace function public.fn_plan_json(p_plan_id uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('id', pl.id, 'name', pl.name, 'description', pl.description, 'price_etb_monthly', pl.price_etb_monthly,
                            'max_staff', pl.max_staff, 'max_menu_items', pl.max_menu_items, 'max_stations', pl.max_stations,
                            'max_kiosks', pl.max_kiosks, 'max_storage_bytes', pl.max_storage_bytes,
                            'max_orders_per_month', pl.max_orders_per_month, 'features', pl.features,
                            'is_active', pl.is_active, 'sort_order', pl.sort_order, 'created_at', pl.created_at, 'updated_at', pl.updated_at,
                            'subscriber_count', (select count(*) from public.subscriptions s where s.plan_id = pl.id))
  from public.plans pl where pl.id = p_plan_id
$$;
revoke all on function public.fn_plan_json(uuid) from public, anon, authenticated;

-- validates the plan keys present in p_patch; returns the normalised values for exactly those keys
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
                     or (jsonb_typeof(e.value) = 'string' and char_length(e.value #>> '{}') > 100)) then
      perform public.fn_err('invalid_input', 'features');
    end if;
    v := v || jsonb_build_object('features', f);
  end if;
  return v;
end;
$$;
revoke all on function public.fn_plan_normalize(jsonb) from public, anon, authenticated;

create or replace function public.fn_platform_list_plans()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform public.fn_platform_guard();
  return (select coalesce(jsonb_agg(public.fn_plan_json(pl.id) order by pl.sort_order, pl.name), '[]'::jsonb) from public.plans pl);
end;
$$;

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
            coalesce(v -> 'features', '{}'::jsonb), coalesce((v ->> 'sort_order')::integer, 0))
    returning id into v_id;
  exception when unique_violation then
    perform public.fn_err('duplicate_name', v ->> 'name');
  end;
  perform public.fn_write_admin_audit('plan.created', null, jsonb_build_object('plan_id', v_id, 'values', v));
  return public.fn_plan_json(v_id);
end;
$$;

create or replace function public.fn_platform_update_plan(p_plan_id uuid, p_patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v jsonb;
  v_old jsonb;
begin
  perform public.fn_platform_guard();
  v := public.fn_plan_normalize(p_patch);
  if v ? 'name' and v ->> 'name' is null then perform public.fn_err('invalid_input', 'name'); end if;
  if v ? 'price_etb_monthly' and v ->> 'price_etb_monthly' is null then perform public.fn_err('invalid_input', 'price_etb_monthly'); end if;
  perform 1 from public.plans pl where pl.id = p_plan_id for update;
  if not found then perform public.fn_err('not_found'); end if;
  v_old := public.fn_plan_json(p_plan_id);
  begin
    update public.plans pl set
      name = case when v ? 'name' then v ->> 'name' else pl.name end,
      description = case when v ? 'description' then v ->> 'description' else pl.description end,
      price_etb_monthly = case when v ? 'price_etb_monthly' then (v ->> 'price_etb_monthly')::numeric else pl.price_etb_monthly end,
      max_staff = case when v ? 'max_staff' then (v ->> 'max_staff')::integer else pl.max_staff end,
      max_menu_items = case when v ? 'max_menu_items' then (v ->> 'max_menu_items')::integer else pl.max_menu_items end,
      max_stations = case when v ? 'max_stations' then (v ->> 'max_stations')::integer else pl.max_stations end,
      max_kiosks = case when v ? 'max_kiosks' then (v ->> 'max_kiosks')::integer else pl.max_kiosks end,
      max_storage_bytes = case when v ? 'max_storage_bytes' then (v ->> 'max_storage_bytes')::bigint else pl.max_storage_bytes end,
      max_orders_per_month = case when v ? 'max_orders_per_month' then (v ->> 'max_orders_per_month')::integer else pl.max_orders_per_month end,
      features = case when v ? 'features' then v -> 'features' else pl.features end,
      sort_order = case when v ? 'sort_order' then (v ->> 'sort_order')::integer else pl.sort_order end
    where pl.id = p_plan_id;
  exception when unique_violation then
    perform public.fn_err('duplicate_name', v ->> 'name');
  end;
  if public.fn_plan_json(p_plan_id) - 'updated_at' is distinct from v_old - 'updated_at' then
    perform public.fn_write_admin_audit('plan.updated', null, jsonb_build_object('plan_id', p_plan_id, 'patch', v));
  end if;
  return public.fn_plan_json(p_plan_id);
end;
$$;

create or replace function public.fn_platform_set_plan_active(p_plan_id uuid, p_active boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old boolean;
begin
  perform public.fn_platform_guard();
  if p_active is null then perform public.fn_err('invalid_input', 'active'); end if;
  select pl.is_active into v_old from public.plans pl where pl.id = p_plan_id for update;
  if not found then perform public.fn_err('not_found'); end if;
  if v_old is distinct from p_active then
    update public.plans set is_active = p_active where id = p_plan_id;
    perform public.fn_write_admin_audit(case when p_active then 'plan.activated' else 'plan.deactivated' end, null,
                                        jsonb_build_object('plan_id', p_plan_id));
  end if;
  -- existing subscriptions keep a deactivated plan; it can no longer be assigned or provisioned
  return public.fn_plan_json(p_plan_id);
end;
$$;

-- ════════════════════════════════════════ 6. invoices ════════════════════════════════════════
create or replace function public.fn_invoice_json(p_id uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('id', i.id, 'restaurant', jsonb_build_object('id', r.id, 'name', r.name, 'slug', r.slug),
                            'subscription_id', i.subscription_id, 'amount', i.amount, 'period_start', i.period_start,
                            'period_end', i.period_end, 'status', i.status, 'method', i.method, 'reference', i.reference,
                            'paid_at', i.paid_at, 'created_at', i.created_at, 'updated_at', i.updated_at)
  from public.platform_invoices i join public.restaurants r on r.id = i.restaurant_id where i.id = p_id
$$;
revoke all on function public.fn_invoice_json(uuid) from public, anon, authenticated;

-- one live (non-void) invoice per tenant and period: a retried create cannot bill twice
create unique index platform_invoices_period_live_idx on public.platform_invoices (restaurant_id, period_start, period_end)
  where status <> 'void';

create or replace function public.fn_platform_list_invoices(
  p_restaurant_id uuid default null,
  p_status text default null,
  p_limit integer default 50,
  p_before timestamptz default null,
  p_before_id uuid default null
)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform public.fn_platform_guard();
  if p_status is not null and p_status not in ('pending', 'paid', 'overdue', 'void') then perform public.fn_err('invalid_input', 'status'); end if;
  if p_limit is null or p_limit not between 1 and 200 then perform public.fn_err('invalid_input', 'limit'); end if;
  if p_before_id is not null and p_before is null then perform public.fn_err('invalid_input', 'before'); end if;
  return (
    select coalesce(jsonb_agg(public.fn_invoice_json(t.id) order by t.created_at desc, t.id desc), '[]'::jsonb)
    from (select i.id, i.created_at from public.platform_invoices i
          where (p_restaurant_id is null or i.restaurant_id = p_restaurant_id)
            and (p_status is null or i.status = p_status)
            and (p_before is null or i.created_at < p_before or (p_before_id is not null and i.created_at = p_before and i.id < p_before_id))
          order by i.created_at desc, i.id desc
          limit p_limit) t);
end;
$$;

create or replace function public.fn_platform_create_invoice(
  p_restaurant_id uuid,
  p_amount numeric,
  p_period_start date,
  p_period_end date,
  p_reference text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sub uuid;
  v_id uuid;
  v_ref text := nullif(btrim(coalesce(p_reference, '')), '');
begin
  perform public.fn_platform_guard();
  if p_amount is null or p_amount < 0 or p_amount > 10000000 or p_amount <> round(p_amount, 2) then perform public.fn_err('invalid_input', 'amount'); end if;
  if p_period_start is null or p_period_end is null or p_period_end < p_period_start
     or p_period_end - p_period_start > 400 then
    perform public.fn_err('invalid_input', 'period');
  end if;
  if v_ref is not null and char_length(v_ref) > 120 then perform public.fn_err('invalid_input', 'reference'); end if;
  select s.id into v_sub from public.subscriptions s where s.restaurant_id = p_restaurant_id;
  if not found then perform public.fn_err('not_found'); end if;
  begin
    insert into public.platform_invoices (restaurant_id, subscription_id, amount, period_start, period_end, status, reference)
    values (p_restaurant_id, v_sub, p_amount, p_period_start, p_period_end, 'pending', v_ref)
    returning id into v_id;
  exception when unique_violation then
    perform public.fn_err('invalid_state', 'invoice_exists');
  end;
  perform public.fn_write_admin_audit('invoice.created', p_restaurant_id,
    jsonb_build_object('invoice_id', v_id, 'amount', p_amount, 'period_start', p_period_start, 'period_end', p_period_end));
  return public.fn_invoice_json(v_id);
end;
$$;

-- pending -> paid | overdue | void ; overdue -> paid | void ; paid and void are final (a refund is a new record, not an edit)
create or replace function public.fn_platform_set_invoice_status(
  p_invoice_id uuid,
  p_status text,
  p_method text default null,
  p_reference text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.platform_invoices%rowtype;
  v_ref text := nullif(btrim(coalesce(p_reference, '')), '');
begin
  perform public.fn_platform_guard();
  if p_status is null or p_status not in ('paid', 'overdue', 'void') then perform public.fn_err('invalid_input', 'status'); end if;
  if v_ref is not null and char_length(v_ref) > 120 then perform public.fn_err('invalid_input', 'reference'); end if;
  select * into v from public.platform_invoices i where i.id = p_invoice_id for update;
  if not found then perform public.fn_err('not_found'); end if;
  if v.status = p_status then return public.fn_invoice_json(p_invoice_id); end if;
  if v.status in ('paid', 'void') or (v.status = 'overdue' and p_status = 'overdue') then
    perform public.fn_err('invalid_state', v.status);
  end if;
  if p_status = 'paid' and p_method is null then perform public.fn_err('invalid_input', 'method'); end if;
  begin
    update public.platform_invoices
       set status = p_status,
           paid_at = case when p_status = 'paid' then now() else null end,
           method = case when p_status = 'paid' then p_method else method end,
           reference = coalesce(v_ref, reference)
     where id = p_invoice_id;
  exception when check_violation then
    perform public.fn_err('invalid_input', 'method');
  end;
  perform public.fn_write_admin_audit('invoice.status_changed', v.restaurant_id,
    jsonb_build_object('invoice_id', p_invoice_id, 'from', v.status, 'to', p_status));
  return public.fn_invoice_json(p_invoice_id);
end;
$$;

-- ════════════════════════════════════════ 7. health + backups ════════════════════════════════════════
create or replace function public.fn_platform_list_backup_runs(
  p_limit integer default 50,
  p_before timestamptz default null,
  p_before_id uuid default null
)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform public.fn_platform_guard();
  if p_limit is null or p_limit not between 1 and 200 then perform public.fn_err('invalid_input', 'limit'); end if;
  if p_before_id is not null and p_before is null then perform public.fn_err('invalid_input', 'before'); end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'kind', b.kind, 'status', b.status, 'started_at', b.started_at,
                                                 'finished_at', b.finished_at, 'size_bytes', b.size_bytes, 'location', b.location,
                                                 'checksum_sha256', b.checksum_sha256, 'error_code', b.error_code, 'note', b.note)
                              order by b.started_at desc, b.id desc), '[]'::jsonb)
    from (select * from public.platform_backup_runs x
          where p_before is null or x.started_at < p_before or (p_before_id is not null and x.started_at = p_before and x.id < p_before_id)
          order by x.started_at desc, x.id desc limit p_limit) b);
end;
$$;

-- Database-side health only (the portal pings Auth / Storage / Realtime / Edge Functions itself). Aggregates; no tenant rows.
create or replace function public.fn_platform_system_health()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_mig jsonb;
  v_last_ok timestamptz;
  v_last record;
  v_age numeric;
begin
  perform public.fn_platform_guard();

  if pg_catalog.to_regclass('supabase_migrations.schema_migrations') is not null then
    execute 'select jsonb_build_object(''latest'', max(version)::text, ''count'', count(*), ''source'', ''supabase_migrations'') from supabase_migrations.schema_migrations'
      into v_mig;
  else
    v_mig := jsonb_build_object('latest', null, 'count', null, 'source', 'unavailable');
  end if;

  select max(b.finished_at) into v_last_ok from public.platform_backup_runs b where b.status = 'succeeded';
  select b.kind, b.status, b.started_at, b.finished_at, b.error_code into v_last
  from public.platform_backup_runs b order by b.started_at desc, b.id desc limit 1;
  v_age := case when v_last_ok is null then null else round(extract(epoch from (now() - v_last_ok)) / 3600.0, 1) end;

  return jsonb_build_object(
    'checked_at', now(),
    'database', jsonb_build_object(
      'reachable', true,
      'server_version', current_setting('server_version'),
      'size_bytes', pg_catalog.pg_database_size(current_database()),
      'started_at', pg_catalog.pg_postmaster_start_time(),
      'connections', (select count(*) from pg_catalog.pg_stat_activity a where a.datname = current_database()),
      'max_connections', current_setting('max_connections')::integer),
    'migrations', v_mig,
    'largest_tables', (select coalesce(jsonb_agg(jsonb_build_object('table', t.relname, 'total_bytes', t.bytes, 'estimated_rows', t.est)
                                                 order by t.bytes desc), '[]'::jsonb)
                       from (select c.relname::text, pg_catalog.pg_total_relation_size(c.oid) bytes, greatest(c.reltuples, 0)::bigint est
                             from pg_catalog.pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
                             order by 2 desc limit 15) t),
    'storage', (select coalesce(jsonb_agg(jsonb_build_object('bucket', s.bucket_id, 'objects', s.n, 'bytes', s.bytes) order by s.bucket_id), '[]'::jsonb)
                from (select o.bucket_id, count(*) n,
                             coalesce(sum(case when (o.metadata ->> 'size') ~ '^[0-9]{1,18}$' then (o.metadata ->> 'size')::bigint else 0 end), 0) bytes
                      from storage.objects o group by o.bucket_id) s),
    'tenants', (select jsonb_build_object('total', count(*),
                                          'by_status', coalesce(jsonb_object_agg(x.status, x.n), '{}'::jsonb))
                from (select r.status, count(*) n from public.restaurants r group by r.status) x),
    'counters', jsonb_build_object(
      'tenant_audit_events_24h', (select count(*) from public.audit_logs a where a.created_at >= now() - interval '24 hours'),
      'platform_audit_events_24h', (select count(*) from public.admin_audit_log a where a.created_at >= now() - interval '24 hours'),
      'pin_lockouts_active', (select count(*) from public.profile_secrets ps where ps.locked_until > now()),
      'pin_changes_pending_approval', (select count(*) from public.profile_secrets ps where ps.pin_change_pending),
      'invitations_pending', (select count(*) from public.tenant_admin_invitations i where i.status = 'pending' and i.expires_at > now()),
      'invitations_expired', (select count(*) from public.tenant_admin_invitations i where i.status = 'pending' and i.expires_at <= now()),
      'backup_failures_7d', (select count(*) from public.platform_backup_runs b where b.status = 'failed' and b.started_at >= now() - interval '7 days')),
    'backups', jsonb_build_object(
      'last_success_at', v_last_ok,
      'last_success_age_hours', v_age,
      'stale', v_last_ok is null or v_last_ok < now() - interval '26 hours',
      'last_run', case when v_last.kind is null then null
                       else jsonb_build_object('kind', v_last.kind, 'status', v_last.status, 'started_at', v_last.started_at,
                                               'finished_at', v_last.finished_at, 'error_code', v_last.error_code) end));
end;
$$;

-- ════════════════════════════════════════ 8. audit log + accounts ════════════════════════════════════════
create or replace function public.fn_platform_list_audit_log(
  p_limit integer default 50,
  p_before timestamptz default null,
  p_before_id uuid default null,
  p_restaurant_id uuid default null,
  p_action_prefix text default null,
  p_admin_id uuid default null
)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_prefix text := nullif(btrim(coalesce(p_action_prefix, '')), '');
begin
  perform public.fn_platform_guard();
  if p_limit is null or p_limit not between 1 and 200 then perform public.fn_err('invalid_input', 'limit'); end if;
  if p_before_id is not null and p_before is null then perform public.fn_err('invalid_input', 'before'); end if;
  if v_prefix is not null and v_prefix !~ '^[a-z_.]{1,80}$' then perform public.fn_err('invalid_input', 'action_prefix'); end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', l.id, 'created_at', l.created_at, 'action', l.action, 'detail', l.detail,
             'actor', case when l.platform_admin_id is null then null
                           else jsonb_build_object('id', a.id, 'full_name', a.full_name) end,
             'restaurant', case when l.restaurant_id is null then null
                                else jsonb_build_object('id', r.id, 'name', r.name, 'slug', r.slug) end)
           order by l.created_at desc, l.id desc), '[]'::jsonb)
    from (select * from public.admin_audit_log x
          where (p_before is null or x.created_at < p_before or (p_before_id is not null and x.created_at = p_before and x.id < p_before_id))
            and (p_restaurant_id is null or x.restaurant_id = p_restaurant_id)
            and (p_admin_id is null or x.platform_admin_id = p_admin_id)
            and (v_prefix is null or left(x.action, char_length(v_prefix)) = v_prefix)
          order by x.created_at desc, x.id desc limit p_limit) l
    left join public.platform_admins a on a.id = l.platform_admin_id
    left join public.restaurants r on r.id = l.restaurant_id);
end;
$$;

create or replace function public.fn_platform_list_admins()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform public.fn_platform_guard();
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', a.id, 'full_name', a.full_name, 'role', a.role, 'is_active', a.is_active, 'email', u.email,
             'mfa_enrolled', exists (select 1 from auth.mfa_factors f where f.user_id = a.id and f.status = 'verified'),
             'is_self', a.id = (select auth.uid()), 'created_at', a.created_at, 'updated_at', a.updated_at)
           order by a.is_active desc, a.full_name), '[]'::jsonb)
    from public.platform_admins a left join auth.users u on u.id = a.id);
end;
$$;

create or replace function public.fn_platform_set_admin_active(p_admin_id uuid, p_active boolean, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
  v_reason text;
  v_old boolean;
begin
  v_uid := public.fn_platform_guard();
  v_reason := public.fn_platform_reason(p_reason);
  if p_active is null then perform public.fn_err('invalid_input', 'active'); end if;
  if p_admin_id = v_uid and not p_active then perform public.fn_err('invalid_state', 'self'); end if;
  select a.is_active into v_old from public.platform_admins a where a.id = p_admin_id for update;
  if not found then perform public.fn_err('not_found'); end if;
  if v_old is distinct from p_active then
    update public.platform_admins set is_active = p_active where id = p_admin_id;   -- 0015 guard: last_platform_super_admin
    perform public.fn_write_admin_audit(case when p_active then 'platform_admin.reactivated' else 'platform_admin.deactivated' end,
                                        null, jsonb_build_object('admin_id', p_admin_id, 'reason', v_reason));
  end if;
  return jsonb_build_object('id', p_admin_id, 'is_active', p_active, 'changed', v_old is distinct from p_active);
end;
$$;

-- OPS ONLY (service_role): register an existing, e-mail-confirmed Auth user as a platform super admin. There is deliberately no
-- client path to create a Super Admin (docs/architecture/auth-flows.md, "Adding a Super Admin").
create or replace function public.fn_ops_register_platform_admin(p_user_id uuid, p_full_name text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := btrim(coalesce(p_full_name, ''));
begin
  if not public.is_service_role() then perform public.fn_err('permission_denied'); end if;
  if char_length(v_name) not between 1 and 120 then perform public.fn_err('invalid_input', 'full_name'); end if;
  if not exists (select 1 from auth.users u where u.id = p_user_id and u.email_confirmed_at is not null
                 and u.email is not null and u.email !~* '\.invalid$') then
    perform public.fn_err('owner_email_unconfirmed');
  end if;
  if exists (select 1 from public.platform_admins a where a.id = p_user_id) then perform public.fn_err('invalid_state', 'already_admin'); end if;
  if exists (select 1 from public.profiles p where p.id = p_user_id)
     or exists (select 1 from public.tenant_admin_invitations i where i.auth_user_id = p_user_id and i.status = 'pending') then
    perform public.fn_err('owner_already_assigned');
  end if;
  insert into public.platform_admins (id, full_name, role) values (p_user_id, v_name, 'platform_super_admin');
  perform public.fn_write_admin_audit('platform_admin.registered', null, jsonb_build_object('admin_id', p_user_id));
  return jsonb_build_object('id', p_user_id, 'role', 'platform_super_admin');
end;
$$;

-- ════════════════════════════════════════ 5. invitations: RPCs ════════════════════════════════════════
-- Who may manage invitations of tenant p_rid? Returns 'platform_admin' | 'tenant_admin' or raises. p_rid null = the caller's own
-- tenant (tenant path only). Order: platform callers -> fn_platform_guard; everyone else -> tenant guard, tenant_admin, aal2.
create or replace function public.fn_invitation_actor(p_rid uuid, out o_type text, out o_rid uuid)
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then perform public.fn_err('not_authenticated'); end if;
  if exists (select 1 from public.platform_admins a where a.id = v_uid) then
    perform public.fn_platform_guard();
    if p_rid is null then perform public.fn_err('invalid_input', 'restaurant_id'); end if;
    o_type := 'platform_admin';
    o_rid := p_rid;
  else
    o_rid := public.fn_tenant_status_guard(true);
    if not public.is_tenant_admin() then perform public.fn_err('permission_denied'); end if;
    perform public.fn_require_aal2();
    if p_rid is not null and p_rid <> o_rid then perform public.fn_err('permission_denied'); end if;
    o_type := 'tenant_admin';
  end if;
end;
$$;
revoke all on function public.fn_invitation_actor(uuid) from public, anon, authenticated;

create or replace function public.fn_invitation_json(p_id uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('id', i.id, 'restaurant_id', i.restaurant_id, 'email', i.email, 'first_name', i.first_name,
                            'middle_name', i.middle_name, 'last_name', i.last_name, 'username', i.username, 'status', i.status,
                            'state', case when i.status = 'pending' and i.expires_at <= now() then 'expired' else i.status end,
                            'invited_by_type', i.invited_by_type, 'expires_at', i.expires_at, 'send_count', i.send_count,
                            'last_sent_at', i.last_sent_at, 'accepted_at', i.accepted_at, 'revoked_at', i.revoked_at,
                            'created_at', i.created_at)
  from public.tenant_admin_invitations i where i.id = p_id
$$;
revoke all on function public.fn_invitation_json(uuid) from public, anon, authenticated;

-- step 1 of tenant-admin-invite (AS THE CALLER): authorise, validate, reserve. Returns {invitation_id, email, restaurant_id, expires_at}.
create or replace function public.fn_prepare_tenant_admin_invitation(
  p_restaurant_id uuid,
  p_email text,
  p_first_name text,
  p_middle_name text,
  p_last_name text,
  p_username text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_type text;
  v_rid uuid;
  v_status text;
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_first text := btrim(coalesce(p_first_name, ''));
  v_middle text := nullif(btrim(coalesce(p_middle_name, '')), '');
  v_last text := nullif(btrim(coalesce(p_last_name, '')), '');
  v_user text := lower(btrim(coalesce(p_username, '')));
  v_max integer;
  v_id uuid;
  v_expires timestamptz := now() + interval '7 days';
begin
  select a.o_type, a.o_rid into v_type, v_rid from public.fn_invitation_actor(p_restaurant_id) a;

  select r.status into v_status from public.restaurants r where r.id = v_rid for update;
  if not found then perform public.fn_err('not_found'); end if;
  if v_status in ('suspended', 'cancelled') then perform public.fn_err('tenant_suspended'); end if;

  if char_length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[a-z]{2,}$' or v_email ~ '\.invalid$' then
    perform public.fn_err('invalid_input', 'email');
  end if;
  if char_length(v_first) not between 1 and 60 then perform public.fn_err('invalid_input', 'first_name'); end if;
  if v_middle is not null and char_length(v_middle) > 60 then perform public.fn_err('invalid_input', 'middle_name'); end if;
  if v_last is not null and char_length(v_last) > 60 then perform public.fn_err('invalid_input', 'last_name'); end if;
  if v_user !~ '^[a-z0-9][a-z0-9._-]{1,31}$' then perform public.fn_err('invalid_input', 'username'); end if;

  if exists (select 1 from public.profiles p where p.restaurant_id = v_rid and p.username = v_user)
     or exists (select 1 from public.tenant_admin_invitations i where i.restaurant_id = v_rid and i.username = v_user and i.status = 'pending') then
    perform public.fn_err('username_taken');
  end if;
  -- an existing Auth identity (any account) or another pending invitation for this e-mail: never re-bind an existing account
  if exists (select 1 from auth.users u where lower(u.email) = v_email)
     or exists (select 1 from public.tenant_admin_invitations i where i.email = v_email and i.status = 'pending') then
    perform public.fn_err('email_in_use');
  end if;

  select pl.max_staff into v_max from public.subscriptions s join public.plans pl on pl.id = s.plan_id where s.restaurant_id = v_rid;
  if v_max is not null
     and (select count(*) from public.profiles p where p.restaurant_id = v_rid and p.is_active)
       + (select count(*) from public.tenant_admin_invitations i where i.restaurant_id = v_rid and i.status = 'pending' and i.expires_at > now())
       >= v_max then
    perform public.fn_err('staff_limit_reached');
  end if;

  begin
    insert into public.tenant_admin_invitations (restaurant_id, email, first_name, middle_name, last_name, username,
                                                 invited_by, invited_by_type, expires_at)
    values (v_rid, v_email, v_first, v_middle, v_last, v_user, (select auth.uid()), v_type, v_expires)
    returning id into v_id;
  exception when unique_violation then
    perform public.fn_err('email_in_use');
  end;

  perform public.fn_write_audit('tenant_admin.invited', jsonb_build_object('invitation_id', v_id, 'email', v_email, 'by', v_type), v_rid);
  if v_type = 'platform_admin' then
    perform public.fn_write_admin_audit('tenant.admin_invited', v_rid, jsonb_build_object('invitation_id', v_id, 'email', v_email));
  end if;
  return jsonb_build_object('invitation_id', v_id, 'email', v_email, 'restaurant_id', v_rid, 'expires_at', v_expires);
end;
$$;

-- step 2 (service role, inside tenant-admin-invite): bind the Auth user that inviteUserByEmail created to the reserved invitation
create or replace function public.fn_attach_tenant_admin_invitation(p_invitation_id uuid, p_auth_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.tenant_admin_invitations%rowtype;
begin
  if not public.is_service_role() then perform public.fn_err('permission_denied'); end if;
  select * into v from public.tenant_admin_invitations i where i.id = p_invitation_id for update;
  if not found or v.status <> 'pending' then perform public.fn_err('not_found'); end if;
  if v.auth_user_id is not null then
    if v.auth_user_id = p_auth_user_id then return jsonb_build_object('invitation_id', v.id, 'attached', true); end if;
    perform public.fn_err('invalid_state', 'already_attached');
  end if;
  if not exists (select 1 from auth.users u where u.id = p_auth_user_id and lower(u.email) = v.email) then
    perform public.fn_err('invalid_auth_user');
  end if;
  if exists (select 1 from public.profiles p where p.id = p_auth_user_id)
     or exists (select 1 from public.platform_admins a where a.id = p_auth_user_id) then
    perform public.fn_err('invalid_auth_user');
  end if;
  update public.tenant_admin_invitations set auth_user_id = p_auth_user_id where id = v.id;
  perform public.fn_write_audit('tenant_admin.invitation_sent', jsonb_build_object('invitation_id', v.id), v.restaurant_id);
  if v.invited_by_type = 'platform_admin' then
    perform public.fn_write_admin_audit('tenant.admin_invitation_sent', v.restaurant_id, jsonb_build_object('invitation_id', v.id));
  end if;
  return jsonb_build_object('invitation_id', v.id, 'attached', true);
end;
$$;

-- compensation (service role): the e-mail could not be sent / the user could not be created -> the reservation is released
create or replace function public.fn_abort_tenant_admin_invitation(p_invitation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.tenant_admin_invitations%rowtype;
begin
  if not public.is_service_role() then perform public.fn_err('permission_denied'); end if;
  select * into v from public.tenant_admin_invitations i where i.id = p_invitation_id for update;
  if not found then perform public.fn_err('not_found'); end if;
  if v.status = 'pending' then
    update public.tenant_admin_invitations set status = 'revoked', revoked_at = now() where id = v.id;
    perform public.fn_write_audit('tenant_admin.invitation_failed', jsonb_build_object('invitation_id', v.id), v.restaurant_id);
  end if;
  return jsonb_build_object('invitation_id', v.id, 'status', 'revoked');
end;
$$;

-- resend (AS THE CALLER): at most 5 sends, 60 s apart; renews the 7-day expiry. Returns what the Edge Function needs to re-send.
create or replace function public.fn_prepare_tenant_admin_invitation_resend(p_invitation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.tenant_admin_invitations%rowtype;
  v_type text;
  v_rid uuid;
  v_status text;
begin
  select * into v from public.tenant_admin_invitations i where i.id = p_invitation_id;
  -- the actor check uses the invitation's tenant; for a tenant caller a foreign id fails like an unknown one
  select a.o_type, a.o_rid into v_type, v_rid
  from public.fn_invitation_actor(case when exists (select 1 from public.platform_admins pa where pa.id = (select auth.uid()))
                                       then coalesce(v.restaurant_id, gen_random_uuid()) else null end) a;
  if v.id is null or v.restaurant_id <> v_rid then perform public.fn_err('not_found'); end if;
  select * into v from public.tenant_admin_invitations i where i.id = p_invitation_id for update;
  if v.status <> 'pending' or v.auth_user_id is null then perform public.fn_err('invalid_state', v.status); end if;
  select r.status into v_status from public.restaurants r where r.id = v_rid;
  if v_status in ('suspended', 'cancelled') then perform public.fn_err('tenant_suspended'); end if;
  if v.send_count >= 5 or v.last_sent_at > now() - interval '60 seconds' then perform public.fn_err('invite_rate_limited'); end if;
  if exists (select 1 from auth.users u where u.id = v.auth_user_id and u.email_confirmed_at is not null) then
    perform public.fn_err('invalid_state', 'already_confirmed');
  end if;

  update public.tenant_admin_invitations
     set send_count = send_count + 1, last_sent_at = now(), expires_at = now() + interval '7 days'
   where id = v.id;
  perform public.fn_write_audit('tenant_admin.invitation_resent', jsonb_build_object('invitation_id', v.id, 'by', v_type), v_rid);
  if v_type = 'platform_admin' then
    perform public.fn_write_admin_audit('tenant.admin_invitation_resent', v_rid, jsonb_build_object('invitation_id', v.id));
  end if;
  return jsonb_build_object('invitation_id', v.id, 'email', v.email, 'auth_user_id', v.auth_user_id);
end;
$$;

-- revoke (AS THE CALLER). cleanup_user_id is returned only for an Auth user that never confirmed and holds nothing else, so the
-- Edge Function may delete it; the DB effect alone already makes the invitation unusable.
create or replace function public.fn_revoke_tenant_admin_invitation(p_invitation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.tenant_admin_invitations%rowtype;
  v_type text;
  v_rid uuid;
  v_cleanup uuid;
begin
  select * into v from public.tenant_admin_invitations i where i.id = p_invitation_id;
  select a.o_type, a.o_rid into v_type, v_rid
  from public.fn_invitation_actor(case when exists (select 1 from public.platform_admins pa where pa.id = (select auth.uid()))
                                       then coalesce(v.restaurant_id, gen_random_uuid()) else null end) a;
  if v.id is null or v.restaurant_id <> v_rid then perform public.fn_err('not_found'); end if;
  select * into v from public.tenant_admin_invitations i where i.id = p_invitation_id for update;
  if v.status = 'revoked' then
    return jsonb_build_object('invitation_id', v.id, 'status', 'revoked', 'changed', false, 'cleanup_user_id', null);
  end if;
  if v.status <> 'pending' then perform public.fn_err('invalid_state', v.status); end if;

  update public.tenant_admin_invitations set status = 'revoked', revoked_at = now(), revoked_by = (select auth.uid()) where id = v.id;
  if v.auth_user_id is not null
     and exists (select 1 from auth.users u where u.id = v.auth_user_id and u.email_confirmed_at is null)
     and not exists (select 1 from public.profiles p where p.id = v.auth_user_id)
     and not exists (select 1 from public.platform_admins a where a.id = v.auth_user_id) then
    v_cleanup := v.auth_user_id;
  end if;
  perform public.fn_write_audit('tenant_admin.invitation_revoked', jsonb_build_object('invitation_id', v.id, 'by', v_type), v_rid);
  if v_type = 'platform_admin' then
    perform public.fn_write_admin_audit('tenant.admin_invitation_revoked', v_rid, jsonb_build_object('invitation_id', v.id));
  end if;
  return jsonb_build_object('invitation_id', v.id, 'status', 'revoked', 'changed', true, 'cleanup_user_id', v_cleanup);
end;
$$;

-- the invitee (signed in from the e-mail link, no profile yet): what am I invited to?
create or replace function public.fn_get_my_invitation()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then perform public.fn_err('not_authenticated'); end if;
  return (select jsonb_build_object('invitation_id', i.id, 'restaurant', jsonb_build_object('name', r.name, 'slug', r.slug),
                                    'email', i.email, 'username', i.username, 'expires_at', i.expires_at,
                                    'expired', i.expires_at <= now())
          from public.tenant_admin_invitations i join public.restaurants r on r.id = i.restaurant_id
          where i.auth_user_id = v_uid and i.status = 'pending'
            and r.status not in ('suspended', 'cancelled'));
end;
$$;

-- the invitee accepts: THIS is where the Auth user becomes the tenant's tenant_admin profile (password login, never PIN)
create or replace function public.fn_accept_tenant_admin_invitation()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v public.tenant_admin_invitations%rowtype;
  v_status text;
  v_slug text;
  v_role uuid;
begin
  if v_uid is null then perform public.fn_err('not_authenticated'); end if;
  select * into v from public.tenant_admin_invitations i where i.auth_user_id = v_uid and i.status = 'pending' for update;
  if not found then perform public.fn_err('not_found'); end if;
  if v.expires_at <= now() then perform public.fn_err('invitation_expired'); end if;
  if exists (select 1 from public.profiles p where p.id = v_uid)
     or exists (select 1 from public.platform_admins a where a.id = v_uid) then
    perform public.fn_err('owner_already_assigned');
  end if;
  if not exists (select 1 from auth.users u where u.id = v_uid and lower(u.email) = v.email) then
    perform public.fn_err('owner_email_mismatch');
  end if;
  if not exists (select 1 from auth.users u where u.id = v_uid and u.email_confirmed_at is not null) then
    perform public.fn_err('owner_email_unconfirmed');
  end if;
  select r.status, r.slug into v_status, v_slug from public.restaurants r where r.id = v.restaurant_id for share;
  if v_status in ('suspended', 'cancelled') then perform public.fn_err('tenant_suspended'); end if;
  select ro.id into v_role from public.roles ro where ro.restaurant_id = v.restaurant_id and ro.system_key = 'tenant_admin';
  if v_role is null then perform public.fn_err('invalid_state', 'no tenant_admin role'); end if;

  begin
    insert into public.profiles (id, restaurant_id, first_name, middle_name, last_name, username, role_id, auth_method)
    values (v_uid, v.restaurant_id, v.first_name, v.middle_name, v.last_name, v.username, v_role, 'password');
  exception when unique_violation then
    perform public.fn_err('username_taken');
  end;
  update public.tenant_admin_invitations set status = 'accepted', accepted_at = now() where id = v.id;

  perform public.fn_write_audit('tenant_admin.invitation_accepted', jsonb_build_object('invitation_id', v.id, 'profile_id', v_uid), v.restaurant_id);
  if v.invited_by_type = 'platform_admin' then
    perform public.fn_write_admin_audit('tenant.admin_invitation_accepted', v.restaurant_id,
                                        jsonb_build_object('invitation_id', v.id, 'profile_id', v_uid));
  end if;
  return jsonb_build_object('profile_id', v_uid, 'restaurant_id', v.restaurant_id, 'slug', v_slug);
end;
$$;

-- tenant side listing (tenant_admin of the caller's tenant)
create or replace function public.fn_list_tenant_admin_invitations()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_rid uuid;
begin
  v_rid := public.fn_tenant_status_guard(false);
  if not public.is_tenant_admin() then perform public.fn_err('permission_denied'); end if;
  return (select coalesce(jsonb_agg(public.fn_invitation_json(i.id) order by i.created_at desc), '[]'::jsonb)
          from (select x.id, x.created_at from public.tenant_admin_invitations x where x.restaurant_id = v_rid
                order by x.created_at desc limit 100) i);
end;
$$;

-- ════════════════════════════════════════ grants ════════════════════════════════════════
revoke all on function
  public.fn_platform_list_tenants(text, text, uuid, integer, integer),
  public.fn_platform_get_tenant(uuid),
  public.fn_platform_create_tenant(text, text, uuid, integer, text),
  public.fn_platform_change_plan(uuid, uuid, text),
  public.fn_platform_set_billing_status(uuid, text, text),
  public.fn_platform_cancel_tenant(uuid, text, text),
  public.fn_platform_list_plans(),
  public.fn_platform_create_plan(jsonb),
  public.fn_platform_update_plan(uuid, jsonb),
  public.fn_platform_set_plan_active(uuid, boolean),
  public.fn_platform_list_invoices(uuid, text, integer, timestamptz, uuid),
  public.fn_platform_create_invoice(uuid, numeric, date, date, text),
  public.fn_platform_set_invoice_status(uuid, text, text, text),
  public.fn_platform_list_backup_runs(integer, timestamptz, uuid),
  public.fn_platform_system_health(),
  public.fn_platform_list_audit_log(integer, timestamptz, uuid, uuid, text, uuid),
  public.fn_platform_list_admins(),
  public.fn_platform_set_admin_active(uuid, boolean, text),
  public.fn_ops_register_platform_admin(uuid, text),
  public.fn_prepare_tenant_admin_invitation(uuid, text, text, text, text, text),
  public.fn_attach_tenant_admin_invitation(uuid, uuid),
  public.fn_abort_tenant_admin_invitation(uuid),
  public.fn_prepare_tenant_admin_invitation_resend(uuid),
  public.fn_revoke_tenant_admin_invitation(uuid),
  public.fn_get_my_invitation(),
  public.fn_accept_tenant_admin_invitation(),
  public.fn_list_tenant_admin_invitations()
from public, anon, authenticated, service_role;

grant execute on function
  public.fn_platform_list_tenants(text, text, uuid, integer, integer),
  public.fn_platform_get_tenant(uuid),
  public.fn_platform_create_tenant(text, text, uuid, integer, text),
  public.fn_platform_change_plan(uuid, uuid, text),
  public.fn_platform_set_billing_status(uuid, text, text),
  public.fn_platform_cancel_tenant(uuid, text, text),
  public.fn_platform_list_plans(),
  public.fn_platform_create_plan(jsonb),
  public.fn_platform_update_plan(uuid, jsonb),
  public.fn_platform_set_plan_active(uuid, boolean),
  public.fn_platform_list_invoices(uuid, text, integer, timestamptz, uuid),
  public.fn_platform_create_invoice(uuid, numeric, date, date, text),
  public.fn_platform_set_invoice_status(uuid, text, text, text),
  public.fn_platform_list_backup_runs(integer, timestamptz, uuid),
  public.fn_platform_system_health(),
  public.fn_platform_list_audit_log(integer, timestamptz, uuid, uuid, text, uuid),
  public.fn_platform_list_admins(),
  public.fn_platform_set_admin_active(uuid, boolean, text),
  public.fn_prepare_tenant_admin_invitation(uuid, text, text, text, text, text),
  public.fn_prepare_tenant_admin_invitation_resend(uuid),
  public.fn_revoke_tenant_admin_invitation(uuid),
  public.fn_get_my_invitation(),
  public.fn_accept_tenant_admin_invitation(),
  public.fn_list_tenant_admin_invitations()
to authenticated;
grant execute on function
  public.fn_ops_register_platform_admin(uuid, text),
  public.fn_attach_tenant_admin_invitation(uuid, uuid),
  public.fn_abort_tenant_admin_invitation(uuid)
to service_role;
