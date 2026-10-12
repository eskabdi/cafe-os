# Production cutover runbook (Phase 12)

The owner executes this runbook. Nothing in the repository touches a hosted project on its own: the deploy workflow
(`.github/workflows/deploy.yml`) is manual, defaults to a dry run, and production needs an Environment approval.
Run every step on **staging first**, then repeat it on production (execution prompt §58: staging verification, then
production migration, smoke tests, security verification, controlled launch).

Related: [secrets](secrets.md) · [backups and DR](backups-and-dr.md) · [monitoring](monitoring.md) ·
[deploy checklist](../architecture/deploy-checklist.md) (per-migration hosted checks; every item still applies) ·
[tenant routing](../architecture/tenant-routing.md) · [auth flows](../architecture/auth-flows.md).

Placeholders: `<ref>` = the 20-character project ref, `<app>` = `cafeos.et` (or your apex domain).

## 0. Hard rules during cutover

- Never run `supabase/seed.sql`, `supabase db reset --linked`, or `supabase test db` against staging or production
  (deploy-checklist 4 and 5). Migrations only, through the deploy workflow.
- Never paste the service-role key, DB password, `PIN_PEPPER` or an access token into a ticket, chat, commit or browser.
- Two people for: production migration approval, Super Admin registration, restore, purge.

## 1. Create the projects

1. Create two Supabase projects in the same organisation: `cafeos-staging` and `cafeos-production`.
2. **Region.** Supabase has no region in Ethiopia. Measure latency from Addis Ababa (e.g. `curl -w '%{time_connect}'` to
   each region's endpoint) and pick the lowest, typically Frankfurt (`eu-central-1`) or Mumbai (`ap-south-1`). Confirm
   cross-border processing obligations under Ethiopia's Personal Data Protection Proclamation with counsel before choosing.
   The region cannot be changed later without a migration to a new project.
3. **Postgres version.** Match `supabase/config.toml` `[db] major_version` (currently 15). If the dashboard only offers a newer
   major, bump `major_version` locally, run the full gate (`pnpm test:db`, E2E) and commit before the first push.
4. **Plan.** Production needs at least **Pro** (no pausing, daily backups, larger compute) plus the **PITR add-on**
   ([backups](backups-and-dr.md)). Team or above if you need longer log retention, log drains, SSO for the dashboard or a
   SOC 2 report. Staging can be Pro without PITR. Start compute at Small/Medium and resize from the
   [monitoring](monitoring.md) CPU and connection signals.
5. Dashboard access: enable MFA for every organisation member; give the minimum role (Developer for most, Owner for two people).
6. Record `<ref>`, the anon key and the DB connection string in the password manager (secrets.md lists where each goes).

## 2. Auth settings (Dashboard > Authentication)

The local `supabase/config.toml` does **not** configure hosted projects. Mirror it by hand and screenshot each page into the change record.

| Setting | Value |
|---|---|
| Sign-ups | **Disabled** (`enable_signup = false`); anonymous sign-ins disabled |
| Confirm email | **ON** (local is off only for the demo seed; `fn_provision_tenant` also refuses unconfirmed owners) |
| Secure password change / double confirm email change | ON / ON |
| Password policy | minimum **12**, required characters = lower, upper, digits, symbols (the client `password.ts` mirrors it; keep identical) |
| Leaked password protection | ON if your plan offers it |
| MFA | TOTP enroll + verify **enabled** |
| JWT expiry | 3600 s (if raised, raise `fn_active_session_window()` too: deploy-checklist 12) |
| Refresh token rotation | ON, reuse interval 10 s |
| Rate limits | `token_verifications` >= peak PIN logins per 5 min across all tenants (local 600; deploy-checklist 16); email sent, sign-in as config.toml |
| Hook | Password verification attempt = Postgres `public.fn_auth_password_verification_hook` (deploy-checklist 1) |
| Site URL | `https://platform.<app>` |
| Redirect allow-list | `https://*.<app>/**`, `https://platform.<app>/**` (no `http://`, no `localhost` on production) |

**SMTP.** The built-in mailer is rate-limited and not for production. Configure custom SMTP (Authentication > SMTP Settings)
with a transactional provider: a sender on your domain (e.g. `no-reply@<app>`), SPF, DKIM and DMARC records published, and
the SMTP password stored only in the dashboard. Send a test invitation on staging and check it is not marked as spam.

**Email templates (Authentication > Email Templates).** Copy the subject and body from the repository, unchanged:

| Template | Subject | Body |
|---|---|---|
| Invite user | `You are invited to CafeOS` | `supabase/templates/invite.html` |
| Magic link | `Your CafeOS sign-in link` | `supabase/templates/magic_link.html` |

Both use the one-time token hash flow (`verifyOtp`; no tokens in the URL fragment). Keep the Recovery template's link pointing
at `{{ .ConfirmationURL }}` (the `/reset-password` page accepts only `type=recovery`).

## 3. GitHub Environments and the deploy workflow

1. Settings > Environments: create `staging` and `production`.
   - `production`: **required reviewers** (two people, the deployer cannot self-approve: enable "Prevent self-review"),
     deployment branches = `main` only, optional wait timer of 5 minutes.
   - `staging`: deployment branches = `main` and release branches.
2. In each Environment add the secrets `SUPABASE_ACCESS_TOKEN` (a personal access token of a dedicated deploy account,
   scoped to the org) and `SUPABASE_DB_URL` (direct connection string), and the variables `SUPABASE_PROJECT_REF`,
   `VITE_SUPABASE_URL` (`https://<ref>.supabase.co`), `VITE_SUPABASE_ANON_KEY`, `APP_URL`.
3. Static host is **Vercel**. Create one Vercel project per Environment (e.g. `cafeos-staging`, `cafeos-production`), framework
   preset "Other", **not connected to the Git repository** (or with Git deployments disabled): only `deploy.yml` deploys, because
   only it narrows the CSP and generates `vercel.json`. In each GitHub Environment add the secret `VERCEL_TOKEN` (a token of a
   dedicated deploy account, scoped to the Vercel team) and the variables `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` (Vercel project >
   Settings > General). The workflow converts `dist/_headers` into `dist/vercel.json` (`scripts/ops/headers-to-vercel.mjs`: the same
   security and cache headers plus the SPA rewrite to `/index.html`) and runs `vercel deploy dist --prod`.

## 4. Apply migrations (CI, manual approval)

1. Actions > Deploy > Run workflow: `environment = staging`, `dry_run = true`. Read the "Pending migrations" list.
2. Before any run that contains 0026/0027/0028 or 0036 read deploy-checklist 13 to 18 (ordering, aal2 lockout query, `auth.sessions` grant).
3. Run again with `dry_run = false`. The job applies `supabase db push` (migrations only; no seed), then deploys the Edge Functions.
4. Regenerate nothing on the server: `src/lib/supabase/types.ts` is generated locally from the same migrations and is already in the build.
5. Production: same two runs from `main`; the job waits for the Environment approval. The approver checks the dry-run list
   matches what staging received.

**Hosted-only checks right after the first push** (SQL editor, as `postgres`):

```sql
-- the definer owner can read and delete auth.sessions (deploy-checklist 18); both must succeed
select count(*) from auth.sessions;
begin; delete from auth.sessions where false; rollback;
-- if either fails: grant select, delete on auth.sessions to postgres;  then repeat
-- the hook is wired (expect 1 row)
select proname from pg_proc where proname = 'fn_auth_password_verification_hook';
-- no demo data (expect 0 rows)
select slug from public.restaurants;
```

## 5. Edge Functions and secrets

Functions (all `verify_jwt = true`): `pin-login`, `pin-change`, `staff-create`, `staff-pin-reset`, `staff-roster`,
`tenant-admin-invite`, `tenant-admin-mfa-reset`, `tenant-logo`. The workflow deploys them; to deploy by hand:
`supabase functions deploy <name> --project-ref <ref>`. Supabase injects `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY` itself. Set the rest once per project, from a trusted terminal, values from the password manager:

```bash
supabase secrets set --project-ref <ref> PIN_PEPPER=... ALLOWED_ORIGINS=... INVITE_REDIRECT_URL=... RECOVERY_REDIRECT_URL=...
supabase secrets list --project-ref <ref>      # names and digests only
```

Expected values (names and shapes only; [secrets.md](secrets.md)):
`PIN_PEPPER` 32+ random characters, different per project, never the demo pepper; `ALLOWED_ORIGINS=https://*.<app>,https://platform.<app>`;
`INVITE_REDIRECT_URL=https://<host>/invite` and `RECOVERY_REDIRECT_URL=https://<host>/reset-password` (top-level SPA routes;
https, no credentials, no fragment). One value serves every tenant, so `<host>` is a single host that serves the SPA: the apex
`<app>` (path fallback) is the usual choice. Walk the whole invite and MFA-reset flow on staging on the chosen host before
production. Both URLs must also be in the Auth allow-list (add the apex pattern `https://<app>/**` if you use the apex).
A missing or unsafe value disables that function (503) by design.

Residual risk 1 of the hardening report: the functions were never booted in the build sandbox. **On staging, before production,**
exercise each one through the UI (invite, accept, MFA reset, staff create, PIN reset, PIN login on a kiosk, PIN change, logo upload)
and check the function logs show no 5xx.

## 6. Storage buckets check

The migrations create both buckets; verify nothing drifted (SQL editor):

```sql
select id, public, file_size_limit, allowed_mime_types from storage.buckets order by id;
-- expect exactly:
--   menu-images     false  2097152  {image/png,image/jpeg,image/webp}
--   tenant-branding false  1048576  {image/png,image/jpeg,image/webp}
select policyname, cmd from pg_policies where schemaname = 'storage' and tablename = 'objects' order by 1;
```

Neither bucket may be public. Objects live under `restaurants/<restaurant_id>/...`. On staging, as tenant A, try to read a
tenant B logo path with a signed URL request: it must be refused.

## 7. Static site, CSP and hosting

- Build output `dist/` is a SPA: the host must rewrite unknown paths to `/index.html` and **serve `dist/_headers`**
  (Cloudflare Pages and Netlify read it natively; any other host must replicate every header, hardening residual 3).
- **CSP narrowing.** The deploy workflow rewrites `https://*.supabase.co` / `wss://*.supabase.co` in `dist/_headers` to
  `https://<ref>.supabase.co` / `wss://<ref>.supabase.co` and fails if a wildcard remains (hardening residual 4). The source file
  keeps the wildcard for local builds. If you add a custom Supabase domain, use that origin instead and update the step.
- Verify after deploy: `curl -sI https://platform.<app>/ | grep -i content-security-policy` shows the exact project origin;
  the browser console shows no CSP violations on login, POS, KDS, reports and logo upload.

## 8. DNS, wildcard tenant subdomains and TLS

Per [tenant-routing.md](../architecture/tenant-routing.md):

0. The apex is compiled in: `DEFAULT_BASE_DOMAINS` in `src/lib/utils/host.ts` is `cafeos.et`. If production uses another
   domain, change it (and its unit test) before the build. Nested hosts such as `acme.staging.cafeos.et` parse as `unknown`,
   so staging needs its own apex added to that list (e.g. `cafeos-staging.et`, then `acme.cafeos-staging.et`); there is no
   build-time variable for it yet (a small follow-up: read an optional `VITE_BASE_DOMAINS`).
1. DNS: Vercel serves a **wildcard domain only when the domain uses Vercel's nameservers**. Point the apex `<app>` nameservers to
   Vercel, then in the production Vercel project add the domains `platform.<app>` and `*.<app>` (staging: its own apex, see 0).
   No per-tenant records (prevents dangling-record takeover). Apex `<app>` may host marketing or redirect.
2. TLS: Vercel issues and renews the wildcard and `platform.<app>` certificates itself (DNS-01, possible because Vercel hosts the
   DNS). Still alert on expiry < 14 days.
   Alert on expiry < 14 days ([monitoring](monitoring.md)).
3. HSTS is already in `_headers` with `includeSubDomains`; only add `preload` once every subdomain is HTTPS and stays so.
4. Never set a cookie with `Domain=.<app>`.
5. Rate-limit `fn_resolve_tenant_slug` (anon-callable) at the edge/WAF (deploy-checklist 8): e.g. 60 requests/min per IP to
   `/rest/v1/rpc/fn_resolve_tenant_slug`, or front the Supabase API with your CDN's rate limiting.
6. Verify: `https://<slug>.<app>` resolves an existing tenant; an unknown slug shows "not found"; `https://platform.<app>` shows only the platform login.

## 9. Bootstrap the first Super Admin (two people, MFA)

There is no client path to create a platform admin (auth-flows.md, "Adding a Super Admin").

1. Authentication > Users > Add user: real e-mail, strong password, **Auto confirm**. Do not use Invite. Do step 2 immediately.
2. SQL editor (the function requires the `service_role` claim):
   ```sql
   begin;
   select set_config('request.jwt.claims', '{"role":"service_role"}', true);
   select set_config('request.jwt.claim.role', 'service_role', true);
   select public.fn_ops_register_platform_admin('<auth user id>', '<First Middle Last>');
   commit;
   ```
   Expect `{"id": ...}`; an `owner_email_unconfirmed` / `owner_already_assigned` error means step 1 was wrong.
3. The admin signs in at `https://platform.<app>`, is sent to the MFA gate and enrols TOTP (mandatory, migration 0032).
4. Register a **second** Super Admin the same way (break-glass; the last active admin cannot be deactivated). Store its
   recovery details offline.
5. Check `select action, created_at from public.admin_audit_log order by created_at desc limit 5;` shows `platform_admin.registered` twice.

**First tenant** (controlled launch): from the platform portal create the tenant (plan, slug), invite its Tenant Admin, who accepts,
sets a password and enrols TOTP at `/r/<slug>/settings/security` (deploy-checklist 15 and 17: run the lockout query, expect no rows).
The tenant's reference data (stations, categories, payment methods, roles, table areas) is created by the Tenant Admin in the UI; there is no production seed.

## 10. Smoke tests (staging, then production)

Run with real accounts on a dedicated smoke tenant (`smoke-<date>`), which is cancelled afterwards (it is purged after a year).

1. Platform: Super Admin login + TOTP; no tenant operational screens are reachable (`/r/<slug>/pos` from the platform host = refused).
2. Tenant Admin login + TOTP; create station **Grill**, category **Desserts**, payment method **Amole**, role **Runner** (the generalization set).
3. Create a waiter (PIN 4 digits) and a `Cashier` (PIN 6 digits); register a kiosk; PIN login works; wrong PIN x N locks out (`auth.account_locked` in `audit_logs`).
4. Open day, order (POS) -> Grill KDS updates live (Realtime) -> pay with Amole -> receipt number issued; cancel a second order.
5. Installment create + confirm; close day; a write after close returns `day_closed`; reopen per policy.
6. Logo upload (branding) appears; a 3 MB file and an SVG are refused.
7. Security (deploy-checklist 9): a waiter cannot read `restaurants.tin`, `subscriptions`, `day_sessions`; a platform admin without aal2 sees no tenant;
   a PIN staff synthetic e-mail + any password is rejected by the hook; second-device PIN login is blocked and notifies.
8. Headers and CSP as in section 7; `https://` only; `curl http://...` redirects to https.
9. Edge Function logs and Postgres logs: no 5xx, no unexpected `permission_denied` bursts during the run.

## 11. Rollback

- **Database: forward-fix only.** Migrations are not reversed in place. Write a new migration that undoes the change, run it
  through the gate (pgTAP, E2E), then the deploy workflow. Do not edit an applied migration file.
- **Bad data or destructive mistake:** restore with **PITR** to a timestamp just before the incident
  ([backups-and-dr.md](backups-and-dr.md), "Restore"). PITR restores the whole project in place: every write after the target
  time is lost, so declare an incident and freeze writes (suspend tenants or put the site in maintenance) first.
- **Edge Functions:** redeploy the previous commit's function (`git checkout <sha> -- supabase/functions/<name>` in a hotfix
  branch, or re-run the workflow on the previous tag with `dry_run=false`). Function and migration pairs listed in the checklist must move together.
- **Static site:** roll back to the previous deployment in the host (immutable deploys), or re-upload the previous run's `site-*` artifact.
- **Secrets:** rotating `PIN_PEPPER` invalidates every PIN (all PIN staff must get a reset); never roll it back to a leaked value.

## 12. Go / no-go checklist

Every line is "go" before production traffic; one "no-go" stops the launch.

- [ ] CI green on `main` (security, quality, database, e2e) for the commit being deployed; `pnpm audit` clean.
- [ ] Staging ran the same commit through sections 4 to 10 with no open findings.
- [ ] Hardening report residuals 1 to 4 closed on staging (functions exercised, real-backend smoke, headers served, CSP narrowed).
- [ ] Auth settings match section 2 (screenshots in the change record); SMTP sends; templates copied.
- [ ] Function secrets set (names in `supabase secrets list`), redirect URLs in the allow-list, `auth.sessions` grant verified.
- [ ] Buckets private with the expected limits.
- [ ] DNS + wildcard TLS live; HSTS served; unknown slug shows not-found.
- [ ] Two Super Admins with TOTP; lockout query (deploy-checklist 17) returns no rows for the launch tenants.
- [ ] PITR enabled and a restore drill succeeded on staging within the RTO; first logical backup recorded in `platform_backup_runs`.
- [ ] Monitoring alerts wired and test-fired to the on-call channel; on-call rota for launch week.
- [ ] Rollback owner named; previous site build available.
- [ ] Prototype archived (kept at `docs/prototype/cafeos.html`; never deleted, never deployed).

Launch in waves: one pilot tenant for a week, then small batches, watching [monitoring](monitoring.md) between batches.
