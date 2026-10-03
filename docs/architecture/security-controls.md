# Security controls (Phase 1 database layer)

| control | implementation | verified by |
|---|---|---|
| Tenant isolation | `restaurant_id` on every tenant table; RLS enabled+forced everywhere; policies use identity helpers derived from `profiles`; composite FKs make cross-tenant references impossible; `restaurant_id` immutable (trigger) and not client-writable (column grants) | `02_tenant_isolation.sql` |
| No client-trusted claims | tenant/role/permissions never read from JWT custom claims | helpers in migration 0004 |
| Authorization | editable role→permission matrix (`role_permissions`, `role_station_access`) as UX layer; RLS/RPC as ceiling; no escalation through `fn_update_role_permissions` / `fn_change_user_role` | `03_integrity.sql` |
| Authentication methods | **tenant_admin and platform admins: Supabase Auth email + password (MFA-capable), never PIN. Non-admin staff: server-verified PIN.** `profiles.auth_method` ('password'/'pin') is forced consistent with the role by trigger; PIN staff must have a synthetic non-routable email (`*.staff.cafeos.invalid`), admins a real one; `profile_secrets` rows are rejected by trigger for admins/platform admins; PIN RPCs return the same result for admins as for unknown accounts; promotion deletes the PIN secret, demotion requires a new PIN; `fn_user_auth_method` lets an Auth hook block password login for PIN-only staff | `04_auth_methods.sql` |
| PIN secrecy and lockout | bcrypt in `profile_secrets` (RLS on, no policies, all client privileges revoked); 5 failures → 15 min lock; `pin_hash` never returned | `04_auth_methods.sql` |
| Platform/tenant boundary | `platform_admins` is a separate table; platform_super_admin is not derivable from `profiles`; platform tables write-limited to super admins; suspension/reactivation audited in `admin_audit_log` | `03_integrity.sql`, `02_tenant_isolation.sql` |
| Tenant suspension | suspended/cancelled resolve to no tenant (no read/write); past_due read-only; RPCs call `fn_tenant_status_guard` | `02_tenant_isolation.sql` |
| Immutability | triggers (fire for service_role and the owner too) on `audit_logs`, `admin_audit_log`, `payments`, `stock_movements`; closed `day_sessions` frozen and never deleted; closed-day expenses frozen | `03_integrity.sql` |
| Audit | row audit trigger (`fn_audit_row`, secrets stripped, changed columns only) on config domains, roles, matrix, profiles, menu, restaurants, QR, days, expenses; event audit via `fn_write_audit`; actor always `auth.uid()`; no INSERT grant to clients | `03_integrity.sql` |
| Safe deletion | every business FK `ON DELETE RESTRICT`; `tenant_admin` role cannot be deleted, deactivated, re-keyed or stripped; last active tenant_admin protected | `01_structure.sql`, `03_integrity.sql` |
| Privilege hygiene | default privileges revoked; only explicit grants (migration 0009); sensitive columns (token hashes, stock columns, system flags) excluded via column grants; internal functions have no client EXECUTE | `03_integrity.sql`, `04_auth_methods.sql` |
| Secrets in data | branding validated by CHECK (hex colours, tenant-scoped storage path, no URLs/base64); `menu_items.image_path` must be `restaurants/<own id>/...` | `03_integrity.sql` |
| Slug resolver | `fn_resolve_tenant_slug` returns only id/name/branding; unknown/suspended identical | `02_tenant_isolation.sql` |

Not covered yet (later phases): Storage policies, realtime channel authorization tests, order/payment/stock RPCs, rate limiting of the resolver and the pin-login Edge Function, Auth hook wiring.
