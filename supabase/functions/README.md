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
