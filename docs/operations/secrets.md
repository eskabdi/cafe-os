# Secrets and environment variables inventory

Derived from the code (`Deno.env.get` in `supabase/functions`, `import.meta.env` in `src`, `process.env` in tooling,
`secrets.*`/`vars.*` in `.github/workflows`) on 2026-10-12. Re-run the grep below when a function or workflow changes and
update this table in the same PR.

```bash
grep -rhoE "Deno\.env\.get\('[A-Z_]+'\)|import\.meta\.env\.[A-Z_]+|process\.env\.[A-Z_]+|secrets\.[A-Z_]+|vars\.[A-Z_]+" \
  supabase src scripts tests playwright.config.ts vite.config.ts .github | sort -u
```

Rules: no real value is ever committed (gitleaks runs in CI over the full history); `.env*` files are git-ignored except
`.env.example` (placeholders). Only the two `VITE_` values may reach the browser; the build inlines every `VITE_*` variable,
so **never prefix a secret with `VITE_`**. Values live in the password manager (two owners) and in the one runtime that needs them.

## Inventory

| Name | Secret? | Used by | Where it lives | Who can read it | Rotation | In the client? |
|---|---|---|---|---|---|---|
| `VITE_SUPABASE_URL` | no (public) | browser app (`src/lib/supabase`), build | GitHub Environment variable; `.env.local` for dev | anyone (shipped in the bundle) | on project change | **yes** (by design) |
| `VITE_SUPABASE_ANON_KEY` | no (public, RLS-bound) | browser app, build | GitHub Environment variable; `.env.local` for dev | anyone | when JWT secret/API keys rotate | **yes** (by design; every grant assumes it is public) |
| `SUPABASE_URL` | no | all Edge Functions | injected by Supabase | function runtime | n/a | no |
| `SUPABASE_ANON_KEY` | no | `pin-login`, `pin-change`, `staff-create`, `staff-pin-reset`, `staff-roster`, `tenant-admin-invite`, `tenant-admin-mfa-reset` (caller-scoped clients) | injected by Supabase | function runtime | with API keys | no |
| `SUPABASE_SERVICE_ROLE_KEY` | **yes, critical** (bypasses RLS) | Edge Functions: `pin-login`, `pin-change`, `staff-create`, `staff-pin-reset`, `staff-roster`, `tenant-admin-invite`, `tenant-admin-mfa-reset`, `tenant-logo`; ops SQL/scripts | injected by Supabase into functions; password manager (ops) | function runtime; 2 project owners | yearly and on any suspected exposure or staff departure (rotate API keys / JWT secret in the dashboard, then redeploy functions) | **never** |
| `PIN_PEPPER` | **yes, critical** | `pin-login`, `pin-change`, `staff-create`, `staff-pin-reset`, `staff-roster` (`_shared/env.ts`, `readPinLoginEnv` refuses the demo pepper on non-local URLs) | Edge Function secret (`supabase secrets set`), per project; password manager | function runtime; 2 owners | **only on compromise**: rotation invalidates every PIN (all PIN staff need a reset) | **never** |
| `ALLOWED_ORIGINS` | no (config) | every browser-facing Edge Function (CORS) | Edge Function secret | function runtime; deployers | when hosts change | no |
| `INVITE_REDIRECT_URL` | no (config) | `tenant-admin-invite` | Edge Function secret | function runtime; deployers | when hosts change | no |
| `RECOVERY_REDIRECT_URL` | no (config) | `tenant-admin-mfa-reset` | Edge Function secret | function runtime; deployers | when hosts change | no |
| `SUPABASE_ACCESS_TOKEN` | **yes** (manages the whole org) | `deploy.yml` (`supabase functions deploy`) | GitHub Environment secret (`staging`, `production`) | the deploy job after Environment approval; repo admins cannot read it back | 90 days; token of a dedicated deploy account | never |
| `SUPABASE_DB_URL` | **yes** (contains the DB password) | `deploy.yml` (`supabase db push`), `scripts/ops/logical-backup.sh` | GitHub Environment secret; backup host env; password manager | deploy job after approval; backup job; 2 owners | 90 days (reset the DB password in the dashboard, update both places) | never |
| `SUPABASE_PROJECT_REF` | no | `deploy.yml` | GitHub Environment variable | repo readers | n/a | no |
| `APP_URL` | no | `deploy.yml` (environment URL) | GitHub Environment variable | repo readers | n/a | no |
| `BACKUP_AGE_RECIPIENT` | no (public key) | `logical-backup.sh` | backup host env | backup operators | with the key pair (the private key stays offline, 2 holders) | no |
| Static-host deploy token (name per host) | **yes** | `deploy.yml` placeholder step | GitHub Environment secret | deploy job | 90 days | never |
| SMTP password | **yes** | Supabase Auth mailer | Supabase dashboard (Auth > SMTP) only | project owners | 180 days / provider policy | never |
| Postgres GUCs `app.tenant_admin_mfa_required`, `app.allow_demo_seed` | no (flags) | migrations / seed guard | database settings | DB owner | n/a; **never set `app.allow_demo_seed` on a hosted DB** | no |
| `CI`, `PW_CHROMIUM_PATH`, `PW_CHROMIUM_DIR` | no | Playwright / test tooling | CI runner / developer machine | n/a | n/a | no |
| Local demo values (`supabase start` keys, demo `PIN_PEPPER`, seed passwords) | public by design | local stack and CI only | `supabase/config.toml`, `seed.sql`, CLI defaults | anyone | n/a | refused on hosted projects by the seed guard and `readPinLoginEnv` |

## Handling

- Setting function secrets: `supabase secrets set --project-ref <ref> NAME=value` from a trusted terminal (history off:
  prefix the command with a space or use `--env-file` from a tmpfs file deleted afterwards). `supabase secrets list` shows digests only.
- Rotation of the service-role key / JWT secret: rotate in the dashboard (Settings > API), then redeploy every function
  (they read the injected value at boot) and update ops copies. All user sessions are invalidated by a JWT secret rotation.
- Exposure response: rotate first, then investigate with [monitoring.md](monitoring.md) "Incident response"; record the rotation in the change log.
- Offboarding: rotate every secret the person could read (table column "Who can read it"), remove them from the Supabase org, GitHub Environments reviewers and the password manager.
