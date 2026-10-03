# Deploy checklist (hosted Supabase projects)

Do these BEFORE a hosted project takes real users. Items marked (manual) cannot be enforced by migrations.

1. **Auth hook (manual).** Dashboard > Authentication > Hooks > "Password verification attempt" = Postgres function
   `public.fn_auth_password_verification_hook`. `supabase/config.toml` only wires the LOCAL stack. Without it PIN staff could set/use a
   password through GoTrue. Verify: sign in with a PIN staff account's synthetic email + any password => rejected.
2. **Email confirmation ON (manual)** and `secure_password_change`, minimum password length 12 with symbols, TOTP MFA enabled
   (same values as `config.toml`; the local file does not configure hosted projects).
3. **Platform admins need aal2.** Do NOT set `app.platform_mfa_required = 'off'` on a hosted database. Enrol TOTP for every platform admin
   first. Optional: `alter database postgres set app.tenant_admin_mfa_required = 'on'`.
4. **Never run the demo seed.** `supabase db reset --linked` and any `psql -f supabase/seed.sql` against a hosted project are refused by the seed guard
   (it needs the CLI's default JWT secret or `app.allow_demo_seed=on`; never set that on a hosted database). Use `supabase db push` (migrations only).
5. **Never run `supabase test db` against a shared or hosted project.** `00_helpers.test.sql` COMMITS a `tests` schema (with SECURITY DEFINER lookups),
   and the files insert fixtures. Run pgTAP only on local/CI databases.
6. **Edge Function secrets (manual):** `PIN_PEPPER` (32+ random chars, never the demo pepper: `readPinLoginEnv` refuses it for non-local URLs),
   `ALLOWED_ORIGINS`. Rotating the pepper invalidates every PIN.
7. **Realtime.** Enable RLS-respecting postgres_changes only; accepted residual: Realtime cannot RLS-filter DELETE events (the row no longer exists),
   so a DELETE event reaches every subscriber of that table and carries the deleted row's replica identity (primary key; `(restaurant_id, id)` for `orders`).
   Row contents are never exposed that way, only ids. Secret columns are kept out of the stream with column lists (`orders`); `qr_credentials` and
   `customer_sessions` are not published. Not verified against a live Realtime server.
8. **Resolver throttling (manual):** `fn_resolve_tenant_slug` is anon-callable; rate limit it at the edge/WAF.
9. **Smoke after deploy:** a waiter cannot read `restaurants.tin`, `subscriptions`, `day_sessions`; a platform admin without aal2 sees no tenant.
10. **Subdomain routing (manual):** wildcard DNS + wildcard certificate for `*.cafeos.et`, `platform.cafeos.et` as its own host, CSP per tenant host, Auth redirect
    allow-list `https://*.cafeos.et/**` and `https://platform.cafeos.et/**`; set `ALLOWED_ORIGINS=https://*.cafeos.et,https://platform.cafeos.et` on the Edge Functions
    (details: tenant-routing.md). Never use a cookie `Domain=.cafeos.et`.
11. **Kiosks:** register devices only from the tenant host, treat the token like a password (shown once), revoke on theft or staff turnover, review `last_seen_at`
    (kiosk-terminals.md). `staff-roster` and `pin-login` must run with `PIN_PEPPER` set (shared fail-closed env).
