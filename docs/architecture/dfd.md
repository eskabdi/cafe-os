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
        edge["Edge Functions (service_role): pin-login, provisioning, billing webhook"]
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
    P -->|4 mint session via admin API| GT
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
Rules: PIN verification is attempted only for profiles whose `auth_method='pin'` and whose role is not the system `tenant_admin`; for admins
and platform admins `fn_verify_pin` returns the same `invalid` result as for an unknown account. The JWT contributes only `sub`; tenant, role and
permissions are re-derived from `profiles` on every statement.

## Level 1: tenant provisioning and suspension
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

## Level 1: operational write path (Phases 4+)
Clients send intents (ids, quantities) to `fn_*` RPCs; the RPC derives tenant and user, checks permission and open day, prices server-side,
writes orders/stock/payments atomically, appends audit rows, and Realtime delivers RLS-filtered changes to authorized devices.
