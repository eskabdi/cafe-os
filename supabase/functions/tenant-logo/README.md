# tenant-logo (Public)

`GET /functions/v1/tenant-logo?slug=<tenant slug>` → `200 { "url": "<signed URL>" | null, "expires_in": 600 | null }`

Serves the tenant's **current** logo on the sign-in page, before anyone is signed in (owner decision 2026-10-08, Phase 3B).
The `tenant-branding` bucket stays private: `fn_tenant_logo_for_slug` (service role only) returns the logo path of an
accessible tenant (not suspended/cancelled, object present), and this function signs a 10-minute URL for that one object.

- Classification: **Public** (no user session: the SPA calls it with the anon key, like pin-login; `verify_jwt = true` in `supabase/config.toml`).
- Every non-success (unknown slug, no logo, suspended, cancelled, malformed query, internal error) is the same `200 {url: null}`.
- Rate limit: 30 requests burst, 1 per 2 s refill, per client IP (in-memory, per instance). `429 {error: try_later}` + `Retry-After`.
- Env: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ALLOWED_ORIGINS`. The service-role key never leaves the function.
- Not executed locally (no Deno/Docker in the build container); logic is unit-tested in `tests/unit/tenant-logo-logic.test.ts`.
