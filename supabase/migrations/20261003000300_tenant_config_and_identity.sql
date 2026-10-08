-- 0003  Dynamic tenant configuration domains + identity/authorization
-- The six tenant-editable domains (roles, stations, categories, payment_methods, table_areas,
-- expense_categories) are plain relational rows keyed by UUID: no enums, names are presentation only.
-- (restaurant_id, id) unique keys exist so child tables can use COMPOSITE foreign keys that make
-- cross-tenant references impossible at the schema level.

-- ── stations
create table public.stations (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references public.restaurants(id) on delete restrict,
  name           text not null check (char_length(btrim(name)) between 1 and 60),
  normalized_name text generated always as (lower(regexp_replace(btrim(name), '\s+', ' ', 'g'))) stored,
  description    text check (description is null or char_length(description) <= 300),
  color          text check (color is null or color ~ '^#[0-9a-fA-F]{6}$'),
  icon           text check (icon is null or icon ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  sort_order     integer not null default 0,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint stations_tenant_name_key unique (restaurant_id, normalized_name),
  constraint stations_tenant_id_key unique (restaurant_id, id)
);
create index stations_tenant_sort_idx on public.stations (restaurant_id, sort_order, normalized_name);

-- ── categories
create table public.categories (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references public.restaurants(id) on delete restrict,
  name           text not null check (char_length(btrim(name)) between 1 and 60),
  normalized_name text generated always as (lower(regexp_replace(btrim(name), '\s+', ' ', 'g'))) stored,
  description    text check (description is null or char_length(description) <= 300),
  color          text check (color is null or color ~ '^#[0-9a-fA-F]{6}$'),
  icon           text check (icon is null or icon ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  sort_order     integer not null default 0,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint categories_tenant_name_key unique (restaurant_id, normalized_name),
  constraint categories_tenant_id_key unique (restaurant_id, id)
);
create index categories_tenant_sort_idx on public.categories (restaurant_id, sort_order, normalized_name);

-- ── table_areas
create table public.table_areas (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references public.restaurants(id) on delete restrict,
  name           text not null check (char_length(btrim(name)) between 1 and 60),
  normalized_name text generated always as (lower(regexp_replace(btrim(name), '\s+', ' ', 'g'))) stored,
  description    text check (description is null or char_length(description) <= 300),
  color          text check (color is null or color ~ '^#[0-9a-fA-F]{6}$'),
  icon           text check (icon is null or icon ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  sort_order     integer not null default 0,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint table_areas_tenant_name_key unique (restaurant_id, normalized_name),
  constraint table_areas_tenant_id_key unique (restaurant_id, id)
);
create index table_areas_tenant_sort_idx on public.table_areas (restaurant_id, sort_order, normalized_name);

-- ── expense_categories
create table public.expense_categories (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references public.restaurants(id) on delete restrict,
  name           text not null check (char_length(btrim(name)) between 1 and 60),
  normalized_name text generated always as (lower(regexp_replace(btrim(name), '\s+', ' ', 'g'))) stored,
  description    text check (description is null or char_length(description) <= 300),
  color          text check (color is null or color ~ '^#[0-9a-fA-F]{6}$'),
  icon           text check (icon is null or icon ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  sort_order     integer not null default 0,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint expense_categories_tenant_name_key unique (restaurant_id, normalized_name),
  constraint expense_categories_tenant_id_key unique (restaurant_id, id)
);
create index expense_categories_tenant_sort_idx on public.expense_categories (restaurant_id, sort_order, normalized_name);

-- ── payment_methods
-- No cash special-casing by name: day-close reads the data flag affects_cash_drawer.
create table public.payment_methods (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references public.restaurants(id) on delete restrict,
  name           text not null check (char_length(btrim(name)) between 1 and 60),
  normalized_name text generated always as (lower(regexp_replace(btrim(name), '\s+', ' ', 'g'))) stored,
  description    text check (description is null or char_length(description) <= 300),
  color          text check (color is null or color ~ '^#[0-9a-fA-F]{6}$'),
  icon           text check (icon is null or icon ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  sort_order     integer not null default 0,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  affects_cash_drawer boolean not null default false,
  requires_reference  boolean not null default false,
  constraint payment_methods_tenant_name_key unique (restaurant_id, normalized_name),
  constraint payment_methods_tenant_id_key unique (restaurant_id, id)
);
create index payment_methods_tenant_sort_idx on public.payment_methods (restaurant_id, sort_order, normalized_name);

-- ── roles (per tenant). Exactly one system role exists: tenant_admin (system_key).
create table public.roles (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references public.restaurants(id) on delete restrict,
  name           text not null check (char_length(btrim(name)) between 1 and 60),
  normalized_name text generated always as (lower(regexp_replace(btrim(name), '\s+', ' ', 'g'))) stored,
  description    text check (description is null or char_length(description) <= 300),
  color          text check (color is null or color ~ '^#[0-9a-fA-F]{6}$'),
  icon           text check (icon is null or icon ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  sort_order     integer not null default 0,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  is_system      boolean not null default false,
  system_key     text,
  constraint roles_tenant_name_key unique (restaurant_id, normalized_name),
  constraint roles_tenant_id_key unique (restaurant_id, id),
  constraint roles_system_key_check check (system_key is null or system_key = 'tenant_admin'),
  constraint roles_system_flag_check check (is_system = (system_key is not null))
);
create index roles_tenant_sort_idx on public.roles (restaurant_id, sort_order, normalized_name);
-- at most one tenant_admin role per tenant
create unique index roles_one_tenant_admin_idx on public.roles (restaurant_id) where system_key = 'tenant_admin';


-- ── permissions: GLOBAL static catalog (read-only to clients, maintained by migrations) ──
create table public.permissions (
  id           uuid primary key default gen_random_uuid(),
  key          text not null check (key ~ '^[a-z][a-z_]*\.[a-z][a-z_]*$'),
  module       text not null check (char_length(module) between 1 and 40),
  description  text not null check (char_length(description) <= 200),
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now(),
  constraint permissions_key_key unique (key)
);

-- ── profiles: staff identity, 1:1 with auth.users ───────────────────────────
-- Ethiopian naming: first + middle (father's name) + last (grandfather's name).
-- short_name = first + middle.
create table public.profiles (
  id             uuid primary key references auth.users(id) on delete restrict,
  restaurant_id  uuid not null references public.restaurants(id) on delete restrict,
  first_name     text not null check (char_length(btrim(first_name)) between 1 and 60),
  middle_name    text check (middle_name is null or char_length(btrim(middle_name)) between 1 and 60),
  last_name      text check (last_name is null or char_length(btrim(last_name)) between 1 and 60),
  short_name     text generated always as (btrim(first_name || ' ' || coalesce(middle_name, ''))) stored,
  full_name      text generated always as (btrim(first_name || ' ' || coalesce(middle_name, '') || ' ' || coalesce(last_name, ''))) stored,
  username       text not null check (username ~ '^[a-z0-9][a-z0-9._-]{1,31}$'),
  role_id        uuid not null,
  is_active      boolean not null default true,
  -- tenant_admin => 'password' (Supabase Auth email+password, MFA-capable); every other role => 'pin'.
  -- Consistency with the role is enforced by trigger trg_guard_profile_auth_method.
  auth_method    text not null check (auth_method in ('password','pin')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint profiles_tenant_username_key unique (restaurant_id, username),
  constraint profiles_tenant_id_key unique (restaurant_id, id),
  -- the role must belong to the same tenant; roles with users cannot be deleted
  constraint profiles_role_fk foreign key (restaurant_id, role_id)
    references public.roles (restaurant_id, id) on delete restrict
);
create index profiles_role_idx on public.profiles (restaurant_id, role_id);

-- ── profile_secrets: PIN hash + lockout. RLS on, NO policies, no client grants. ─
create table public.profile_secrets (
  profile_id       uuid primary key references public.profiles(id) on delete restrict,
  restaurant_id    uuid not null references public.restaurants(id) on delete restrict,
  pin_hash         text not null,
  failed_attempts  integer not null default 0 check (failed_attempts >= 0),
  locked_until     timestamptz,
  pin_changed_at   timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint profile_secrets_profile_fk foreign key (restaurant_id, profile_id)
    references public.profiles (restaurant_id, id) on delete restrict
);

-- ── role_permissions: the editable matrix (writes only via fn_update_role_permissions) ──
create table public.role_permissions (
  role_id        uuid not null,
  permission_id  uuid not null references public.permissions(id) on delete restrict,
  restaurant_id  uuid not null references public.restaurants(id) on delete restrict,
  created_at     timestamptz not null default now(),
  primary key (role_id, permission_id),
  constraint role_permissions_role_fk foreign key (restaurant_id, role_id)
    references public.roles (restaurant_id, id) on delete restrict
);
create index role_permissions_tenant_idx on public.role_permissions (restaurant_id, role_id);
create index role_permissions_permission_idx on public.role_permissions (permission_id);

-- ── role_station_access: structured equivalent of the prototype's station:<uuid> permission ──
create table public.role_station_access (
  role_id        uuid not null,
  station_id     uuid not null,
  restaurant_id  uuid not null references public.restaurants(id) on delete restrict,
  created_at     timestamptz not null default now(),
  primary key (role_id, station_id),
  constraint role_station_access_role_fk foreign key (restaurant_id, role_id)
    references public.roles (restaurant_id, id) on delete restrict,
  constraint role_station_access_station_fk foreign key (restaurant_id, station_id)
    references public.stations (restaurant_id, id) on delete restrict
);
create index role_station_access_tenant_idx on public.role_station_access (restaurant_id, role_id);
create index role_station_access_station_idx on public.role_station_access (restaurant_id, station_id);

-- ── Permission catalog (global reference data, idempotent) ──────────────────
insert into public.permissions (key, module, description, sort_order) values
  ('dashboard.view',     'dashboard', 'View the dashboard and live activity', 10),
  ('orders.view',        'orders',    'View orders (scoped by orders.view_all / own / station)', 20),
  ('orders.create',      'orders',    'Create and submit orders (waiter POS)', 21),
  ('orders.cancel',      'orders',    'Cancel an order that is still untouched and unpaid', 22),
  ('orders.view_all',    'orders',    'View every order of the restaurant', 23),
  ('payments.create',    'payments',  'Confirm payments and issue receipts', 30),
  ('payments.view',      'payments',  'View payments and receipts', 31),
  ('payments.reverse',   'payments',  'Reverse a confirmed payment (compensating record)', 32),
  ('inventory.view',     'inventory', 'View ingredients and stock movements', 40),
  ('inventory.adjust',   'inventory', 'Manage ingredients and adjust stock', 41),
  ('inventory.receive',  'inventory', 'Receive stock', 42),
  ('menu.view',          'menu',      'View the menu and recipes', 50),
  ('menu.manage',        'menu',      'Create and edit menu items and recipes', 51),
  ('expenses.view',      'expenses',  'View expenses', 60),
  ('expenses.manage',    'expenses',  'Record, edit and delete expenses', 61),
  ('vouchers.view',      'vouchers',  'View installment vouchers', 70),
  ('vouchers.manage',    'vouchers',  'Issue vouchers and collect installments', 71),
  ('tables.view',        'tables',    'View tables, areas and sessions', 80),
  ('tables.manage',      'tables',    'Create and edit tables', 81),
  ('qr.manage',          'tables',    'Issue, regenerate and revoke QR credentials', 82),
  ('users.view',         'users',     'View staff accounts', 90),
  ('users.manage',       'users',     'Manage staff accounts and their role assignment', 91),
  ('roles.manage',       'users',     'Manage roles and the permission matrix', 92),
  ('reports.view',       'reports',   'View reports', 100),
  ('day_close.execute',  'reports',   'Close the business day', 101),
  ('day.open',           'reports',   'Open a new business day', 102),
  ('settings.manage',    'settings',  'Edit restaurant settings and branding', 110),
  ('config.manage',      'settings',  'Manage stations, categories, payment methods, table areas, expense categories', 111),
  ('audit.view',         'settings',  'View the audit log', 112)
on conflict (key) do update
  set module = excluded.module, description = excluded.description, sort_order = excluded.sort_order;
