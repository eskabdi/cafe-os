# Phase 11 hardening report

Date: 2026-10-12. Baseline: commit `27f6c48` (Phases 0–10 complete). Scope: execution prompt §58 Phase 11 deliverables.
**Gate: zero critical or high-risk findings. Result: met.** No critical or high finding was open at the end of the audit. All
medium findings are fixed. The low and informational findings are either fixed or accepted, with the reasons given below.

## Severity scale

| severity | meaning |
|---|---|
| Critical | cross-tenant data access, auth bypass, secret exposure, or remote code execution |
| High | privilege escalation inside a tenant, loss of integrity of money or stock data, or a client-reachable injection |
| Medium | defence-in-depth gap with a plausible path to impact, measurable performance or a11y failure on a key page |
| Low | hygiene issue with no realistic exploit path |
| Info | observation only |

## Summary of findings

| id | deliverable | finding | severity | status |
|---|---|---|---|---|
| A11Y-1 | accessibility | Active navigation item: tenant primary text on a 10% primary tint gives 4.13:1. It fails WCAG 1.4.3 on every tenant page (axe `color-contrast`, serious). | Medium | **fixed**: active item now uses ink text, semibold weight and an inset primary bar. The brand colour stays on the tint and the bar, so a tenant colour can no longer break contrast. Same fix in the platform shell and on the "this device" pill. |
| A11Y-2 | accessibility | `--muted-foreground` (#65758b) on the page background (#f8fafc) gives 4.48:1. Affected: hints, report tabs, live status text and the platform sign-in. | Medium | **fixed**: token darkened to `215 19% 41%` (≥ 4.5:1 on background and muted). `--status-cancelled` changed to match. |
| A11Y-3 | accessibility | Semantic `--status-success` (#16a249) on white gives 3.33:1 (day close variance, success labels). `--status-warning` and `--status-overdue` are about 3:1 and 3.4:1. | Medium | **fixed**: success is now `#15803d`, warning `#b45309` and overdue `#c2410c` (all ≥ 4.5:1 on white). They stay fixed platform colours and are never tenant-branded. |
| A11Y-4 | accessibility | CSS transitions and animations did not honour `prefers-reduced-motion` (only the KDS Framer board did). | Low | **fixed**: a global reduced-motion media rule in `src/index.css` |
| PERF-1 | query/index | `day_sessions` had two identical btree keys (`day_sessions_tenant_opened_idx` from 0005 and `day_sessions_opened_idx` from 0037). This doubled index maintenance on every day open and close. | Medium | **fixed**: migration 0040 drops the 0005 index |
| PERF-2 | query/index | `profile_secrets` was the only tenant table without an index leading with `restaurant_id`. The tenant purge and the composite FK check did a full scan. | Low | **fixed**: `profile_secrets_restaurant_idx (restaurant_id, profile_id)` |
| PERF-3 | query/index | 11 actor FKs (`*_created_by` / `opened_by` / `closed_by` / `issued_by` / `revoked_by` / `cancelled_by` → profiles) are not indexed. | Low | **accepted**: this exception was reviewed in Phase 2 (M9) and is asserted in `21_validation_invariants`. Profiles are deactivated, never deleted, except by the offline tenant purge. The purge deletes the dependent rows of that tenant first, and those tables have restaurant-leading indexes. An index would tax every write on the busiest tables. |
| PERF-4 | performance | The main JS chunk was 891 kB (over Vite's 500 kB warning), with React, React Router and Supabase in the same file as the app code. | Low | **fixed**: `manualChunks` splits `vendor-react` (240 kB / 79 kB gzip) and `vendor-supabase` (227 kB / 59 kB gzip) into long-cached chunks. The app entry is now 422 kB / 126 kB gzip, and no chunk triggers the warning. Routes were already lazy (19 `lazy()` routes; charts, PDF and KDS chunks are separate). |
| HDR-1 | storage / transport | The static-host headers had no HSTS, COOP or `X-Frame-Options` (CSP `frame-ancestors 'none'` already blocks framing in modern browsers). | Low | **fixed**: `Strict-Transport-Security: max-age=63072000; includeSubDomains`, `Cross-Origin-Opener-Policy: same-origin`, `X-Frame-Options: DENY`; asserted in `tests/unit/headers.test.ts` |
| RLS-I1 | RLS pen test | 33 policies cover verbs whose table privilege was later revoked from `authenticated` (RPC-only writes since 0029–0039, e.g. `menu_items` INSERT/UPDATE/DELETE, `roles_*`, platform tables). They are dead code; the privilege is the effective deny. | Info | **accepted**: kept as defence in depth. If a future grant reopens a verb, the policy already scopes it to the tenant. `52_hardening` asserts the reverse direction: every granted verb has a policy. |
| SEC-I1 | secret audit | Two unit tests contain a fake JWT (`eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1LTEifQ.c2ln`: signature `"sig"`, `sub: u-1`). The seed contains the public demo PIN pepper. | Info | **accepted**: neither is a credential. Hosted projects refuse the demo pepper (`isPepperAllowedFor`), and the seed refuses to run outside the local stack. |

No critical or high findings were found. The existing adversarial suites (`02`, `10`–`13`, `34`, `38`, `40`, `44`, `47`, `49`)
were re-run unchanged and still pass.

## Deliverables

### 1. Complete Playwright suite
- **Method:** ran the full suite, which covers every Phase 1–10 flow: generalization (Grill / Desserts / Amole / Runner), order
  lifecycle, KDS, cashier, installments, day close and reopen, reports, config domains, portals, PIN change, session timers,
  security and terminal. Added 8 axe smokes (see §5).
- **Result:** 71 / 71 passed (`PW_CHROMIUM_DIR=/opt/pw-browsers … pnpm exec playwright test`).
- **Residual risk:** the suite runs against **mocked Supabase** (`page.route`). It proves client intent-only payloads, routing,
  guards and rendering, but not the server. The server side is proven by pgTAP (3552 assertions, run twice) and the race tests.
  Before cutover (Phase 12), run the suite against a real local stack (`supabase start`), as CI's `e2e` job is wired to do.

### 2. RLS penetration testing
- **Method:** catalog-driven sweep in the new `supabase/tests/database/52_hardening.test.sql`. For every table that has
  `restaurant_id`, and for every verb the `authenticated` role holds on it, the test probes another tenant's rows with:
  `SELECT count(*) … where restaurant_id <> mine`, `UPDATE … set <first updatable column> = itself where restaurant_id <> mine` and
  `DELETE … where restaurant_id <> mine`. It runs as three identities:
  - tenant A's admin
  - tenant A's kitchen staff
  - tenant B's admin

  It also checks that anon reads nothing and that an aal2 platform super admin reads no operational row. A meaningfulness check
  requires at least 10 readable tables to hold foreign rows. The sweep was proven to fail by temporarily adding a
  `using (true)` policy on `stations`: tests 17, 20 and 21 went red.
- **Catalog invariants added:** every granted verb has a policy for that role, and every INSERT policy has WITH CHECK. The
  existing `13_security_hygiene` already enforces:
  - RLS enabled and forced
  - no `USING (true)`
  - no `FOR ALL`
  - every tenant policy scoped by `current_restaurant_id()`
- **Result:** no leak.

### 3. IDOR / BOLA testing
- **Method:** re-ran `10_idor_bola`. It covers every tenant table and every UUID-taking RPC, with existence-oracle probes
  (a real foreign id against a random id) and byte-level tenant snapshots. It also covers `40_orders_adversarial`,
  `44_payments_adversarial`, `47_installments_adversarial` and `51_config_domains`. Because the 52 sweep is catalog-driven, a
  table added later is covered without editing the test.
- **Result:** pass; no finding.

### 4. Authorization bypass testing
- **Method:** reviewed and re-ran the existing suites:
  - `11_role_escalation`
  - `12_platform_boundary`
  - `34_portal_separation`
  - `38_portal_adversarial`
  - `49_mfa_reset_adversarial`
  - E2E `security.spec.ts` and `portals.spec.ts`

  `13_security_hygiene` asserts the remaining controls:
  - the exact `authenticated` EXECUTE allowlist
  - anon may execute only `fn_resolve_tenant_slug`
  - every client RPC authorises in its body
  - every `fn_platform_*` calls the aal2 `fn_platform_guard()`
  - no client definer returns table rows
- **Result:** pass; no finding.

### 5. Accessibility pass
- **Method:** added `@axe-core/playwright@4.13.0`. It was not in the lockfile, so it was installed as an exact-pinned dev
  dependency, released on 2026-10-09. Helper `tests/e2e/a11y.ts` (WCAG 2.0/2.1 A + AA tags) fails on any serious or critical
  violation. It runs inside each page's own mocked spec, so the real rendered state is scanned. Pages:
  - tenant sign-in and platform sign-in (`smoke.spec.ts`)
  - POS
  - KDS (generic station board)
  - Cashier
  - Reports
  - Day close
  - Settings → Stations

  Manual pass:
  - images have `alt` (decorative ones are `aria-hidden`)
  - `outline-none` only appears on programmatic focus targets (`<main tabIndex=-1>`, headings, PIN group), and interactive
    controls keep `focus-visible:ring`
  - reduced motion is honoured
- **Result:** the first run found A11Y-1 to A11Y-3 on 7 of 8 pages. After the fixes, all 8 pages are clean.

### 6. Performance optimization
- **Method:** production build size analysis, using a source map bucketed by package.
- **Result:** PERF-4 fixed. RLS hot paths were already measured in `17_rls_station_perf` (20k-order kitchen count < 500 ms). The
  new invariant in `52` checks that every auth helper in a policy is an InitPlan (`(select fn())`) and that the helpers are
  STABLE.

### 7. Query / index optimization
- **Method:** pg_catalog queries for:
  - unindexed FKs (no exceptions)
  - tenant tables without a `restaurant_id`-leading index
  - duplicate indexes
  - unvalidated FKs
- **Result:** PERF-1 and PERF-2 fixed (migration `20261003004000_hardening.sql`). PERF-3 accepted. All except PERF-3 are now
  asserted in `52`.

### 8. Storage security audit
- **Method:** catalog review of `storage.buckets` and the `storage.objects` policies, plus the `tenant-logo` Edge Function.
- **Findings:** none. Both buckets (`menu-images` at 2 MB and `tenant-branding` at 1 MB) are private and allow only PNG, JPEG
  and WebP; SVG and HTML are refused. Every policy:
  - is for `authenticated` only
  - pins `^restaurants/<current_restaurant_id()>/(menu|branding)/<safe name>$`
  - refuses `..`
  - requires `current_tenant_writable()` and the matching permission for writes
  - refuses overwrite or delete while a row still references the object

  The public logo is served only as a 10-minute signed URL of the current logo of an accessible tenant, with a uniform
  `{url:null}` for every failure (no enumeration oracle) and a per-IP rate limit. All of this is now asserted in `52`.

### 9. Secret audit
- **Method:**
  - `git ls-files` for `.env*`, `*.pem` and `*.key`: only `.env.example` is tracked (`.gitignore` covers `.env` and `.env.*`)
  - regex scan for JWTs, AWS, Stripe, GitHub and Slack tokens and private keys (see SEC-I1)
  - service-role key reach: it is read only in `supabase/functions/_shared/env.ts` and `tenant-logo/index.ts`, and nothing in
    `src/` references it
  - CI runs gitleaks over full history
  - DB: `13_security_hygiene` asserts that no client role holds any privilege on a hash, secret or token column, that Realtime
    publishes none, and that audit logs contain no digest
- **Result:** no secret in the repo.

### 10. Error handling audit
- **Method:**
  - DB: no function in `public` references `SQLERRM`, `MESSAGE_TEXT` or `PG_EXCEPTION_*`, and no client definer interpolates
    into a raw `RAISE` (both are asserted in `52`). Errors go through `fn_err` machine codes (rpc-conventions).
  - Client: `callRpc` keeps `error.message` only if it matches `^[a-z_]{3,48}$` and `details` only if it is a bare identifier or
    counted list; anything else becomes `rpc_failed`. There is no `error.message` rendering in components.
  - Edge Functions: every POST function reads its body through `readLimitedBody` (byte cap). RPC errors are mapped through
    `mapRpcError` / `mapCompleteError` to generic kinds, and logs carry fixed codes only.
- **Result:** no finding.

## Residual risks (accepted, tracked for Phase 12)

1. **Edge Functions were never booted locally** (Deno and Docker are unavailable in this sandbox). Their pure logic is
   unit-tested in Vitest and their DB side in pgTAP, but the `Deno.serve` wiring, env loading and the Auth Admin and Storage API
   calls are unexecuted. Mitigation: run `supabase functions serve` together with the E2E suite on staging before cutover.
2. **The E2E suite is mocked** (see §1). The a11y smokes scan mocked states, so pages or states that no spec renders are not
   scanned. Examples: the platform portal pages, the menu and inventory dialogs, and dark or tenant-branded themes. A tenant can
   still choose a primary colour with poor contrast against white button text. The branding validator checks hex shape only.
   This is tracked as a Phase 12 UX item: a contrast warning in the branding editor.
3. Static-host headers (`public/_headers`) only take effect if the host serves that file (Netlify or Cloudflare Pages). Another
   host must replicate them (deploy-checklist).
4. The `*.supabase.co` wildcard in CSP must be narrowed to the project origin at deploy time (already noted in `_headers`).

## Verification (this branch)

| check | result |
|---|---|
| `pnpm typecheck && pnpm lint && pnpm test -- --run && pnpm build` | pass: 87 files / 1081 unit tests; build without chunk-size warning |
| `./scripts/db-test.sh` | pass: 49 files / 3552 assertions, both passes; race tests pass |
| `pnpm exec playwright test` (mocked) | 71 / 71 pass (including the 8 new `a11y:` tests) |
| `pnpm audit --audit-level=high --prod` | no known vulnerabilities |

## Files

- `supabase/migrations/20261003004000_hardening.sql`: duplicate index drop, `profile_secrets` index
- `supabase/tests/database/52_hardening.test.sql`: 23 catalog invariants and the penetration sweep
- `tests/e2e/a11y.ts` and `a11y:` tests in `smoke`, `pos`, `kds`, `cashier`, `reports`, `day-close` and `config-domains` specs
- `src/index.css` (contrast tokens, reduced motion), `src/features/shell/ShellNav.tsx`,
  `src/features/platform/PlatformShell.tsx`, `src/features/auth/TrustedDevicesCard.tsx`
- `public/_headers`, `tests/unit/headers.test.ts`, `vite.config.ts`, `package.json` / `pnpm-lock.yaml`
- `docs/architecture/security-controls.md` (Phase 11 row)
