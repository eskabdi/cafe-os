-- 0002  Platform (SaaS) layer + tenant-agnostic foundations
-- plans, restaurants (tenant root), subscriptions, platform_admins, platform_invoices,
-- admin_audit_log, tenant_counters, audit_logs, idempotency_keys.
-- RLS is enabled for every table in migration 0007; grants are finalised in 0009.

-- ── plans (platform-owned, no restaurant_id) ────────────────────────────────
create table public.plans (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null check (char_length(btrim(name)) between 1 and 60),
  price_etb_monthly  numeric(12,2) not null check (price_etb_monthly >= 0),
  max_staff          integer check (max_staff is null or max_staff > 0),
  max_menu_items     integer check (max_menu_items is null or max_menu_items > 0),
  features           jsonb not null default '{}'::jsonb check (jsonb_typeof(features) = 'object'),
  is_active          boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint plans_name_key unique (name)
);

-- ── restaurants = tenant root ───────────────────────────────────────────────
create table public.restaurants (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null check (char_length(btrim(name)) between 1 and 120),
  slug                text not null,
  custom_domain       text,
  branding            jsonb not null default '{"logo_path": null, "primary_color": "#dc2626", "accent_color": "#b91c1c"}'::jsonb,
  status              text not null default 'trialing',
  vat_rate            numeric(5,2) not null default 15.00,
  opening_float       numeric(12,2) not null default 0,
  auto_consume_stock  boolean not null default true,
  timezone            text not null default 'Africa/Addis_Ababa',
  phone               text check (phone is null or char_length(phone) <= 40),
  address             text check (address is null or char_length(address) <= 300),
  tin                 text check (tin is null or char_length(tin) <= 40),
  suspended_at        timestamptz,
  suspension_reason   text check (suspension_reason is null or char_length(suspension_reason) <= 500),
  status_before_suspension text,
  onboarded_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint restaurants_slug_key unique (slug),
  constraint restaurants_custom_domain_key unique (custom_domain),
  constraint restaurants_slug_format check (
    slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'
    and slug !~ '--'
    and slug not in ('www','api','app','admin','platform','static','assets','auth','login','r','cdn','mail','support')
  ),
  constraint restaurants_domain_format check (
    custom_domain is null
    or (custom_domain = lower(custom_domain)
        and custom_domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$')
  ),
  constraint restaurants_status_check check (status in ('trialing','active','past_due','suspended','cancelled')),
  constraint restaurants_prev_status_check check (
    status_before_suspension is null
    or status_before_suspension in ('trialing','active','past_due')
  ),
  constraint restaurants_vat_check check (vat_rate between 0 and 100),
  constraint restaurants_float_check check (opening_float >= 0),
  -- Branding is validated in the database: only hex colours and a tenant-scoped storage path
  -- (never a URL, data: URI or base64 blob).
  constraint restaurants_branding_check check (
    jsonb_typeof(branding) = 'object'
    and (branding ->> 'primary_color') ~ '^#[0-9a-fA-F]{6}$'
    and (branding ->> 'accent_color') ~ '^#[0-9a-fA-F]{6}$'
    and (
      (branding -> 'logo_path') is null
      or jsonb_typeof(branding -> 'logo_path') = 'null'
      or (jsonb_typeof(branding -> 'logo_path') = 'string'
          and (branding ->> 'logo_path') ~ '^restaurants/[0-9a-f-]{36}/[A-Za-z0-9._/-]{1,200}$'
          and (branding ->> 'logo_path') !~ '\.\.')
    )
  )
);

-- ── subscriptions (one per tenant) ──────────────────────────────────────────
create table public.subscriptions (
  id                    uuid primary key default gen_random_uuid(),
  restaurant_id         uuid not null references public.restaurants(id) on delete restrict,
  plan_id               uuid not null references public.plans(id) on delete restrict,
  status                text not null check (status in ('trialing','active','past_due','suspended','cancelled')),
  trial_ends_at         timestamptz,
  current_period_start  timestamptz not null default now(),
  current_period_end    timestamptz not null,
  cancel_at_period_end  boolean not null default false,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint subscriptions_restaurant_key unique (restaurant_id),
  constraint subscriptions_period_check check (current_period_end > current_period_start)
);
create index subscriptions_plan_idx on public.subscriptions (plan_id);

-- ── platform_admins: CafeOS staff. Never derivable from tenant profiles. ───
create table public.platform_admins (
  id          uuid primary key references auth.users(id) on delete restrict,
  full_name   text not null check (char_length(btrim(full_name)) between 1 and 120),
  role        text not null check (role in ('platform_super_admin','platform_support')),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ── platform_invoices: CafeOS billing a tenant (distinct from tenant payments) ─
create table public.platform_invoices (
  id               uuid primary key default gen_random_uuid(),
  restaurant_id    uuid not null references public.restaurants(id) on delete restrict,
  subscription_id  uuid not null references public.subscriptions(id) on delete restrict,
  amount           numeric(12,2) not null check (amount >= 0),
  period_start     date not null,
  period_end       date not null,
  status           text not null check (status in ('pending','paid','overdue','void')),
  method           text check (method is null or method in ('telebirr','chapa','manual_bank_transfer')),
  reference        text check (reference is null or char_length(reference) <= 120),
  paid_at          timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint platform_invoices_period_check check (period_end >= period_start),
  constraint platform_invoices_paid_check check ((status = 'paid') = (paid_at is not null))
);
create index platform_invoices_restaurant_idx on public.platform_invoices (restaurant_id, created_at desc);
create index platform_invoices_subscription_idx on public.platform_invoices (subscription_id);

-- ── admin_audit_log: append-only trail of platform-admin actions ────────────
create table public.admin_audit_log (
  id                 uuid primary key default gen_random_uuid(),
  platform_admin_id  uuid references public.platform_admins(id) on delete restrict, -- null = service job
  restaurant_id      uuid references public.restaurants(id) on delete restrict,
  action             text not null check (char_length(action) between 1 and 80),
  detail             jsonb,
  created_at         timestamptz not null default now()
);
create index admin_audit_log_created_idx on public.admin_audit_log (created_at desc);
create index admin_audit_log_restaurant_idx on public.admin_audit_log (restaurant_id, created_at desc);
create index admin_audit_log_admin_idx on public.admin_audit_log (platform_admin_id);

-- ── tenant_counters: gap-free-ish per-tenant number sequences (order_no, receipt_no ...) ─
create table public.tenant_counters (
  restaurant_id  uuid not null references public.restaurants(id) on delete restrict,
  counter_key    text not null check (counter_key in ('order','receipt','voucher')),
  last_value     bigint not null default 0 check (last_value >= 0),
  updated_at     timestamptz not null default now(),
  primary key (restaurant_id, counter_key)
);

-- Returns e.g. 'ORD-0001'. Internal only: no client has EXECUTE (migration 0009).
create or replace function public.fn_next_number(p_restaurant_id uuid, p_key text, p_prefix text, p_pad integer default 4)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_val bigint;
begin
  insert into public.tenant_counters as c (restaurant_id, counter_key, last_value)
  values (p_restaurant_id, p_key, 1)
  on conflict (restaurant_id, counter_key)
  do update set last_value = c.last_value + 1, updated_at = now()
  returning c.last_value into v_val;
  return p_prefix || lpad(v_val::text, p_pad, '0');
end;
$$;

-- ── audit_logs: tenant audit trail (append-only, written only by definer code) ─
create table public.audit_logs (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references public.restaurants(id) on delete restrict,
  actor_id       uuid,                 -- auth.uid() at write time; deliberately no FK (platform admins / service jobs)
  actor_type     text not null check (actor_type in ('user','platform_admin','system')),
  event          text not null check (char_length(event) between 1 and 120),
  action         text not null check (action in ('insert','update','delete','event')),
  table_name     text,
  record_id      text,
  old_data       jsonb,
  new_data       jsonb,
  created_at     timestamptz not null default now()
);
create index audit_logs_restaurant_created_idx on public.audit_logs (restaurant_id, created_at desc);
create index audit_logs_record_idx on public.audit_logs (restaurant_id, table_name, record_id);
create index audit_logs_actor_idx on public.audit_logs (restaurant_id, actor_id);

-- ── idempotency_keys: tenant-scoped command de-duplication ──────────────────
create table public.idempotency_keys (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete restrict,
  key           text not null check (char_length(key) between 8 and 128),
  command       text not null check (char_length(command) between 1 and 80),
  request_hash  text,
  result        jsonb,
  created_by    uuid,
  created_at    timestamptz not null default now(),
  constraint idempotency_keys_tenant_key unique (restaurant_id, key)
);
create index idempotency_keys_created_idx on public.idempotency_keys (restaurant_id, created_at);
