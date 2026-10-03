-- 0005  Restaurant operations schema
-- Every table: restaurant_id + UUID pk + created_at/updated_at (where mutable), (restaurant_id, id)
-- unique key for composite same-tenant FKs, money = numeric(12,2), quantities = numeric(12,3),
-- every business FK is ON DELETE RESTRICT (soft-deactivate instead of delete).

-- ── day_sessions: the business day is a first-class entity ──────────────────
create table public.day_sessions (
  id                  uuid primary key default gen_random_uuid(),
  restaurant_id       uuid not null references public.restaurants(id) on delete restrict,
  day_no              integer not null check (day_no > 0),
  status              text not null default 'open' check (status in ('open','closed')),
  opened_at           timestamptz not null default now(),
  opened_by           uuid,
  opening_float       numeric(12,2) not null default 0 check (opening_float >= 0),
  -- close snapshot (execution prompt §29)
  closed_at           timestamptz,
  closed_by           uuid,
  order_count         integer check (order_count >= 0),
  gross_collected     numeric(12,2),
  cash_collected      numeric(12,2),
  cash_expenses       numeric(12,2),
  expenses_total      numeric(12,2),
  expected_cash       numeric(12,2),
  counted_cash        numeric(12,2),
  cash_variance       numeric(12,2),
  net_profit          numeric(12,2),
  inventory_variance  numeric(12,3),
  station_snapshot    jsonb,   -- per station: expected / counted / variance / items[]  (ids + name snapshots)
  expense_snapshot    jsonb,   -- per expense category: amount / count (ids + name snapshots)
  payment_snapshot    jsonb,   -- per payment method: amount / count (ids + name snapshots)
  close_note          text check (close_note is null or char_length(close_note) <= 500),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint day_sessions_tenant_day_key unique (restaurant_id, day_no),
  constraint day_sessions_tenant_id_key unique (restaurant_id, id),
  constraint day_sessions_opened_by_fk foreign key (restaurant_id, opened_by)
    references public.profiles (restaurant_id, id) on delete restrict,
  constraint day_sessions_closed_by_fk foreign key (restaurant_id, closed_by)
    references public.profiles (restaurant_id, id) on delete restrict,
  constraint day_sessions_closed_consistency check (
    (status = 'open' and closed_at is null)
    or (status = 'closed'
        and closed_at is not null and closed_by is not null and order_count is not null
        and gross_collected is not null and cash_collected is not null and cash_expenses is not null
        and expenses_total is not null and expected_cash is not null and counted_cash is not null
        and cash_variance is not null and net_profit is not null
        and station_snapshot is not null and expense_snapshot is not null)
  ),
  constraint day_sessions_snapshot_types check (
    (station_snapshot is null or jsonb_typeof(station_snapshot) in ('object','array'))
    and (expense_snapshot is null or jsonb_typeof(expense_snapshot) in ('object','array'))
    and (payment_snapshot is null or jsonb_typeof(payment_snapshot) in ('object','array'))
  )
);
create unique index day_sessions_one_open_idx on public.day_sessions (restaurant_id) where status = 'open';
create index day_sessions_tenant_opened_idx on public.day_sessions (restaurant_id, opened_at desc);

-- ── menu / inventory ────────────────────────────────────────────────────────
create table public.menu_items (
  id              uuid primary key default gen_random_uuid(),
  restaurant_id   uuid not null references public.restaurants(id) on delete restrict,
  name            text not null check (char_length(btrim(name)) between 1 and 120),
  normalized_name text generated always as (lower(regexp_replace(btrim(name), '\s+', ' ', 'g'))) stored,
  description     text check (description is null or char_length(description) <= 500),
  category_id     uuid not null,
  station_id      uuid not null,
  price           numeric(12,2) not null check (price >= 0),
  emoji           text check (emoji is null or char_length(emoji) <= 16),
  image_path      text,
  sort_order      integer not null default 0,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint menu_items_tenant_name_key unique (restaurant_id, normalized_name),
  constraint menu_items_tenant_id_key unique (restaurant_id, id),
  constraint menu_items_category_fk foreign key (restaurant_id, category_id)
    references public.categories (restaurant_id, id) on delete restrict,
  constraint menu_items_station_fk foreign key (restaurant_id, station_id)
    references public.stations (restaurant_id, id) on delete restrict,
  -- tenant-scoped Storage path only; never a URL or base64 blob
  constraint menu_items_image_path_check check (
    image_path is null
    or (image_path like 'restaurants/' || restaurant_id::text || '/%'
        and image_path ~ '^restaurants/[0-9a-f-]{36}/[A-Za-z0-9._/-]{1,200}$'
        and image_path !~ '\.\.')
  )
);
create index menu_items_category_idx on public.menu_items (restaurant_id, category_id);
create index menu_items_station_idx on public.menu_items (restaurant_id, station_id);
create index menu_items_active_idx on public.menu_items (restaurant_id, sort_order) where is_active;

create table public.ingredients (
  id              uuid primary key default gen_random_uuid(),
  restaurant_id   uuid not null references public.restaurants(id) on delete restrict,
  name            text not null check (char_length(btrim(name)) between 1 and 120),
  normalized_name text generated always as (lower(regexp_replace(btrim(name), '\s+', ' ', 'g'))) stored,
  station_id      uuid not null,
  unit            text not null check (unit in ('kg','g','L','ml','pcs')),
  stock           numeric(12,3) not null default 0 check (stock >= 0),
  min_level       numeric(12,3) not null default 0 check (min_level >= 0),
  cost_per_unit   numeric(12,2) not null default 0 check (cost_per_unit >= 0),
  opening_stock   numeric(12,3) not null default 0 check (opening_stock >= 0),
  received_today  numeric(12,3) not null default 0 check (received_today >= 0),
  consumed_today  numeric(12,3) not null default 0 check (consumed_today >= 0),
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint ingredients_tenant_name_key unique (restaurant_id, normalized_name),
  constraint ingredients_tenant_id_key unique (restaurant_id, id),
  constraint ingredients_station_fk foreign key (restaurant_id, station_id)
    references public.stations (restaurant_id, id) on delete restrict
);
create index ingredients_station_idx on public.ingredients (restaurant_id, station_id);
create index ingredients_low_stock_idx on public.ingredients (restaurant_id) where stock <= min_level;

create table public.recipe_lines (
  id               uuid primary key default gen_random_uuid(),
  restaurant_id    uuid not null references public.restaurants(id) on delete restrict,
  menu_item_id     uuid not null,
  ingredient_id    uuid not null,
  qty_per_serving  numeric(12,3) not null check (qty_per_serving > 0),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint recipe_lines_unique_pair unique (menu_item_id, ingredient_id),
  constraint recipe_lines_menu_fk foreign key (restaurant_id, menu_item_id)
    references public.menu_items (restaurant_id, id) on delete restrict,
  constraint recipe_lines_ingredient_fk foreign key (restaurant_id, ingredient_id)
    references public.ingredients (restaurant_id, id) on delete restrict
);
create index recipe_lines_menu_idx on public.recipe_lines (restaurant_id, menu_item_id);
create index recipe_lines_ingredient_idx on public.recipe_lines (restaurant_id, ingredient_id);

-- ── tables / QR / sessions ──────────────────────────────────────────────────
create table public.tables (
  id               uuid primary key default gen_random_uuid(),
  restaurant_id    uuid not null references public.restaurants(id) on delete restrict,
  table_area_id    uuid not null,
  label            text not null check (char_length(btrim(label)) between 1 and 30),
  normalized_label text generated always as (lower(regexp_replace(btrim(label), '\s+', ' ', 'g'))) stored,
  capacity         integer not null default 2 check (capacity between 1 and 100),
  status           text not null default 'available' check (status in ('available','occupied','needs_cleaning','out_of_service')),
  qr_enabled       boolean not null default true,
  sort_order       integer not null default 0,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint tables_tenant_label_key unique (restaurant_id, normalized_label),
  constraint tables_tenant_id_key unique (restaurant_id, id),
  constraint tables_area_fk foreign key (restaurant_id, table_area_id)
    references public.table_areas (restaurant_id, id) on delete restrict
);
create index tables_area_idx on public.tables (restaurant_id, table_area_id);

create table public.table_sessions (
  id              uuid primary key default gen_random_uuid(),
  restaurant_id   uuid not null references public.restaurants(id) on delete restrict,
  table_id        uuid not null,
  day_session_id  uuid,
  status          text not null default 'open' check (status in ('open','closed','expired')),
  guest_count     integer check (guest_count is null or guest_count between 1 and 200),
  opened_by       uuid,
  opened_at       timestamptz not null default now(),
  closed_at       timestamptz,
  expires_at      timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint table_sessions_tenant_id_key unique (restaurant_id, id),
  constraint table_sessions_table_fk foreign key (restaurant_id, table_id)
    references public.tables (restaurant_id, id) on delete restrict,
  constraint table_sessions_day_fk foreign key (restaurant_id, day_session_id)
    references public.day_sessions (restaurant_id, id) on delete restrict,
  constraint table_sessions_opened_by_fk foreign key (restaurant_id, opened_by)
    references public.profiles (restaurant_id, id) on delete restrict,
  constraint table_sessions_closed_check check ((status = 'open') = (closed_at is null))
);
create unique index table_sessions_one_open_idx on public.table_sessions (table_id) where status = 'open';
create index table_sessions_table_idx on public.table_sessions (restaurant_id, table_id, opened_at desc);

create table public.qr_credentials (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references public.restaurants(id) on delete restrict,
  table_id       uuid not null,
  token_hash     text not null check (token_hash ~ '^[0-9a-f]{64}$'),   -- sha256 hex; raw token is never stored
  version        integer not null default 1 check (version > 0),
  status         text not null default 'active' check (status in ('active','revoked')),
  issued_at      timestamptz not null default now(),
  issued_by      uuid,
  revoked_at     timestamptz,
  revoked_by     uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint qr_credentials_token_hash_key unique (token_hash),
  constraint qr_credentials_tenant_id_key unique (restaurant_id, id),
  constraint qr_credentials_table_fk foreign key (restaurant_id, table_id)
    references public.tables (restaurant_id, id) on delete restrict,
  constraint qr_credentials_issued_by_fk foreign key (restaurant_id, issued_by)
    references public.profiles (restaurant_id, id) on delete restrict,
  constraint qr_credentials_revoked_by_fk foreign key (restaurant_id, revoked_by)
    references public.profiles (restaurant_id, id) on delete restrict,
  constraint qr_credentials_revoked_check check ((status = 'revoked') = (revoked_at is not null)),
  constraint qr_credentials_version_key unique (table_id, version)
);
-- regenerate = revoke previous + insert new; this index makes "two active codes" impossible
create unique index qr_credentials_one_active_idx on public.qr_credentials (table_id) where status = 'active';

create table public.customer_sessions (
  id                  uuid primary key default gen_random_uuid(),
  restaurant_id       uuid not null references public.restaurants(id) on delete restrict,
  table_session_id    uuid,
  qr_credential_id    uuid not null,
  session_token_hash  text not null check (session_token_hash ~ '^[0-9a-f]{64}$'),
  customer_name       text check (customer_name is null or char_length(customer_name) <= 80),
  customer_phone      text check (customer_phone is null or char_length(customer_phone) <= 40),
  status              text not null default 'active' check (status in ('active','expired','closed')),
  expires_at          timestamptz not null,
  last_seen_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint customer_sessions_token_key unique (session_token_hash),
  constraint customer_sessions_tenant_id_key unique (restaurant_id, id),
  constraint customer_sessions_table_session_fk foreign key (restaurant_id, table_session_id)
    references public.table_sessions (restaurant_id, id) on delete restrict,
  constraint customer_sessions_qr_fk foreign key (restaurant_id, qr_credential_id)
    references public.qr_credentials (restaurant_id, id) on delete restrict
);
create index customer_sessions_qr_idx on public.customer_sessions (restaurant_id, qr_credential_id);
create index customer_sessions_table_session_idx on public.customer_sessions (restaurant_id, table_session_id);

-- ── orders ──────────────────────────────────────────────────────────────────
create table public.orders (
  id                       uuid primary key default gen_random_uuid(),
  restaurant_id            uuid not null references public.restaurants(id) on delete restrict,
  day_session_id           uuid not null,
  order_no                 text not null check (order_no ~ '^[A-Z]{2,5}-[0-9]{4,}$'),
  source                   text not null default 'staff' check (source in ('staff','qr')),
  order_type               text not null default 'dine-in' check (order_type in ('dine-in','takeaway','delivery')),
  status                   text not null default 'submitted' check (status in ('submitted','preparing','ready','served','cancelled')),
  payment_status           text not null default 'unpaid' check (payment_status in ('unpaid','paid','installment')),
  table_id                 uuid,
  table_label_snapshot     text check (table_label_snapshot is null or char_length(table_label_snapshot) <= 30),
  table_session_id         uuid,
  customer_session_id      uuid,
  created_by               uuid,
  created_by_name_snapshot text check (created_by_name_snapshot is null or char_length(created_by_name_snapshot) <= 140),
  subtotal                 numeric(12,2) not null check (subtotal >= 0),
  vat_rate_snapshot        numeric(5,2) not null check (vat_rate_snapshot between 0 and 100),
  vat_amount               numeric(12,2) not null check (vat_amount >= 0),
  total                    numeric(12,2) not null check (total >= 0),
  stock_consumed           boolean not null default false,
  client_key               text check (client_key is null or char_length(client_key) between 8 and 128),
  public_token_hash        text check (public_token_hash is null or public_token_hash ~ '^[0-9a-f]{64}$'),
  customer_name            text check (customer_name is null or char_length(customer_name) <= 80),
  customer_phone           text check (customer_phone is null or char_length(customer_phone) <= 40),
  customer_note            text check (customer_note is null or char_length(customer_note) <= 300),
  ready_at                 timestamptz,
  served_at                timestamptz,
  cancelled_at             timestamptz,
  cancelled_by             uuid,
  cancel_reason            text check (cancel_reason is null or char_length(cancel_reason) <= 300),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint orders_tenant_order_no_key unique (restaurant_id, order_no),
  constraint orders_tenant_client_key_key unique (restaurant_id, client_key),
  constraint orders_tenant_id_key unique (restaurant_id, id),
  constraint orders_day_fk foreign key (restaurant_id, day_session_id)
    references public.day_sessions (restaurant_id, id) on delete restrict,
  constraint orders_table_fk foreign key (restaurant_id, table_id)
    references public.tables (restaurant_id, id) on delete restrict,
  constraint orders_table_session_fk foreign key (restaurant_id, table_session_id)
    references public.table_sessions (restaurant_id, id) on delete restrict,
  constraint orders_customer_session_fk foreign key (restaurant_id, customer_session_id)
    references public.customer_sessions (restaurant_id, id) on delete restrict,
  constraint orders_created_by_fk foreign key (restaurant_id, created_by)
    references public.profiles (restaurant_id, id) on delete restrict,
  constraint orders_cancelled_by_fk foreign key (restaurant_id, cancelled_by)
    references public.profiles (restaurant_id, id) on delete restrict,
  constraint orders_total_check check (total = subtotal + vat_amount),
  constraint orders_cancelled_check check ((status = 'cancelled') = (cancelled_at is not null)),
  constraint orders_staff_creator_check check (source <> 'staff' or created_by is not null)
);
create index orders_tenant_created_idx on public.orders (restaurant_id, created_at desc);
create index orders_tenant_open_status_idx on public.orders (restaurant_id, status, created_at)
  where status in ('submitted','preparing','ready');
create index orders_tenant_unpaid_idx on public.orders (restaurant_id, created_at)
  where payment_status = 'unpaid' and status <> 'cancelled';
create index orders_day_idx on public.orders (restaurant_id, day_session_id);
create index orders_created_by_idx on public.orders (restaurant_id, created_by, created_at desc);
create index orders_table_idx on public.orders (restaurant_id, table_id);

create table public.order_items (
  id                     uuid primary key default gen_random_uuid(),
  restaurant_id          uuid not null references public.restaurants(id) on delete restrict,
  order_id               uuid not null,
  menu_item_id           uuid not null,
  name_snapshot          text not null check (char_length(name_snapshot) between 1 and 120),
  price_snapshot         numeric(12,2) not null check (price_snapshot >= 0),
  qty                    integer not null check (qty > 0 and qty <= 999),
  station_id             uuid not null,
  station_name_snapshot  text not null check (char_length(station_name_snapshot) between 1 and 60),
  item_status            text not null default 'pending' check (item_status in ('pending','preparing','ready','served','cancelled')),
  note                   text check (note is null or char_length(note) <= 200),
  started_at             timestamptz,
  ready_at               timestamptz,
  served_at              timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint order_items_tenant_id_key unique (restaurant_id, id),
  constraint order_items_order_fk foreign key (restaurant_id, order_id)
    references public.orders (restaurant_id, id) on delete restrict,
  constraint order_items_menu_fk foreign key (restaurant_id, menu_item_id)
    references public.menu_items (restaurant_id, id) on delete restrict,
  constraint order_items_station_fk foreign key (restaurant_id, station_id)
    references public.stations (restaurant_id, id) on delete restrict
);
create index order_items_order_idx on public.order_items (restaurant_id, order_id);
create index order_items_station_status_idx on public.order_items (restaurant_id, station_id, item_status);
create index order_items_menu_idx on public.order_items (restaurant_id, menu_item_id);

-- ── stock ledger (append-only) ──────────────────────────────────────────────
create table public.stock_movements (
  id                    uuid primary key default gen_random_uuid(),
  restaurant_id         uuid not null references public.restaurants(id) on delete restrict,
  ingredient_id         uuid not null,
  station_id            uuid not null,   -- ingredient's station at movement time
  qty_delta             numeric(12,3) not null check (qty_delta <> 0),
  reason                text not null check (reason in ('opening','received','consumed','manual_adjustment','reversal','correction')),
  note                  text check (note is null or char_length(note) <= 300),
  order_id              uuid,
  reverses_movement_id  uuid,
  day_session_id        uuid,
  created_by            uuid,
  created_at            timestamptz not null default now(),
  constraint stock_movements_tenant_id_key unique (restaurant_id, id),
  constraint stock_movements_ingredient_fk foreign key (restaurant_id, ingredient_id)
    references public.ingredients (restaurant_id, id) on delete restrict,
  constraint stock_movements_station_fk foreign key (restaurant_id, station_id)
    references public.stations (restaurant_id, id) on delete restrict,
  constraint stock_movements_order_fk foreign key (restaurant_id, order_id)
    references public.orders (restaurant_id, id) on delete restrict,
  constraint stock_movements_reverses_fk foreign key (restaurant_id, reverses_movement_id)
    references public.stock_movements (restaurant_id, id) on delete restrict,
  constraint stock_movements_day_fk foreign key (restaurant_id, day_session_id)
    references public.day_sessions (restaurant_id, id) on delete restrict,
  constraint stock_movements_created_by_fk foreign key (restaurant_id, created_by)
    references public.profiles (restaurant_id, id) on delete restrict,
  constraint stock_movements_reversal_check check ((reason = 'reversal') = (reverses_movement_id is not null))
);
create index stock_movements_ingredient_idx on public.stock_movements (restaurant_id, ingredient_id, created_at desc);
create index stock_movements_tenant_created_idx on public.stock_movements (restaurant_id, created_at desc);
create index stock_movements_station_idx on public.stock_movements (restaurant_id, station_id, created_at desc);
create index stock_movements_order_idx on public.stock_movements (restaurant_id, order_id) where order_id is not null;
create unique index stock_movements_one_reversal_idx on public.stock_movements (reverses_movement_id) where reverses_movement_id is not null;

-- ── vouchers / installments / payments ──────────────────────────────────────
create table public.vouchers (
  id                        uuid primary key default gen_random_uuid(),
  restaurant_id             uuid not null references public.restaurants(id) on delete restrict,
  voucher_no                text not null check (voucher_no ~ '^[A-Z]{2,5}-[0-9]{4,}$'),
  order_id                  uuid not null,
  customer_name             text not null check (char_length(btrim(customer_name)) between 1 and 80),
  customer_phone            text check (customer_phone is null or char_length(customer_phone) <= 40),
  total                     numeric(12,2) not null check (total > 0),
  down_payment              numeric(12,2) not null default 0 check (down_payment >= 0),
  down_payment_method_id    uuid,
  installment_count         integer not null check (installment_count between 1 and 60),
  interval_days             integer not null check (interval_days between 1 and 365),
  created_by                uuid,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  constraint vouchers_tenant_voucher_no_key unique (restaurant_id, voucher_no),
  constraint vouchers_order_key unique (order_id),
  constraint vouchers_tenant_id_key unique (restaurant_id, id),
  constraint vouchers_down_check check (down_payment <= total),
  constraint vouchers_down_method_check check (down_payment = 0 or down_payment_method_id is not null),
  constraint vouchers_order_fk foreign key (restaurant_id, order_id)
    references public.orders (restaurant_id, id) on delete restrict,
  constraint vouchers_down_method_fk foreign key (restaurant_id, down_payment_method_id)
    references public.payment_methods (restaurant_id, id) on delete restrict,
  constraint vouchers_created_by_fk foreign key (restaurant_id, created_by)
    references public.profiles (restaurant_id, id) on delete restrict
);
create index vouchers_tenant_created_idx on public.vouchers (restaurant_id, created_at desc);

create table public.payments (
  id                                uuid primary key default gen_random_uuid(),
  restaurant_id                     uuid not null references public.restaurants(id) on delete restrict,
  day_session_id                    uuid not null,
  order_id                          uuid,
  voucher_id                        uuid,
  installment_no                    integer check (installment_no is null or installment_no > 0),
  kind                              text not null check (kind in ('order_payment','down_payment','installment_payment','reversal')),
  amount                            numeric(12,2) not null check (amount > 0),
  payment_method_id                 uuid not null,
  method_name_snapshot              text not null check (char_length(method_name_snapshot) between 1 and 60),
  method_affects_drawer_snapshot    boolean not null,
  reference                         text check (reference is null or char_length(reference) <= 120),
  receipt_no                        text not null check (receipt_no ~ '^[A-Z]{2,5}-[0-9]{4,}$'),
  reversed_payment_id               uuid,
  created_by                        uuid,
  created_at                        timestamptz not null default now(),
  constraint payments_tenant_receipt_key unique (restaurant_id, receipt_no),
  constraint payments_tenant_id_key unique (restaurant_id, id),
  constraint payments_day_fk foreign key (restaurant_id, day_session_id)
    references public.day_sessions (restaurant_id, id) on delete restrict,
  constraint payments_order_fk foreign key (restaurant_id, order_id)
    references public.orders (restaurant_id, id) on delete restrict,
  constraint payments_voucher_fk foreign key (restaurant_id, voucher_id)
    references public.vouchers (restaurant_id, id) on delete restrict,
  constraint payments_method_fk foreign key (restaurant_id, payment_method_id)
    references public.payment_methods (restaurant_id, id) on delete restrict,
  constraint payments_reversed_fk foreign key (restaurant_id, reversed_payment_id)
    references public.payments (restaurant_id, id) on delete restrict,
  constraint payments_created_by_fk foreign key (restaurant_id, created_by)
    references public.profiles (restaurant_id, id) on delete restrict,
  constraint payments_reversal_check check ((kind = 'reversal') = (reversed_payment_id is not null)),
  constraint payments_order_kind_check check (kind <> 'order_payment' or order_id is not null),
  constraint payments_voucher_kind_check check (kind not in ('down_payment','installment_payment') or voucher_id is not null),
  constraint payments_installment_kind_check check (kind <> 'installment_payment' or installment_no is not null)
);
create unique index payments_one_reversal_idx on public.payments (reversed_payment_id) where reversed_payment_id is not null;
create index payments_order_idx on public.payments (restaurant_id, order_id);
create index payments_voucher_idx on public.payments (restaurant_id, voucher_id);
create index payments_day_idx on public.payments (restaurant_id, day_session_id);
create index payments_tenant_created_idx on public.payments (restaurant_id, created_at desc);
create index payments_method_idx on public.payments (restaurant_id, payment_method_id);

create table public.installments (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references public.restaurants(id) on delete restrict,
  voucher_id     uuid not null,
  no             integer not null check (no > 0),
  due_date       date not null,
  amount         numeric(12,2) not null check (amount > 0),
  paid           boolean not null default false,
  paid_at        timestamptz,
  payment_id     uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint installments_voucher_no_key unique (voucher_id, no),
  constraint installments_tenant_id_key unique (restaurant_id, id),
  constraint installments_voucher_fk foreign key (restaurant_id, voucher_id)
    references public.vouchers (restaurant_id, id) on delete restrict,
  constraint installments_payment_fk foreign key (restaurant_id, payment_id)
    references public.payments (restaurant_id, id) on delete restrict,
  constraint installments_paid_check check (paid = (paid_at is not null) and paid = (payment_id is not null))
);
create index installments_voucher_idx on public.installments (restaurant_id, voucher_id);
create index installments_due_idx on public.installments (restaurant_id, due_date) where not paid;

-- ── expenses ────────────────────────────────────────────────────────────────
create table public.expenses (
  id                              uuid primary key default gen_random_uuid(),
  restaurant_id                   uuid not null references public.restaurants(id) on delete restrict,
  expense_category_id             uuid not null,
  payment_method_id               uuid not null,
  method_name_snapshot            text,        -- filled by trigger, never client-supplied
  method_affects_drawer_snapshot  boolean,     -- filled by trigger
  amount                          numeric(12,2) not null check (amount > 0),
  description                     text check (description is null or char_length(description) <= 300),
  expense_date                    date not null default current_date,
  day_session_id                  uuid,        -- filled by trigger with the open business day
  created_by                      uuid,        -- filled by trigger from auth.uid()
  created_at                      timestamptz not null default now(),
  updated_at                      timestamptz not null default now(),
  constraint expenses_tenant_id_key unique (restaurant_id, id),
  constraint expenses_category_fk foreign key (restaurant_id, expense_category_id)
    references public.expense_categories (restaurant_id, id) on delete restrict,
  constraint expenses_method_fk foreign key (restaurant_id, payment_method_id)
    references public.payment_methods (restaurant_id, id) on delete restrict,
  constraint expenses_day_fk foreign key (restaurant_id, day_session_id)
    references public.day_sessions (restaurant_id, id) on delete restrict,
  constraint expenses_created_by_fk foreign key (restaurant_id, created_by)
    references public.profiles (restaurant_id, id) on delete restrict
);
create index expenses_tenant_date_idx on public.expenses (restaurant_id, expense_date desc);
create index expenses_category_idx on public.expenses (restaurant_id, expense_category_id);
create index expenses_method_idx on public.expenses (restaurant_id, payment_method_id);
create index expenses_day_idx on public.expenses (restaurant_id, day_session_id);

-- ── RLS support helpers that must bypass RLS to avoid orders<->order_items recursion ──
create or replace function public.is_order_owner(p_order_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.orders o
    where o.id = p_order_id
      and o.restaurant_id = (select public.current_restaurant_id())
      and o.created_by = (select public.current_user_id())
  )
$$;

create or replace function public.order_has_station_access(p_order_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.order_items oi
    where oi.order_id = p_order_id
      and oi.restaurant_id = (select public.current_restaurant_id())
      and public.has_station_access(oi.station_id)
  )
$$;

