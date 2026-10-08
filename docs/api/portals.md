# Portal API (Phase 3B): Platform Admin Portal and Tenant Portal

OpenAPI-style reference of the database RPCs (PostgREST `POST /rest/v1/rpc/<name>`) and Edge Functions (`POST /functions/v1/<name>`) added or
reused for the two portals (execution prompt §34A). Migrations: `20261003003000_platform_portal.sql`, `20261003003100_tenant_portal.sql`.

## Conventions

- **Classification**
  - **Public**: callable without a session (anon key). None of the portal endpoints is public; the only public RPC stays `fn_resolve_tenant_slug`.
  - **Private**: needs a signed-in user JWT (`authenticated`); authorisation is decided by the database from the JWT subject (and `aal` claim).
  - **Internal**: not callable by any client role (no EXECUTE for `anon` / `authenticated`); `service_role` only (Edge Functions, ops) or definer-internal.
- **Transport**: `Authorization: Bearer <access token>`, `apikey: <anon key>`, JSON body = named parameters (`p_...`). Responses are JSON (`jsonb`).
- **Errors** (RPC): HTTP 400 from PostgREST with `{ "code": "P0001", "message": "<machine_code>", "details": "<safe detail or null>" }`. The client maps
  `message`; `details` is a field name / safe context, never SQL or another tenant's data. Privilege errors (no EXECUTE) are `42501`.
  Unknown and foreign ids are both `not_found` (no existence oracle).
- **Platform guard** (`fn_platform_guard`, every `fn_platform_*`): `not_authenticated` | `permission_denied` (anyone but an ACTIVE `platform_super_admin`,
  including every tenant user) | `mfa_required` (JWT not `aal2`, or no verified TOTP factor on the account). No opt-out.
- **Tenant guard** (every tenant RPC): tenant from identity (`fn_tenant_status_guard`): `not_authenticated` | `permission_denied` (no active profile:
  every platform admin) | `tenant_suspended` | `tenant_read_only` (past_due write). Then the permission (`permission_denied`), then step-up:
  `fn_require_step_up` (`mfa_required` for an enrolled caller on aal1) or `fn_require_aal2` (`mfa_required` unless aal2 + live factor + non-PIN account).
- **Audit**: every successful write appends an `audit_logs` event of the tenant; platform writes also append `admin_audit_log` (actor = the super admin).
  No-ops (`changed: false`) write nothing.
- **Idempotency**: these commands are naturally idempotent or replay-safe: set-state RPCs return `changed: false` on replay; creates are protected by
  unique keys (`slug_taken`, `duplicate_name`, `invalid_state/invoice_exists`, `email_in_use`); no idempotency key parameter is needed.

---

## Platform Admin Portal (`/platform/*`) — actor: Super Admin, aal2

### Tenants

| endpoint | class | parameters | returns |
|---|---|---|---|
| `fn_platform_list_tenants` | Private | `p_search text?` (≤100, name/slug, case-insensitive), `p_status text?` (`trialing|active|past_due|suspended|cancelled`), `p_plan_id uuid?`, `p_limit int = 50` (1..100), `p_offset int = 0` | `{ total, limit, offset, items: [{ id, name, slug, status, created_at, suspended_at, plan: {id, name}, subscription_status, trial_ends_at, current_period_end }] }` (newest first) |
| `fn_platform_get_tenant` | Private | `p_restaurant_id uuid` | tenant metadata (`id, name, slug, status, custom_domain, timezone, phone, address, tin, onboarded_at, suspended_at, suspension_reason, created_at, updated_at`), `subscription {.., plan}`, `limits`, `usage`, `over_quota`, `invitations[]` (last 20), `recent_invoices[]` (last 5) |
| `fn_platform_create_tenant` | Private | `p_name`, `p_slug`, `p_plan_id`, `p_trial_days int = 14` (0..90; 0 = active), `p_timezone = 'Africa/Addis_Ababa'` | `{ restaurant_id, slug, status, day_session_id }` — default roles/stations/categories/payment methods/areas/expense categories seeded as rows, day 1 open, **no owner** (invite one) |
| `fn_provision_tenant` (reused) | Private + Internal | unchanged signature (owner must already exist with a confirmed e-mail) | unchanged; platform callers now need aal2 (`fn_platform_guard`), service_role unchanged |
| `fn_platform_change_plan` | Private | `p_restaurant_id`, `p_plan_id` (active), `p_reason` (3..500) | `{ restaurant_id, plan_id, changed, over_quota: ["staff"|"menu_items"|"stations"|"kiosks"|"storage"|"orders"] }` (a downgrade below usage is allowed and reported) |
| `fn_platform_set_billing_status` | Private | `p_restaurant_id`, `p_status` (`trialing|active|past_due`), `p_reason` | `{ restaurant_id, status, changed }`; not for suspended / cancelled tenants |
| `fn_suspend_tenant` / `fn_reactivate_tenant` (reused) | Private | `p_restaurant_id`, `p_reason` | `{ restaurant_id, status, changed }` |
| `fn_platform_cancel_tenant` | Private | `p_restaurant_id`, `p_reason`, `p_confirm_slug` (must equal the slug) | `{ restaurant_id, status: "cancelled", changed }`; terminal (no reactivation RPC); pending invitations revoked; nothing deleted |

`usage` (aggregates only): `active_staff, active_tenant_admins, menu_items, stations, kiosks, storage_bytes, storage_objects, orders_last_30_days,
orders_this_month, pending_invitations`. `limits`: `max_staff, max_menu_items, max_stations, max_kiosks, max_storage_bytes, max_orders_per_month` (null = unlimited).

Example:
```http
POST /rest/v1/rpc/fn_platform_create_tenant
{ "p_name": "Fresh Cafe", "p_slug": "fresh-cafe", "p_plan_id": "8f0c…", "p_trial_days": 14 }
200 { "restaurant_id": "2b1e…", "slug": "fresh-cafe", "status": "trialing", "day_session_id": "9a77…" }
400 { "code": "P0001", "message": "slug_taken", "details": null }
400 { "code": "P0001", "message": "mfa_required", "details": null }
```
Errors: `invalid_input` (`name|trial_days|reason|status|search|limit|offset|confirm_slug`), `invalid_slug`, `slug_taken`, `invalid_plan`, `invalid_timezone`,
`not_found`, `invalid_state` (`cancelled|suspended|past_due|…`).

### Plans catalogue

| endpoint | class | parameters | returns |
|---|---|---|---|
| `fn_platform_list_plans` | Private | – | `[plan]` incl. inactive, with `subscriber_count` |
| `fn_platform_create_plan` | Private | `p_plan jsonb` keys: `name` (req), `price_etb_monthly` (req, ≥0, ≤10,000,000, max 2 decimals), `description`, `max_staff`, `max_menu_items`, `max_stations`, `max_kiosks`, `max_orders_per_month` (positive int or null), `max_storage_bytes` (≤1 TiB or null), `features` (object ≤50 keys `^[a-z][a-z0-9_]{0,39}$`, boolean/number/short string), `sort_order` | `plan` |
| `fn_platform_update_plan` | Private | `p_plan_id`, `p_patch jsonb` (same keys) | `plan` |
| `fn_platform_set_plan_active` | Private | `p_plan_id`, `p_active boolean` | `plan` (no delete: subscriptions reference plans with RESTRICT) |

Errors: `invalid_input` (`patch` for an unknown key, else the field), `duplicate_name` (detail = the name), `not_found`.

### Invoices

| endpoint | class | parameters | returns |
|---|---|---|---|
| `fn_platform_list_invoices` | Private | `p_restaurant_id?`, `p_status?` (`pending|paid|overdue|void`), `p_limit = 50` (1..200), keyset `p_before timestamptz?`, `p_before_id uuid?` (pass the last row's `created_at` and `id`) | `[{ id, restaurant {id,name,slug}, subscription_id, amount, period_start, period_end, status, method, reference, paid_at, created_at, updated_at }]` |
| `fn_platform_create_invoice` | Private | `p_restaurant_id`, `p_amount` (max 2 decimals), `p_period_start`, `p_period_end` (≤400 days), `p_reference?` | invoice (`pending`); a second live invoice for the same period → `invalid_state/invoice_exists` |
| `fn_platform_set_invoice_status` | Private | `p_invoice_id`, `p_status` (`paid|overdue|void`), `p_method?` (required for `paid`; platform billing channel), `p_reference?` | invoice; `paid` and `void` are final (`invalid_state/<status>`) |

### System health and backups

| endpoint | class | returns |
|---|---|---|
| `fn_platform_system_health` | Private | `{ checked_at, database {reachable, server_version, size_bytes, started_at, connections, max_connections}, migrations {latest, count, source}, largest_tables[15], storage[{bucket, objects, bytes}], tenants {total, by_status}, counters {tenant_audit_events_24h, platform_audit_events_24h, pin_lockouts_active, pin_changes_pending_approval, invitations_pending, invitations_expired, backup_failures_7d}, backups {last_success_at, last_success_age_hours, stale (> 26 h), last_run} }` |
| `fn_platform_list_backup_runs` | Private | `p_limit = 50`, keyset `p_before`, `p_before_id` → `[{ id, kind, status, started_at, finished_at, size_bytes, location, checksum_sha256, error_code, note }]` |

DB-side checks only. The portal additionally pings Auth (`/auth/v1/health`), Storage, Realtime and each Edge Function (OPTIONS) from the browser and shows
them next to this payload. **Backups**: the Supabase platform takes the actual backups (daily snapshots; PITR on plans that include it); the ops backup job
(service role) records every run (and its own logical dump / storage copy / restore drill) in `platform_backup_runs`. Clients never write that table.

### Platform audit log and Super Admin accounts

| endpoint | class | parameters | returns |
|---|---|---|---|
| `fn_platform_list_audit_log` | Private | `p_limit = 50` (1..200), keyset `p_before`, `p_before_id`, filters `p_restaurant_id?`, `p_action_prefix?` (`^[a-z_.]{1,80}$`, e.g. `tenant.`), `p_admin_id?` | `[{ id, created_at, action, detail, actor {id, full_name} | null (service job), restaurant {id, name, slug} | null }]` |
| `fn_platform_list_admins` | Private | – | `[{ id, full_name, role, is_active, email, mfa_enrolled, is_self, created_at, updated_at }]` |
| `fn_platform_set_admin_active` | Private | `p_admin_id`, `p_active`, `p_reason` | `{ id, is_active, changed }`; never yourself (`invalid_state/self`); the last active super admin → `last_platform_super_admin` |
| `fn_ops_register_platform_admin` | **Internal** (service_role, ops) | `p_user_id`, `p_full_name` | `{ id, role }`; adding a Super Admin is an ops procedure (auth-flows.md) |

---

## Tenant Admin invitation (both portals)

| endpoint | class | caller |
|---|---|---|
| `tenant-admin-invite` (Edge Function) | Private | Super Admin (aal2, names `restaurant_id`) or tenant_admin (aal2, own tenant) |
| `fn_prepare_tenant_admin_invitation(p_restaurant_id, p_email, p_first_name, p_middle_name, p_last_name, p_username)` | Private (used by the function, as the caller) | same |
| `fn_prepare_tenant_admin_invitation_resend(p_invitation_id)` | Private (used by the function) | same |
| `fn_revoke_tenant_admin_invitation(p_invitation_id)` | Private | same (a direct call revokes too; the function also deletes the never-confirmed Auth user) |
| `fn_list_tenant_admin_invitations()` | Private | tenant_admin, own tenant |
| `fn_get_my_invitation()` | Private | the invitee (signed in from the e-mail link, no profile yet): `{ invitation_id, restaurant {name, slug}, email, username, expires_at, expired }` or null |
| `fn_accept_tenant_admin_invitation()` | Private | the invitee: `{ profile_id, restaurant_id, slug }` — creates its `tenant_admin` profile (password login) |
| `fn_attach_tenant_admin_invitation(p_invitation_id, p_auth_user_id)`, `fn_abort_tenant_admin_invitation(p_invitation_id)` | Internal (service_role) | tenant-admin-invite only |

```http
POST /functions/v1/tenant-admin-invite
{ "action": "invite", "restaurant_id": "2b1e…", "email": "almaz@fresh.example.com", "first_name": "Almaz", "username": "almaz" }
201 { "invitation_id": "c0de…", "expires_at": "2026-10-15T09:00:00Z" }
409 { "error": "email_in_use" }        403 { "error": "mfa_required" }        429 { "error": "try_later" }

POST /rest/v1/rpc/fn_accept_tenant_admin_invitation   {}
200 { "profile_id": "7e1f…", "restaurant_id": "2b1e…", "slug": "fresh-cafe" }
400 { "code": "P0001", "message": "invitation_expired", "details": null }
```
Errors: `invalid_input` (`email|first_name|middle_name|last_name|username|restaurant_id`), `email_in_use` (any existing Auth account or pending invitation),
`username_taken`, `staff_limit_reached` (active staff + pending invitations ≥ plan `max_staff`), `tenant_suspended`, `not_found`, `invalid_state`
(`already_attached|already_confirmed|accepted|…`), `invite_rate_limited` (60 s gap, 5 sends), `invalid_auth_user`, `invitation_expired` (7 days),
`owner_email_unconfirmed`, `owner_email_mismatch`, `owner_already_assigned`.

---

## Tenant Portal (`/r/<slug>/*`) — actor: tenant_admin (or a delegate holding the permission)

### Roles, permission matrix, station access (`roles.manage`, step-up)

| endpoint | class | parameters | returns / rules |
|---|---|---|---|
| `fn_list_roles` | Private | – | `[{ id, name, description, color, icon, sort_order, is_active, is_system, system_key, active_users, total_users, permission_keys[], station_ids[], created_at, updated_at }]` |
| `fn_create_role` | Private | `p_role jsonb` keys `name` (req, ≤60), `description` (≤300), `color` (`#rrggbb`, stored lower-case), `icon` (`^[a-z0-9][a-z0-9-]{0,39}$`), `sort_order` | role; starts with no permission; never a system role |
| `fn_update_role` | Private | `p_role_id`, `p_patch jsonb` (same keys) | role |
| `fn_set_role_active` | Private | `p_role_id`, `p_active` | role + `changed`; deactivation refused while ACTIVE users hold it: `role_in_use` (detail `active_users:<n>`) |
| `fn_delete_role` | Private | `p_role_id` | `{ role_id, deleted }`; only a role no profile ever held (`role_in_use`, detail `users:<n>`); its matrix and station rows go with it |
| `fn_update_role_permissions` (reused) | Private | `p_role_id`, `p_permission_keys text[]`, `p_station_ids uuid[]` | `{ role_id, added, removed, stations_added, stations_removed }` |
| `fn_set_role_station_access` | Private | `p_role_id`, `p_station_ids uuid[]` (≤200) | same as above (keeps the permission keys) |

Rules: the `tenant_admin` system role is never renamed / edited / disabled / deleted (`system_role_protected`); a caller never edits its own role
(`permission_denied`, detail `cannot edit your own role`); a non-tenant_admin may only touch roles it fully covers and never grants what it lacks
(`permission_escalation`); foreign / unknown ids `not_found`, foreign stations `invalid_station`; `duplicate_name` (normalised, per tenant).

### Users (`users.view` / `users.manage`)

| endpoint | class | parameters | returns / rules |
|---|---|---|---|
| `fn_list_users` | Private | `p_include_inactive = true` | `[{ id, first_name, middle_name, last_name, short_name, full_name, username, is_active, auth_method, identity_rotation_pending, role {..}, email (password accounts only), mfa_enrolled (password accounts only), pin {set, length, locked, locked_until, failed_attempts, must_change, pending_approval, changed_at} (users.manage, PIN accounts only; never the hash), created_at, updated_at }]` |
| `staff-create` (Edge Function, reused) | Private | see `supabase/functions/staff-create/README.md` | `{ profile_id }` |
| `fn_update_user` | Private | `p_profile_id`, `p_patch` keys `first_name`, `middle_name`, `last_name` (username is part of the synthetic identity: not editable) | user |
| `fn_set_user_active` | Private, step-up | `p_profile_id`, `p_active` | `{ profile_id, is_active, changed }`; never yourself; tenant_admin targets need a tenant_admin caller; last active tenant_admin protected (`last_tenant_admin`); reactivation needs an active role (`invalid_role`) and a free staff slot (`staff_limit_reached`); escalation guard (`permission_escalation`) |
| `fn_change_user_role` (reused) | Private, step-up | `p_profile_id`, `p_role_id` | see rpc-conventions.md |
| `fn_reset_pin_lockout` (reused) | Private | `p_profile_id` | `{ profile_id, reset }` |
| `staff-pin-reset` (Edge Function) | Private, step-up | `{ profile_id, pin }` | `{ profile_id, pin_reset: true }`; see its README |
| `fn_prepare_pin_reset` | Private (used by staff-pin-reset) | `p_profile_id` | `{ profile_id, role_name, pin_length }`; `pin_not_allowed` (admins), `invalid_state/inactive`, `permission_escalation`, `not_found` |
| `fn_set_user_pin` (reused) | Internal (service_role) | `p_profile_id`, `p_pin_digest`, `p_pin_length` | – |
| invite a co-admin | Private | `tenant-admin-invite` without `restaurant_id` (aal2) | see above |

### Restaurant profile, business settings, branding, subscription (`settings.manage`)

| endpoint | class | parameters | returns / rules |
|---|---|---|---|
| `fn_get_restaurant_profile` | Private | – | `{ id, name, slug, status, phone, address, timezone, tin, vat_rate, opening_float, auto_consume_stock, stock_stepup_threshold, branding, updated_at }` |
| `fn_update_restaurant_profile` | Private, step-up | `p_patch` keys `name` (≤120), `phone` (`^\+?[0-9][0-9 ()-]{2,38}$` or null), `address` (≤300 or null), `timezone` (tz database name) | profile; `invalid_timezone` |
| `fn_update_business_settings` | Private, **aal2** | `p_patch` keys `tin` (`^[A-Za-z0-9/-]{1,40}$` or null), `vat_rate` (0..100, 2 decimals), `opening_float` (≥0, 2 decimals), `auto_consume_stock` (boolean) | profile |
| `fn_update_restaurant_branding` | Private, step-up | `p_primary_color`, `p_accent_color` (strict `#rrggbb`, stored lower-case), `p_logo_path` (null clears; else `restaurants/<own id>/branding/<file>.(png|jpg|jpeg|webp)` that exists in bucket `tenant-branding`) | profile |
| Storage `tenant-branding` | Private | upload `restaurants/<own id>/branding/<file>` (≤1 MiB, png/jpeg/webp), read by members with a signed URL | the current logo cannot be replaced in place or deleted |
| `fn_get_subscription_usage` | Private | – | `{ usage, limits, over_quota, subscription {status, trial_ends_at, current_period_*, plan {id, name, description, price_etb_monthly, features}} }` |

Errors: `invalid_input` (`patch` / the field), `invalid_timezone`, `permission_denied`, `mfa_required`, `tenant_read_only`, `tenant_suspended`.

---

## Separation guarantees (tested)

- A Super Admin reads **zero rows** of every tenant operational table and every tenant RPC answers `permission_denied` (`34_portal_separation`, catalog-driven:
  a new table / RPC is covered automatically).
- Every platform RPC answers `permission_denied` to every tenant user (tenant_admin on aal2 included), `mfa_required` to an aal1 / factor-less Super Admin,
  `permission_denied` to an inactive one, and is not executable by anon or service_role.
- One account = one portal: a platform admin never gets a profile, a tenant user never becomes a platform admin, ops registration and invitations refuse
  existing accounts, and the two guards serialise on a per-user lock (race test).

## Open questions for the owner

1. Plan quotas `max_stations`, `max_kiosks`, `max_storage_bytes`, `max_orders_per_month` are **monitored** (usage vs quota, `over_quota`), not yet enforced at
   creation time (staff and menu items are). Enforce (hard stop) or warn only?
2. A plan downgrade below current usage is allowed and reported. Refuse instead?
3. Cancellation is terminal (no restore RPC; data retained). Is a "restore cancelled tenant" path wanted, and what is the data-retention period?
4. Logos live in a private bucket (signed URLs). The pre-login tenant page (`fn_resolve_tenant_slug` returns `logo_path`) cannot show it without a session:
   public logo bucket, or a signed-URL Edge Function for the login page?
5. `staff-pin-reset` does not revoke the staff member's existing sessions (no admin session-revoke by user id in supabase-js). Should a reset also force sign-out
   (needs a GoTrue admin call or the single-session machinery)?
6. Platform admins keep direct RLS reads of `restaurants` / `subscriptions` / `plans` / `platform_invoices` / `admin_audit_log` (needed by `platform_support`);
   should all platform reads go through RPCs only, and should the `platform_support` role (read-only staff) appear in the portal at all?
7. Local development: the demo Super Admin now needs a real TOTP enrolment for the Platform Admin Portal (no GUC bypass for platform RPCs). Acceptable?
