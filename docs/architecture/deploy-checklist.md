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
12. **Single session / forced PIN change (0023):** deploy `pin-change` (`supabase functions deploy pin-change`; `verify_jwt = true` in config.toml) together with `pin-login` and the migration.
    Keep `fn_active_session_window()` (2 h) longer than the project's JWT expiry (Auth settings > JWT expiry; local = 3600 s); if you raise the expiry above 1 hour raise the window too, otherwise a
    live session could look stale. Verify once on the hosted project: sign in as PIN staff on device A, attempt the same login on device B => the normal "Could not sign in" answer, a notification for the
    user and the tenant admin, and the user is routed to the PIN change screen; after the change, device A is signed out. Verify the Realtime publication lists `user_notifications` with its column list.
    Optional retention job: delete `user_notifications` older than 90 days (rls-matrix.md).
13. **PIN change approval (0024):** deploy the updated `pin-change` Edge Function together with the migration (the old function calls `fn_set_user_pin`, which clears a flag without approval, and does not return `pending_approval`).
    Verify once on the hosted project: block a PIN user (second device login), change the PIN => response `pending_approval: true`, every tenant_admin gets a `security.pin_change_pending_approval` notification, the user
    still sees no data; an admin with MFA approves from an aal2 session (any aal1 session, including a PIN-only delegate or an admin without a factor, gets `mfa_required`; since 0026 there is no pass for accounts without an authenticator) => access returns; reject => the user must change the PIN again. Make sure every tenant keeps at least one reachable active tenant_admin.
14. **Session timers (0025):** apply the migration BEFORE deploying the new `staff-roster` version (it calls `fn_kiosk_terminal_bootstrap`; the old version keeps
    working against the new database because `fn_kiosk_roster` is unchanged). Verify: every tenant has a `restaurant_session_settings` row
    (`select count(*) from restaurants r where not exists (select 1 from restaurant_session_settings s where s.restaurant_id = r.id)` = 0); a tenant admin changes the
    timers from an aal2 session (since 0026 any aal1 session, e.g. a PIN-only staff delegate with `settings.session_timers`, gets `mfa_required`); a waiter's `fn_get_session_context()` shows the new `session_timers` after a refetch;
    a kiosk's `staff-roster` answer carries the tenant's `pin_pad_idle_seconds`. Regenerate `src/lib/supabase/types.ts` (new table and three RPCs).
15. **Mandatory aal2 (0026):** approving/rejecting a PIN change and changing/resetting the session timers need an aal2 session; PIN-only staff cannot do either, even with the permission. Before deploying, make sure every
    tenant has at least one tenant_admin (or Supabase Auth delegate) who has enrolled TOTP, otherwise nobody can release a PIN-change request or edit the timers. Verify: a PIN staff delegate gets `mfa_required` on both; the tenant_admin on aal2 succeeds.