# Data-flow diagrams

## Level 0
```mermaid
flowchart LR
    subgraph TB1["Trust boundary: untrusted clients"]
        staff["Staff devices (waiter, cashier, KDS)"]
        admin["Tenant admin / owner"]
        guest["QR customer"]
        pa["Platform admin"]
    end
    subgraph TB2["Trust boundary: Supabase project"]
        api["PostgREST / Realtime / Auth (JWT verified)"]
        edge["Edge Functions (service_role confined): pin-login, pin-change, staff-create, staff-roster, staff-pin-reset, tenant-admin-invite, tenant-admin-mfa-reset, billing webhook"]
        db[("PostgreSQL: RLS + security-definer RPCs + triggers")]
    end
    staff -->|JWT, intents only| api
    admin -->|email + password (+MFA)| api
    pa -->|email + password (+MFA)| api
    guest -->|QR token via RPC| api
    staff -->|profile + PIN| edge  %% edge hashes PIN with PIN_PEPPER; DB only gets the digest
    api -->|role: authenticated / anon| db
    edge -->|role: service_role, never in browser| db
```

## Level 1: authentication and authorization
```mermaid
flowchart TD
    subgraph Clients
        A["Staff (non-admin role)"]
        B["tenant_admin / platform admin"]
    end
    subgraph Edge["Edge Functions (service_role)"]
        P["pin-login"]
        PC["pin-change (user JWT)"]
    end
    subgraph Auth["Supabase Auth"]
        GT["GoTrue: email + password, MFA"]
    end
    subgraph DB["PostgreSQL"]
        R["fn_resolve_tenant_slug (anon): id, name, branding"]
        V["fn_verify_pin: bcrypt(HMAC digest), row-locked, escalating lockout, refuses admins"]
        S[("profile_secrets: no client access")]
        PR[("profiles: auth_method")]
        H["identity helpers: tenant, role, permissions derived from profiles"]
        RLS["RLS policies"]
        RPC["command RPCs: guard, permission, validate, audit"]
        AU[("audit_logs: append-only")]
    end
    A -->|1 slug| R
    A -->|2 profile + PIN| P
    P -->|3 verify| V
    V --> S
    V --> PR
    V -->|ok: profile| P
    P -->|3b fn_staff_has_active_session; if active: fn_staff_login_blocked, answer = wrong PIN| V
    P -->|4 mint session via admin API| GT
    A -->|forced change: JWT + current/new PIN| PC
    PC -->|verify, fn_complete_forced_pin_change: flagged => pending_approval| V
    PC -->|signOut others| GT
    B -->|email + password| GT
    GT -->|JWT sub only| H
    A -->|queries / RPC with JWT| RLS
    B -->|queries / RPC with JWT| RLS
    RLS --> H
    A --> RPC
    B --> RPC
    RPC --> H
    RPC --> AU
```
Single session: the blocked-login path writes `user_notifications` (recipient: the user and every tenant_admin) which reach the SPA through Realtime (RLS: own rows) and sets
`must_change_pin`, which makes `has_permission` deny everything for that user until `pin-change` succeeds, after which the account is `pin_change_pending` (still denied) until a tenant_admin approves through `fn_approve_pin_change` / `fn_reject_pin_change` (JWT, `users.manage`, step-up; notifications to the admins and later the subject travel the same Realtime path). Trust boundary: `fn_staff_*` are service_role only; the browser never learns why a login was refused.

Rules: PIN verification is attempted only for profiles whose `auth_method='pin'` and whose role is not the system `tenant_admin`; for admins
and platform admins `fn_verify_pin` returns the same `invalid` result as for an unknown account. The JWT contributes only `sub`; tenant, role and
permissions are re-derived from `profiles` on every statement.

## Level 1: tenant provisioning and suspension
Phase 3B: the Platform Admin Portal provisions with `fn_platform_create_tenant` (no owner) and invites the first Tenant Admin (see below);
`fn_provision_tenant` (owner already in Auth, confirmed e-mail) remains for service flows (seed / CI). Suspension, reactivation, cancellation,
plan and billing-status changes are aal2 platform RPCs.
```mermaid
flowchart LR
    SU["Signup / platform admin console"] --> EF["Edge Function (service_role)"]
    EF -->|create auth user with real email| GT["Supabase Auth"]
    EF -->|fn_provision_tenant| DB[("DB")]
    DB --> D1["restaurants, subscription (14d trial), default roles/stations/... rows, owner profile (password auth, no PIN), day 1"]
    DB --> AL["audit_logs + admin_audit_log"]
    PA["platform super admin"] -->|fn_suspend_tenant / fn_reactivate_tenant| DB
    DB -->|status suspended: helpers resolve NULL, all tenant access denied| TEN["tenant users"]
```

## Level 1: Platform Admin Portal (Phase 3B, `/platform/*`)
```mermaid
flowchart LR
    SA["Super Admin (email + password + TOTP, aal2)"] -->|JWT| RPC["fn_platform_* RPCs: fn_platform_guard (active super admin, aal2, verified factor)"]
    RPC -->|metadata, subscription, plan limits| PT[("restaurants, subscriptions, plans, platform_invoices")]
    RPC -->|AGGREGATES only (fn_tenant_usage: counts, byte sums)| OPS[("tenant operational tables + storage.objects")]
    RPC -->|health: version, sizes, counters, last backup| HB[("pg catalogs, platform_backup_runs")]
    RPC -->|every write| AAL[("admin_audit_log (+ tenant audit_logs event)")]
    SA -->|invite / resend / revoke| TAI["tenant-admin-invite (Edge Function)"]
    TAI -->|1 fn_prepare_tenant_admin_invitation AS CALLER| RPC
    TAI -->|2 inviteUserByEmail (service role)| GT["Supabase Auth (sends the e-mail)"]
    TAI -->|3 fn_attach_tenant_admin_invitation (service role)| INV[("tenant_admin_invitations")]
    OPSJOB["ops backup job (service role)"] -->|insert / finish run| HB
    SA -->|lost authenticator of a Tenant Admin (TOTP <= 12 h, reason)| MFR["tenant-admin-mfa-reset (Edge Function)"]
    MFR -->|1 fn_platform_prepare_mfa_reset AS CALLER: active tenant_admin of that tenant; inserts single-use reset row; reset_id + factor ids| RPC
    RPC -->|1 insert / 2 claim / 4 sign-out / 6 consume, all FOR UPDATE| MR[("mfa_resets (no API-role access)")]
    MFR -->|2 fn_platform_claim_mfa_reset (service role): every refusal before any change| RPC
    MFR -->|3 auth.admin.updateUserById: random password (service role); failure = stop| GT
    MFR -->|4 fn_platform_mfa_reset_sign_out (service role): trusted devices, attestations, auth.sessions| TD[("trusted_devices, session_device_attestations, auth.sessions")]
    MFR -->|5 auth.admin.mfa.deleteFactor per factor, then listFactors + delete every one left (service role)| GT
    MFR -->|6 fn_platform_complete_mfa_reset(reset_id, late_factors) (service role; claimed + signed out rows only; actor, target, reason from the row): revoke again, completed_at| TD
    MFR -->|6 audit: tenant_admin.mfa_reset + tenant auth.mfa_reset_by_platform (with reason)| AAL
    MFR -->|7 resetPasswordForEmail(registered e-mail, RECOVERY_REDIRECT_URL) (anon); also action resend_recovery after fn_platform_prepare_recovery_resend| GT
    SA -.->|no RLS path, no profile| X["tenant operational rows: 0 rows, tenant RPCs: permission_denied"]
```
Trust boundaries: the SPA never holds the service role; the Edge Function forwards the caller's JWT for step 1 so the DATABASE decides who may invite; the
invitee later signs in from the e-mail link (confirmed address) and calls `fn_accept_tenant_admin_invitation()` with its own session, which creates its
`tenant_admin` profile. Usage counters cross the platform/tenant boundary only as numbers.
The tenant detail also lists the tenant's Tenant Admins (identity, e-mail, `mfa_enrolled`, live trusted-device count: no operational data), the
input of the MFA reset (0036). Only the caller-scoped step 1 decides who may reset whom (and records it in a single-use `mfa_resets` row); the service
role claims that row (every refusal happens there, before any change), rotates the password, signs the user out, deletes the factors (the
handed-out ones and any still listed) and completes the row after the database confirms no verified factor remains. From the request on,
`fn_mfa_session_ok` / `fn_require_recent_totp` / `fn_require_step_up` accept only sessions of that user created after the cut-off
(`fn_session_after_mfa_reset`).

## Level 1: Tenant Portal administration (Phase 3B, `/r/<slug>/*`)
```mermaid
flowchart LR
    TA["tenant_admin (or delegate with the permission)"] -->|JWT, intents only| RPC["fn_create_role / fn_update_role / fn_set_role_active / fn_delete_role / fn_set_role_station_access / fn_update_role_permissions"]
    TA -->|users| URPC["fn_list_users / fn_update_user / fn_set_user_active / fn_change_user_role / fn_reset_pin_lockout"]
    TA -->|new staff| SC["staff-create (Edge Function)"]
    TA -->|new PIN| SPR["staff-pin-reset (Edge Function): fn_prepare_pin_reset AS CALLER, then fn_set_user_pin (service role, peppered digest)"]
    TA -->|co-admin by e-mail (aal2)| TAI["tenant-admin-invite"]
    TA -->|profile / business settings (aal2) / branding| SRPC["fn_update_restaurant_profile / fn_update_business_settings / fn_update_restaurant_branding"]
    TA -->|logo upload: tenant-branding/restaurants/&lt;own id&gt;/branding/&lt;file&gt;| STO[("Storage: tenant-branding (private)")]
    SRPC -->|logo object must exist under own prefix| STO
    RPC & URPC & SRPC -->|tenant from identity, permission, step-up, validate, audit| DB[("Postgres")]
    TA -.->|platform RPCs| NO["permission_denied"]
```

## Level 1: tenant shell read path (Phase 2)
```mermaid
flowchart LR
    SPA["SPA tenant shell"] -->|fn_get_session_context (JWT)| CTX["profile, restaurant + branding, permissions, station_ids"]
    CTX -->|strict hex -> CSS vars| TH["TenantThemeProvider"]
    CTX -->|permission codes| NAV["MODULE_NAV -> sidebar / drawer / route guards"]
    SPA -->|select stations (RLS: own tenant)| ST[("stations")]
    ST -->|active rows, filtered by station_ids| NAV
    ST -.->|Realtime change -> invalidate| SPA
    RSA[("role_station_access")] -.->|Realtime change -> reload context| SPA
```
Nothing in this path writes; the client never sends a `restaurant_id`. Guards decide only what to render.

## Level 1: menu and inventory (Phase 3, frontend `src/features/{menu,inventory}`)
```mermaid
flowchart LR
    SPA["Menu / Inventory screens"] -->|select menu_items, categories, stations, recipe_lines, ingredients, restaurants.stock_stepup_threshold (RLS: own tenant)| DB[("Postgres")]
    SPA -->|1. upload file -> menu-images/restaurants/&lt;own id&gt;/menu/&lt;uuid&gt;.png/jpg/webp (Storage policy: own prefix, menu.manage)| STO[("Storage: menu-images (private)")]
    SPA -->|2. fn_create_menu_item / fn_update_menu_item (image_path, ids, price)| RPC["security definer RPCs (0029)"]
    SPA -->|fn_set_menu_item_active, fn_set_recipe| RPC
    SPA -->|fn_create/update/set_ingredient_active| RPC
    SPA -->|fn_receive_stock / fn_adjust_stock / fn_reverse_stock_movement + idempotency key per intent| RPC
    SPA -->|fn_list_stock_movements (keyset created_at,id)| RPC
    SPA -->|fn_set_stock_stepup_threshold (aal2)| RPC
    RPC -->|fn_menu_check_image: path + object exists| STO
    RPC -->|ledger row + running total + audit| DB
    STO -->|createSignedUrl (1 h) -> img src| SPA
    DB -.->|Realtime menu_items / recipe_lines / categories / ingredients / stock_movements / stations -> invalidate queries| SPA
    RPC -.->|mfa_required -> StepUpDialog (TOTP, aal2) -> same request, same key| SPA
```
The client sends ids, quantities, prices as typed decimals and an idempotency key (one `crypto.randomUUID()` per opened stock dialog,
reused only for a retry of that intent). It never sends a `restaurant_id`, on-hand stock or a total; structured `P0001` codes are mapped to
fixed copy in `src/lib/supabase/menu-inventory-errors.ts`. A failed create/update deletes the just-uploaded object; a replaced or removed photo
is deleted after the update succeeds (the Storage delete policy refuses an object still referenced).

## Level 1: operational write path (Phases 4+)
Clients send intents (ids, quantities) to `fn_*` RPCs; the RPC derives tenant and user, checks permission and open day, prices server-side,
writes orders/stock/payments atomically, appends audit rows, and Realtime delivers RLS-filtered changes to authorized devices.

## Level 1: cashier and payments (Phase 6)
```mermaid
flowchart LR
    CASH["Cashier SPA /r/<slug>/cashier"] -->|select unpaid orders of the open day (RLS orders_select)| ORD[("orders / order_items")]
    CASH -->|select active payment_methods rows (RLS)| PM[("payment_methods")]
    CASH -->|fn_confirm_payment(order id, method id, reference, tendered, key)| RPC["definer RPC: tenant from JWT, payments.create, open day, idempotency"]
    RPC -->|amount = orders.total, RCT-nnnn, snapshots| PAY[("payments (immutable)")]
    RPC -->|payment_status = paid| ORD
    RPC -->|payment.confirmed| AUD[("audit_logs")]
    CASH -->|fn_reverse_payment + step-up| REV["compensating reversal row; order unpaid"]
    REV --> PAY
    PAY -.->|Realtime INSERT (RLS)| CASH
    RPC -->|receipt JSON| RCPT["ReceiptView (React text) -> print"]
```

## Level 1: installments (Phase 7)
```mermaid
flowchart LR
    UI["Installments SPA /r/<slug>/installments"] -->|fn_generate_voucher(order, customer, down, method, n, interval, key)| GEN["definer RPC: tenant from JWT, vouchers.manage, open day"]
    GEN -->|schedule from orders.total| V[("vouchers / installments")]
    GEN -->|down payment| PAY[("payments")]
    GEN -->|payment_status = installment| ORD[("orders")]
    UI -->|fn_confirm_installment(voucher, method, ref, no, key)| COL["next installment only, scheduled amount"]
    COL --> PAY
    COL -->|paid, payment_id| V
    V -.->|Realtime (RLS vouchers.view)| UI
    UI -->|fn_list_vouchers / fn_get_voucher| V
```

## Level 1: dashboard and reports (Phase 8)
```mermaid
flowchart LR
    DASH["Dashboard SPA /r/<slug>/dashboard"] -->|fn_dashboard()| D["definer RPC: tenant from JWT, dashboard.view; money only with reports.view + payments.view"]
    REP["Reports SPA /r/<slug>/reports"] -->|"fn_report(day nos) / fn_report_period(from, to)"| R["definer RPCs: tenant from JWT, reports.view, per-section gating (restricted[])"]
    REP -->|"fn_log_report_export (before print / CSV / PDF)"| X["definer RPC: reports.view + reports.export"]
    X -->|report.exported| AUD[("audit_logs")]
    D -->|"open day only (fn_report_light)"| B["internal fn_report_light / fn_report_build"]
    R --> B
    B -->|read, tenant-filtered| SRC[("orders / order_items / payments / expenses / stock_movements / ingredients / vouchers / installments / day_sessions")]
    D -->|recent: fn_order_visible| ORD[("orders")]
    ORD -.->|Realtime (RLS orders_select) -> invalidate| DASH
    PAY[("payments")] -.->|Realtime INSERT (RLS payments.view) -> invalidate| DASH
```

## Level 1: day close and new day (Phase 9)
```mermaid
flowchart LR
    UI["Day close SPA /r/<slug>/day-close (day_close.execute)"] -->|"fn_close_day_preview()"| P["definer RPC: tenant from JWT, read-only figures"]
    UI -->|"expenses insert (RLS expenses.manage; day, snapshots, author by trigger)"| E[("expenses")]
    UI -->|"fn_close_day(counted cash, ingredient counts, note, key)"| C["definer RPC: open day FOR UPDATE, unpaid-order block"]
    P --> F["internal fn_day_figures"]
    C --> F
    F -->|read, tenant-filtered| SRC[("payments / expenses / orders / ingredients / stations")]
    C -->|"snapshot + variance, status closed"| D[("day_sessions")]
    C -->|expire| S[("table_sessions / customer_sessions / tables")]
    C -->|day.closed| AUD[("audit_logs")]
    UI -->|"fn_open_day(opening float, key) (day.open)"| O["definer RPC: day_no = last + 1, reset daily counters"]
    O --> D
    O -->|day.opened| AUD
    UI -->|"fn_list_days()"| D
```


## Level 1: settings and dynamic configuration (Phase 10)
```mermaid
flowchart LR
    UI["Settings SPA /r/<slug>/settings/<domain> (config.manage / tables.manage)"] -->|"select / insert / update (RLS, column grants)"| T[("stations / categories / payment_methods / table_areas / expense_categories / tables")]
    T -->|"payment_methods BEFORE UPDATE OF is_active: trg_guard_deactivation"| G["in_use last_active_method"]
    T -->|trg_audit| AUD[("audit_logs")]
    UI -->|"fn_config_usage(domain, id)"| U["definer RPC: closed domain list, tenant from JWT"]
    UI -->|"fn_delete_config_row(domain, id)"| X["definer RPC: refuse in_use, delete, audit config.row_deleted"]
    U --> C["internal fn_config_usage_counts"]
    X --> C
    C -->|"read, tenant-filtered"| REF[("menu_items / ingredients / order_items / stock_movements / role_station_access / payments / expenses / vouchers / orders / table_sessions / qr_credentials")]
    X --> T
    X --> AUD
    T -.->|"Realtime stations -> nav + StationKDS; query invalidation -> POS / cashier"| APP["generated nav, POS, KDS, cashier"]
```
