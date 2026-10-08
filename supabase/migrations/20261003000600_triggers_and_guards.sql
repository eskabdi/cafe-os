-- 0006  Triggers: updated_at, tenant-key lock, immutability, system-role guards, audit
-- NOTE for later migrations: new tables must be attached the same way (see loops below).

-- ── standard triggers on every public table that has the column ─────────────
do $$
declare
  r record;
begin
  for r in
    select c.table_name
    from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
    where c.table_schema = 'public' and c.column_name = 'updated_at'
  loop
    execute format('create trigger trg_set_updated_at before update on public.%I for each row execute function public.fn_set_updated_at()', r.table_name);
  end loop;

  for r in
    select c.table_name
    from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
    where c.table_schema = 'public' and c.column_name = 'restaurant_id'
  loop
    execute format('create trigger trg_lock_restaurant_id before update on public.%I for each row execute function public.fn_lock_restaurant_id()', r.table_name);
  end loop;
end $$;

-- ── append-only tables: no UPDATE / DELETE / TRUNCATE for ANY role (service_role, owner too) ──
do $$
declare
  t text;
begin
  foreach t in array array['audit_logs', 'admin_audit_log', 'payments', 'stock_movements'] loop
    execute format('create trigger trg_00_immutable before update or delete on public.%I for each row execute function public.fn_forbid_mutation()', t);
    execute format('create trigger trg_00_no_truncate before truncate on public.%I for each statement execute function public.fn_forbid_mutation()', t);
  end loop;
end $$;

-- ── day_sessions: closed rows are frozen; days are never deleted ────────────
create or replace function public.fn_guard_day_session()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    perform public.fn_err('closed_day_immutable', 'day sessions cannot be deleted');
  end if;
  if old.status = 'closed' then
    perform public.fn_err('closed_day_immutable');
  end if;
  if new.day_no is distinct from old.day_no or new.opened_at is distinct from old.opened_at then
    perform public.fn_err('immutable_column', 'day_no/opened_at');
  end if;
  return new;
end;
$$;
create trigger trg_guard_day_session before update or delete on public.day_sessions
  for each row execute function public.fn_guard_day_session();

-- ── roles: tenant_admin can never be deleted, deactivated or demoted ────────
create or replace function public.fn_guard_system_role()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.system_key is not null then
      perform public.fn_err('system_role_protected', 'cannot delete');
    end if;
    return old;
  end if;
  -- UPDATE
  if old.system_key is not null then
    if new.system_key is distinct from old.system_key or new.is_system is distinct from old.is_system then
      perform public.fn_err('system_role_protected', 'system_key is immutable');
    end if;
    if not new.is_active then
      perform public.fn_err('system_role_protected', 'cannot deactivate');
    end if;
  elsif new.system_key is not null or new.is_system then
    perform public.fn_err('system_role_protected', 'cannot promote to system role');
  end if;
  return new;
end;
$$;
create trigger trg_guard_system_role before update or delete on public.roles
  for each row execute function public.fn_guard_system_role();

-- tenant_admin keeps every permission: rows cannot be removed
create or replace function public.fn_guard_role_permissions()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.roles r where r.id = old.role_id and r.system_key is not null) then
    perform public.fn_err('system_role_protected', 'permissions of a system role cannot be removed');
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  perform public.fn_err('immutable_record', 'role_permissions rows are insert/delete only');
  return null;
end;
$$;
create trigger trg_guard_role_permissions before update or delete on public.role_permissions
  for each row execute function public.fn_guard_role_permissions();

-- a new catalog permission is automatically granted to every tenant_admin role
create or replace function public.fn_grant_new_permission_to_admins()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.role_permissions (role_id, permission_id, restaurant_id)
  select r.id, new.id, r.restaurant_id from public.roles r where r.system_key = 'tenant_admin'
  on conflict do nothing;
  return null;
end;
$$;
create trigger trg_grant_new_permission after insert on public.permissions
  for each row execute function public.fn_grant_new_permission_to_admins();

-- ── profiles: the last active tenant_admin can never be removed ─────────────
create or replace function public.fn_guard_last_admin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.is_active
     and (not new.is_active or new.role_id is distinct from old.role_id)
     and exists (select 1 from public.roles r where r.id = old.role_id and r.system_key = 'tenant_admin')
     and not exists (
       select 1
       from public.profiles p
       join public.roles r on r.id = p.role_id and r.restaurant_id = p.restaurant_id
       where p.restaurant_id = old.restaurant_id
         and p.id <> old.id
         and p.is_active
         and r.system_key = 'tenant_admin'
     )
  then
    perform public.fn_err('last_tenant_admin');
  end if;
  return new;
end;
$$;
create trigger trg_guard_last_admin before update on public.profiles
  for each row execute function public.fn_guard_last_admin();


-- ── auth method: tenant_admin => password login, staff => PIN login ─────────
-- PIN eligibility (single source of truth; also used by the PIN RPCs).
create or replace function public.fn_pin_eligible(p_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    join public.roles ro on ro.id = p.role_id and ro.restaurant_id = p.restaurant_id
    where p.id = p_profile_id
      and p.auth_method = 'pin'
      and ro.system_key is null
      and not exists (select 1 from public.platform_admins a where a.id = p.id)
  )
$$;

create or replace function public.fn_guard_profile_auth_method()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text;
  v_email text;
begin
  select ro.system_key into v_key from public.roles ro
  where ro.id = new.role_id and ro.restaurant_id = new.restaurant_id;
  if coalesce(v_key = 'tenant_admin', false) <> (new.auth_method = 'password') then
    perform public.fn_err('auth_method_mismatch', 'tenant_admin uses password, staff uses pin');
  end if;
  if exists (select 1 from public.platform_admins a where a.id = new.id) then
    perform public.fn_err('auth_method_mismatch', 'platform admins cannot hold a tenant profile');
  end if;
  select u.email into v_email from auth.users u where u.id = new.id;
  if new.auth_method = 'password'
     and (tg_op = 'INSERT' or old.auth_method is distinct from new.auth_method) then
    if v_email is null or v_email ~* '\.invalid$' then
      perform public.fn_err('admin_requires_email_identity');
    end if;
  elsif new.auth_method = 'pin' and tg_op = 'INSERT' then
    if v_email is null or v_email !~* '^[a-z0-9._-]+@[a-z0-9-]+\.staff\.cafeos\.invalid$' then
      perform public.fn_err('auth_method_mismatch', 'staff accounts use a synthetic non-routable email');
    end if;
  end if;
  return new;
end;
$$;
create trigger trg_guard_profile_auth_method before insert or update on public.profiles
  for each row execute function public.fn_guard_profile_auth_method();

-- profile_secrets rows can only exist for PIN-eligible (non-admin, auth_method='pin') profiles
create or replace function public.fn_guard_profile_secret()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.fn_pin_eligible(new.profile_id) then
    perform public.fn_err('pin_not_allowed');
  end if;
  return new;
end;
$$;
create trigger trg_guard_profile_secret before insert or update on public.profile_secrets
  for each row execute function public.fn_guard_profile_secret();

-- ── expenses: server-filled context + closed-day freeze ─────────────────────
create or replace function public.fn_expense_context()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_day uuid;
  v_closed boolean;
begin
  if tg_op = 'DELETE' then
    if old.day_session_id is not null
       and exists (select 1 from public.day_sessions d where d.id = old.day_session_id and d.status = 'closed') then
      perform public.fn_err('day_closed');
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' then
    if old.day_session_id is not null
       and exists (select 1 from public.day_sessions d where d.id = old.day_session_id and d.status = 'closed') then
      perform public.fn_err('day_closed');
    end if;
    new.created_by := old.created_by;
    new.day_session_id := old.day_session_id;
    if new.payment_method_id is not distinct from old.payment_method_id then
      new.method_name_snapshot := old.method_name_snapshot;
      new.method_affects_drawer_snapshot := old.method_affects_drawer_snapshot;
    end if;
  else
    -- INSERT: actor and business day come from the server, not the client
    if (select auth.uid()) is not null then
      new.created_by := (select public.current_user_id());
      new.day_session_id := null;
    end if;
    if new.day_session_id is null then
      select d.id into v_day from public.day_sessions d
      where d.restaurant_id = new.restaurant_id and d.status = 'open';
      new.day_session_id := v_day;
    end if;
  end if;

  if tg_op = 'INSERT' or new.payment_method_id is distinct from old.payment_method_id then
    select pm.name, pm.affects_cash_drawer into new.method_name_snapshot, new.method_affects_drawer_snapshot
    from public.payment_methods pm
    where pm.id = new.payment_method_id and pm.restaurant_id = new.restaurant_id;
    if not found then
      perform public.fn_err('invalid_reference', 'payment_method_id');
    end if;
  end if;
  return new;
end;
$$;
create trigger trg_expense_context before insert or update or delete on public.expenses
  for each row execute function public.fn_expense_context();

-- ── row-level audit on configuration, identity and money-adjacent tables ────
do $$
declare
  t record;
begin
  for t in
    select * from (values
      ('stations', ''), ('categories', ''), ('payment_methods', ''), ('table_areas', ''),
      ('expense_categories', ''), ('roles', ''), ('role_permissions', 'role_id,permission_id'),
      ('role_station_access', 'role_id,station_id'), ('profiles', ''), ('menu_items', ''),
      ('restaurants', ''), ('qr_credentials', ''), ('day_sessions', ''), ('expenses', '')
    ) v(tbl, pk)
  loop
    execute format(
      'create trigger trg_audit after insert or update or delete on public.%I for each row execute function public.fn_audit_row(%L)',
      t.tbl, t.pk);
  end loop;
end $$;
