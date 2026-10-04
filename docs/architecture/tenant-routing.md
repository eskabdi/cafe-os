# Tenant routing (ADR-002, revised): subdomain per tenant

Decision (user, 2026-10-03): a tenant is reached at `https://<slug>.cafeos.et`. This replaces the `/r/:slug/...` path as the primary
resolver in `docs/spec/CafeOS-SaaS-Architecture.md` ADR-002 (the spec files are source documents and are left as written; this file wins).
`/r/:slug` stays only as a **dev / preview fallback** where wildcard DNS is unavailable (Vercel/Netlify previews, `localhost:5173`).

## What the host decides, and what it never decides
The host (slug) is a **pre-auth resolver only**: it picks the login page, branding and, for kiosks, which tenant's roster to ask for.
It never grants access. Tenant identity after sign-in always comes from the profile (`current_restaurant_id()`); for a kiosk it comes from the
registered device token, which must agree with the slug (`fn_kiosk_context`). Spoofing the slug can at worst show another tenant's *public*
branding (already exposed by `fn_resolve_tenant_slug`) or fail.

## Resolution
`supabase/functions/_shared/host.ts` (pure TS, shared by the SPA, Edge Functions and Vitest):
- `parseHost(host)` -> `tenant{slug}` | `platform` | `reserved{label}` | `bare` (apex) | `unknown`. Exactly one label below a base domain
  (`cafeos.et`, `localhost`); `a.b.cafeos.et`, IPs, lookalike suffixes (`x.cafeos.et.evil.com`) are `unknown`.
- Slug format = `restaurants_slug_format` (`^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$`, no `--`).
- **Reserved subdomains**: www, app, api, admin, platform, auth, static, cdn, mail, support, status (user list) plus assets, login, r (original DB list).
  The DB twin (`restaurants_slug_format` CHECK + `fn_slug_is_reserved`, migration 0022 added `status`) is held equal by tests on both sides
  (`tests/unit/tenant-host.test.ts`, `26_kiosk_devices.test.sql`).
- Platform admin console: reserved host **`platform.cafeos.et`** (`parseHost` -> `platform`). The tenant app never renders on it and the platform
  console never renders on a tenant host.
- Local dev: `acme.localhost:5173` resolves to 127.0.0.1 in modern browsers (no hosts file); `localhost:5173/r/acme` is the path fallback.

## DNS and TLS (ops, not enforced by code)
- Wildcard `A/AAAA` (or CNAME) `*.cafeos.et` plus the apex; `platform.cafeos.et` as its own record.
- A wildcard certificate for `*.cafeos.et` (ACME DNS-01) at the edge; HSTS with `includeSubDomains` on the apex only after every subdomain is HTTPS.
- Custom domains (`restaurants.custom_domain`) remain a later, per-tenant certificate feature.
- Do not host any other product or user content under `*.cafeos.et`; cookies and storage isolation below assume only CafeOS apps live there.

## Session isolation per origin
Each `<slug>.cafeos.et` is its own browser origin: `localStorage`, `sessionStorage`, IndexedDB and the Supabase session are per tenant, so staff of
tenant A cannot read tenant B's session in the same browser. Rules:
- Never set cookies with `Domain=.cafeos.et`; auth stays in per-origin storage (the Supabase client default) or host-only cookies.
- The kiosk token is stored per origin too (see kiosk-terminals.md), so one tenant's kiosk token is invisible to another tenant's page.
- Per-origin storage also means signing in on `a.cafeos.et` does not sign the same browser in on `b.cafeos.et` (intended).

## CORS and CSP per subdomain
- Edge Functions allow origins from `ALLOWED_ORIGINS`: exact origins plus the single wildcard form `https://*.cafeos.et` = exactly one valid, non-reserved
  slug label, same scheme and port (`platform.cafeos.et` must be listed explicitly; `www.`, `a.b.`, `http://` are refused). Dev: `http://*.localhost:5173`.
- `pin-login` and `staff-roster` additionally refuse a request whose Origin is a **different tenant's** subdomain than the slug in the body
  (`originSlugMatches`), with the same generic answer as a wrong PIN / invalid kiosk.
- CSP (set by the static host for `*.cafeos.et`): `default-src 'self'; connect-src 'self' https://<project>.supabase.co wss://<project>.supabase.co;
  img-src 'self' data: https://<project>.supabase.co; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`. No tenant-controlled origin is ever
  allowed in `script-src`; tenant branding is colours + a Storage path only (CHECK in the DB).
- Supabase Auth: `site_url`/redirect allow-list must include `https://*.cafeos.et/**` (Auth supports wildcard redirect URLs) and `https://platform.cafeos.et/**`.

## Security headers as code (`public/_headers`)
`public/_headers` (Netlify / Cloudflare Pages format; Vite copies it into `dist/`) carries the CSP above (`script-src 'self'`; `style-src` also allows
`'unsafe-inline'` because Radix/shadcn, Framer Motion and the validated role colour on staff tiles use inline `style`), `X-Content-Type-Options`,
`Referrer-Policy: no-referrer`, `Permissions-Policy`, and `Cache-Control: no-store` for `/terminal` and the `/r/*` fallback. **The static host must serve
this file**: nothing in the SPA enforces it, and a host that ignores `_headers` (or another format such as Vercel `vercel.json`) needs the same values
configured natively. `tests/unit/headers.test.ts` parses the file and pins the key directives. Replace the `https://*.supabase.co` wildcard with the exact
project origin in production, and for a local or self-hosted Supabase (e.g. `http://127.0.0.1:54321`, `ws://127.0.0.1:54321`) add that origin to
`connect-src` (and `img-src` for Storage logos) in that environment only.

## Risks and residuals
| risk | handling |
|---|---|
| Subdomain takeover (dangling DNS) | no per-tenant DNS records exist (wildcard only); suspended tenants simply resolve to "not found" |
| Reserved-name squatting / lookalikes (`centra1-cafe`) | reserved list in DB; lookalike policy is a product/ops decision (not enforced) |
| Slug enumeration | unchanged: unknown / suspended / cancelled resolve identically; slugs of paying tenants are public by nature of subdomains |
| Tenant picks a slug that impersonates a brand | provisioning is platform-only (`fn_provision_tenant`), reviewed by the platform |
| Wrong-tenant UI via spoofed Host | harmless: identity comes from the token/profile, not the host |
