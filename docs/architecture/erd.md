# CafeOS entity-relationship diagram (Phase 1 schema)

Source of truth: `supabase/migrations/*.sql`. Every tenant table carries `restaurant_id`; child tables reference
parents through **composite foreign keys** `(restaurant_id, parent_id)` so a cross-tenant reference is impossible
at the schema level. All business FKs are `ON DELETE RESTRICT` (soft-deactivate with `is_active`).

## Platform and identity

```mermaid
erDiagram
    restaurants ||--|| subscriptions : "has one"
    plans ||--o{ subscriptions : "priced by"
    restaurants ||--o{ platform_invoices : billed
    subscriptions ||--o{ platform_invoices : "generates (composite FK restaurant_id+subscription_id)"
    platform_admins ||--o{ admin_audit_log : performs
    restaurants ||--o{ admin_audit_log : "subject of"
    auth_users ||--o| platform_admins : "is (platform_super_admin | platform_support)"
    auth_users ||--o| profiles : "is staff"
    restaurants ||--o{ profiles : employs
    roles ||--o{ profiles : "assigned (RESTRICT)"
    profiles ||--o| profile_secrets : "PIN hash (staff only)"
    profiles ||--o{ user_notifications : "recipient (composite FK)"
    restaurants ||--o{ user_notifications : scopes
    restaurants ||--o{ roles : defines
    roles ||--o{ role_permissions : grants
    permissions ||--o{ role_permissions : "global catalog"
    roles ||--o{ role_station_access : "may operate"
    stations ||--o{ role_station_access : "operated by"
    restaurants ||--o{ audit_logs : "append-only"
    restaurants ||--o{ idempotency_keys : dedupes
    restaurants ||--o{ tenant_counters : numbers
    profiles { uuid id PK "= auth.users.id" text auth_method "password (tenant_admin) | pin (staff)" text first_name text middle_name text last_name text short_name "generated first+middle" bool identity_rotation_pending "demoted admin awaiting synthetic identity" }
    user_notifications { uuid id PK uuid restaurant_id uuid recipient_id text kind "security.concurrent_login_blocked" jsonb payload "no secrets" timestamptz created_at timestamptz read_at "only mutable column" }
    profile_secrets { uuid profile_id PK text pin_hash smallint pin_length bool must_change_pin "forced PIN change; has_permission denies while true" bool pin_change_pending "changed, awaiting tenant_admin approval; also restricted; never with must_change_pin" timestamptz pin_change_requested_at }
    roles { uuid id PK text system_key "null | tenant_admin" boolean is_system }
    restaurants { uuid id PK text slug UK text status "trialing|active|past_due|suspended|cancelled" jsonb branding "CHECK hex colours + storage path" }
```

## Six dynamic domains and operations

```mermaid
erDiagram
    restaurants ||--o{ stations : ""
    restaurants ||--o{ categories : ""
    restaurants ||--o{ payment_methods : ""
    restaurants ||--o{ table_areas : ""
    restaurants ||--o{ expense_categories : ""
    categories ||--o{ menu_items : classifies
    stations ||--o{ menu_items : "prepared at"
    stations ||--o{ ingredients : "stocked at"
    menu_items ||--o{ recipe_lines : uses
    ingredients ||--o{ recipe_lines : "consumed by"
    ingredients ||--o{ stock_movements : "ledger (append-only)"
    table_areas ||--o{ tables : contains
    tables ||--o{ table_sessions : hosts
    tables ||--o{ qr_credentials : "one active (partial unique)"
    qr_credentials ||--o{ customer_sessions : opens
    table_sessions ||--o{ customer_sessions : ""
    day_sessions ||--o{ orders : contains
    tables ||--o{ orders : "optional"
    orders ||--o{ order_items : contains
    menu_items ||--o{ order_items : "snapshot of"
    stations ||--o{ order_items : "routes to (+name snapshot)"
    orders ||--o| vouchers : "financed by"
    vouchers ||--o{ installments : schedules
    orders ||--o{ payments : settles
    vouchers ||--o{ payments : collects
    payment_methods ||--o{ payments : "snapshot + FK"
    payments ||--o| payments : "reversed_payment_id"
    payments ||--o| installments : "payment_id"
    expense_categories ||--o{ expenses : ""
    payment_methods ||--o{ expenses : "paid with"
    day_sessions ||--o{ expenses : "filled by trigger"
    day_sessions ||--o{ payments : ""
    payment_methods { boolean affects_cash_drawer "data flag, no name logic" boolean requires_reference }
    day_sessions { text status "open|closed (closed rows immutable)" jsonb station_snapshot jsonb expense_snapshot jsonb payment_snapshot }
    payments { text kind "order_payment|down_payment|installment_payment|reversal" text method_name_snapshot boolean method_affects_drawer_snapshot }
    orders { text order_no "unique per tenant" text client_key "idempotency, unique per tenant" text source "staff|qr" }
```

Every table in the six-domain group has: `id, restaurant_id, name, normalized_name (generated), description, color, icon,
sort_order, is_active, created_at, updated_at` and `unique (restaurant_id, normalized_name)`; roles add `is_system, system_key`.
No PostgreSQL enums exist in `public`; workflow states are `text` + CHECK.

Note: `auth_users` is Supabase's `auth.users`.

Additions in migrations 0011-0018: `orders.station_ids uuid[]` (trigger-maintained from order_items, used by RLS), `expenses.category_name_snapshot`,
`profiles.identity_rotation_pending`, `subscriptions` unique `(restaurant_id, id)` (target of the composite invoice FK), `idempotency_keys` unique
`(restaurant_id, key, command)`, `expenses.expense_date` derived (no default), indexes on `stock_movements.day_session_id`, `orders.table_session_id`,
`orders.customer_session_id`, `table_sessions.day_session_id`, `installments.payment_id`, `vouchers.down_payment_method_id`. FK-index rule and its reviewed
exceptions (tenant-root and actor FKs): `21_validation_invariants`.

Migration 0023: `profile_secrets.must_change_pin boolean`, table `user_notifications` (unique `(restaurant_id, id)`, composite FK `(restaurant_id, recipient_id)` to `profiles`, RESTRICT),
read-only reference to `auth.sessions` (GoTrue) by the service-only `fn_staff_has_active_session`.

Migration 0024: `profile_secrets.pin_change_pending boolean not null default false`, `pin_change_requested_at timestamptz`, CHECK `not (must_change_pin and pin_change_pending)`; new `user_notifications.kind` values `security.pin_change_pending_approval|approved|rejected`. No new table.
