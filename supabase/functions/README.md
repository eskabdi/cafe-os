# Edge Functions

| function | purpose | secrets |
|---|---|---|
| `pin-login` | PIN sign-in for non-admin staff, mints a Supabase session | service-role key (runtime-injected) |

Layout: `_shared/` (CORS, env helpers), `<function>/index.ts` (Deno entry), `<function>/logic.ts` (pure, Vitest-testable).

## Required environment variables
Set only as Edge Function secrets, never in the browser or `.env.example`:

- `SUPABASE_URL` (injected)
- `SUPABASE_SERVICE_ROLE_KEY` (injected; function env only)
- `SUPABASE_ANON_KEY` (injected)
- `ALLOWED_ORIGINS` comma-separated exact origins; no wildcard; unset means no cross-origin browser caller

See `pin-login/README.md`. The browser only ever receives `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.

## PIN pepper (`PIN_PEPPER`)
Both PIN functions compute `hex(HMAC-SHA256(pin, PIN_PEPPER))` (`_shared/pin.ts`) and send only that digest to
`fn_verify_pin` / `fn_set_user_pin`, which bcrypt it. The database never sees a raw PIN, so a leaked database cannot be
brute-forced offline without the pepper. Rules:
- at least 32 characters, random (`openssl rand -base64 48`); a missing or short pepper disables the functions (fail closed);
- set with `supabase secrets set PIN_PEPPER=...`; never in the repo, `.env.example` or the browser;
- **rotating it invalidates every PIN** (all staff must get new PINs); keep it stable;
- local development only: `PIN_PEPPER=cafeos-local-demo-pepper-do-not-use-v1` (the `DEMO_PEPPER` constant) is what
  `supabase/seed.sql` uses for the demo PINs; never set it on a hosted project (the seed is refused there);
- PIN policy (4 digits; **6 digits for the role named `Cashier`**, a documented user-decided exception: `CASHIER_ROLE_NAME` / `pinLengthForRole()` in `_shared/pin.ts` is the single TypeScript source; no repeated/sequential PINs) is enforced in the functions, because only they see the raw PIN.

| function | purpose | secrets |
|---|---|---|
| `pin-change` | a signed-in PIN staff member changes their own PIN (the only way out of `must_change_pin`), revokes their other sessions | service-role key, `PIN_PEPPER` |
| `staff-create` | a `users.manage` caller creates a PIN-login staff member (Auth user + profile + PIN, rollback on failure) | service-role key, `PIN_PEPPER` |
| `staff-roster` | PIN-staff tiles for a registered kiosk (token + `<slug>.cafeos.et`) | service-role key |

`ALLOWED_ORIGINS` accepts exactly one wildcard form for tenant subdomains, e.g. `https://*.cafeos.et` (one valid non-reserved label; `platform.cafeos.et`
must be listed explicitly). See `docs/architecture/tenant-routing.md`.
