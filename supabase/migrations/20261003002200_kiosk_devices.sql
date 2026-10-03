-- 0022  Registered kiosk devices (shared floor terminal) + reserved subdomain 'status'
--
--  A tenant admin (permission kiosks.manage, held by tenant_admin and grantable) registers a device. The raw token is
--  returned ONCE by fn_register_kiosk; only its sha256 is stored (kiosk_devices.token_hash, never granted to a client).
--  A registered device may (via the staff-roster / pin-login Edge Functions, service role) show the PIN-staff tiles of its
--  own tenant. Tenant comes from the token, and the host-derived slug sent by the SPA must match it.
--  Token = 64 lowercase hex characters (32 random bytes); token_hash = sha256 hex of that TEXT.
--
--  Service-only helpers (no client EXECUTE):
--    fn_kiosk_context(token_hash, slug, touch)      -> restaurant id | NULL (unknown, revoked, slug mismatch, suspended, cancelled
--                                                      are indistinguishable). touch = refresh last_seen_at (throttled to 1/min)
--    fn_kiosk_roster(token_hash, slug)              -> NULL (invalid kiosk) | jsonb array of tiles
--                                                      ONLY active staff, auth_method 'pin', non-admin, PIN-eligible, with a 4-DIGIT
--                                                      PIN on record (profile_secrets.pin_length = 4: the 6-digit Cashier and admins
--                                                      never appear; no role-name literal), as {id, name (first+middle), role, color, icon}
--    fn_kiosk_tile_eligible(token_hash, slug, id)   -> boolean: kiosk valid AND the profile is exactly such a tile of that tenant
--  Reserved subdomains: 'status' joins the reserved slug list (CHECK + fn_slug_is_reserved); the TypeScript twin is
--  supabase/functions/_shared/host.ts (RESERVED_SUBDOMAINS), kept equal by tests on both sides.

-- ── reserved slugs ──────────────────────────────────────────────────────────
alter table public.restaurants drop constraint restaurants_slug_format;
alter table public.restaurants add constraint restaurants_slug_format check (
  slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'
  and slug !~ '--'
  and slug not in ('www','api','app','admin','platform','static','assets','auth','login','r','cdn','mail','support','status')
);
create or replace function public.fn_slug_is_reserved(p_slug text)
returns boolean
language sql immutable set search_path = ''
as $$ select p_slug in ('www','api','app','admin','platform','static','assets','auth','login','r','cdn','mail','support','status') $$;

-- ── permission ──────────────────────────────────────────────────────────────
insert into public.permissions (key, module, description, sort_order)
values ('kiosks.manage', 'settings', 'Register and revoke shared floor terminals (kiosk devices)', 113)
on conflict (key) do nothing;
-- (trigger trg_grant_new_permission gives it to every tenant_admin role; other roles can be granted it in the matrix)

-- ── table ───────────────────────────────────────────────────────────────────
create table public.kiosk_devices (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references public.restaurants(id) on delete restrict,
  name           text not null check (char_length(btrim(name)) between 1 and 60),
  token_hash     text not null check (token_hash ~ '^[0-9a-f]{64}$'),   -- sha256 hex; the raw token is never stored
  created_by     uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  last_seen_at   timestamptz,
  revoked_at     timestamptz,
  constraint kiosk_devices_token_hash_key unique (token_hash),
  constraint kiosk_devices_tenant_id_key unique (restaurant_id, id),
  constraint kiosk_devices_created_by_fk foreign key (restaurant_id, created_by)
    references public.profiles (restaurant_id, id) on delete restrict
);
create index kiosk_devices_tenant_idx on public.kiosk_devices (restaurant_id, created_at desc);

alter table public.kiosk_devices enable row level security;
alter table public.kiosk_devices force row level security;
create trigger trg_set_updated_at before update on public.kiosk_devices for each row execute function public.fn_set_updated_at();
create trigger trg_lock_restaurant_id before update on public.kiosk_devices for each row execute function public.fn_lock_restaurant_id();
-- last_seen_at refreshes are deliberately NOT audited (fn_audit_row strips token_hash from every row it records)
create trigger trg_audit after insert or delete or update of name, revoked_at on public.kiosk_devices
  for each row execute function public.fn_audit_row('');

-- readable (metadata only) with kiosks.manage; every write goes through the RPCs below
create policy kiosk_devices_select on public.kiosk_devices for select to authenticated
  using (restaurant_id = (select public.current_restaurant_id()) and (select public.has_permission('kiosks.manage')));
revoke all on public.kiosk_devices from public, anon, authenticated;
grant select (id, restaurant_id, name, created_by, created_at, updated_at, last_seen_at, revoked_at) on public.kiosk_devices to authenticated;

-- ── admin RPCs ──────────────────────────────────────────────────────────────
create or replace function public.fn_register_kiosk(p_name text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rid uuid := public.fn_tenant_status_guard(true);
  v_name text := btrim(coalesce(p_name, ''));
  v_token text;
  v_id uuid;
begin
  if not public.has_permission('kiosks.manage') then perform public.fn_err('permission_denied'); end if;
  if char_length(v_name) not between 1 and 60 then perform public.fn_err('invalid_input', 'name'); end if;
  if (select count(*) from public.kiosk_devices k where k.restaurant_id = v_rid and k.revoked_at is null) >= 25 then
    perform public.fn_err('kiosk_limit_reached');
  end if;
  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.kiosk_devices (restaurant_id, name, token_hash, created_by)
  values (v_rid, v_name, encode(extensions.digest(convert_to(v_token, 'UTF8'), 'sha256'), 'hex'), (select public.current_user_id()))
  returning id into v_id;
  perform public.fn_write_audit('kiosk.registered', jsonb_build_object('kiosk_id', v_id, 'name', v_name));
  -- the ONLY time the raw token exists outside the device
  return jsonb_build_object('id', v_id, 'name', v_name, 'token', v_token);
end;
$$;

create or replace function public.fn_revoke_kiosk(p_kiosk_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rid uuid := public.fn_tenant_status_guard(true);
begin
  if not public.has_permission('kiosks.manage') then perform public.fn_err('permission_denied'); end if;
  if p_kiosk_id is null then perform public.fn_err('invalid_input'); end if;
  perform 1 from public.kiosk_devices k where k.id = p_kiosk_id and k.restaurant_id = v_rid for update;
  if not found then perform public.fn_err('not_found'); end if;   -- same answer for foreign and unknown ids
  update public.kiosk_devices set revoked_at = now() where id = p_kiosk_id and restaurant_id = v_rid and revoked_at is null;
  perform public.fn_write_audit('kiosk.revoked', jsonb_build_object('kiosk_id', p_kiosk_id));
  return jsonb_build_object('id', p_kiosk_id, 'revoked', true);
end;
$$;

create or replace function public.fn_list_kiosks()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_rid uuid := public.fn_tenant_status_guard(false);
begin
  if not public.has_permission('kiosks.manage') then perform public.fn_err('permission_denied'); end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', k.id, 'name', k.name, 'created_by', k.created_by,
                                                       'created_at', k.created_at, 'last_seen_at', k.last_seen_at,
                                                       'revoked_at', k.revoked_at) order by k.created_at desc)
                   from public.kiosk_devices k where k.restaurant_id = v_rid), '[]'::jsonb);
end;
$$;
revoke all on function public.fn_register_kiosk(text), public.fn_revoke_kiosk(uuid), public.fn_list_kiosks() from public, anon;
grant execute on function public.fn_register_kiosk(text), public.fn_revoke_kiosk(uuid), public.fn_list_kiosks() to authenticated;

-- ── service-only helpers (Edge Functions staff-roster / pin-login) ──────────
create or replace function public.fn_kiosk_context(p_token_hash text, p_slug text, p_touch boolean default false)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kiosk uuid;
  v_rid uuid;
begin
  if not public.is_service_role() then perform public.fn_err('permission_denied'); end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' or p_slug is null then return null; end if;
  select k.id, k.restaurant_id into v_kiosk, v_rid
  from public.kiosk_devices k join public.restaurants r on r.id = k.restaurant_id
  where k.token_hash = p_token_hash and k.revoked_at is null
    and r.slug = lower(btrim(p_slug)) and r.status not in ('suspended', 'cancelled');
  if v_kiosk is null then return null; end if;
  if coalesce(p_touch, false) then
    update public.kiosk_devices set last_seen_at = now()
    where id = v_kiosk and (last_seen_at is null or last_seen_at < now() - interval '1 minute');
  end if;
  return v_rid;
end;
$$;

create or replace function public.fn_kiosk_roster(p_token_hash text, p_slug text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rid uuid;
begin
  if not public.is_service_role() then perform public.fn_err('permission_denied'); end if;
  v_rid := public.fn_kiosk_context(p_token_hash, p_slug, true);
  if v_rid is null then return null; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.short_name, 'role', ro.name, 'color', ro.color, 'icon', ro.icon)
                     order by p.short_name, p.id)
    from public.profiles p
    join public.roles ro on ro.id = p.role_id and ro.restaurant_id = p.restaurant_id
    join public.profile_secrets ps on ps.profile_id = p.id
    where p.restaurant_id = v_rid and p.is_active and ro.is_active and ro.system_key is null
      and public.fn_pin_eligible(p.id) and ps.pin_length = 4
  ), '[]'::jsonb);
end;
$$;

create or replace function public.fn_kiosk_tile_eligible(p_token_hash text, p_slug text, p_profile_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rid uuid;
begin
  if not public.is_service_role() then perform public.fn_err('permission_denied'); end if;
  v_rid := public.fn_kiosk_context(p_token_hash, p_slug, false);
  if v_rid is null or p_profile_id is null then return false; end if;
  return exists (
    select 1
    from public.profiles p
    join public.roles ro on ro.id = p.role_id and ro.restaurant_id = p.restaurant_id
    join public.profile_secrets ps on ps.profile_id = p.id
    where p.id = p_profile_id and p.restaurant_id = v_rid and p.is_active and ro.is_active and ro.system_key is null
      and public.fn_pin_eligible(p.id) and ps.pin_length = 4);
end;
$$;
revoke all on function public.fn_kiosk_context(text, text, boolean), public.fn_kiosk_roster(text, text),
                       public.fn_kiosk_tile_eligible(text, text, uuid) from public, anon, authenticated;
grant execute on function public.fn_kiosk_context(text, text, boolean), public.fn_kiosk_roster(text, text),
                          public.fn_kiosk_tile_eligible(text, text, uuid) to service_role;
