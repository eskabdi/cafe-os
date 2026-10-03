# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project state

CafeOS is a greenfield rebuild of a single-file HTML/React prototype into a secure multi-tenant restaurant-operations SaaS (Ethiopian market, currency ETB). **No application code exists yet** — only specs and the prototype under `docs/`. The commands below are the ones the roadmap prescribes (§16–17); verify they exist in `package.json` before relying on them.

Source-of-truth documents (read before designing anything):
- `docs/spec/execution-prompt.md` — master execution prompt; **wins over the older docs** on conflicts (notably dynamic reference data).
- `docs/spec/CafeOS-Development-Roadmap.md` — single-restaurant module spec: schema DDL, RLS plan, RPC signatures, phases, testing, CI.
- `docs/spec/CafeOS-SaaS-Architecture.md` — multi-tenant layer: ADR-001 (shared schema + RLS), ADR-002 (slug routing), platform admin, billing, tenant theming.
- `docs/prototype/cafeos.html` — functional/UX reference only (screens, terminology, workflows, seed data). It is NOT the security, persistence or auth model. Archive it, never delete it.
- `docs/design/` — Apple-style motion/typography and "Modern Chronos" tokens: refinement guidance only; keep CafeOS's own identity (primary `#dc2626`, Inter).

## Commands (planned stack: pnpm, Vite 5, Vitest, Playwright, Supabase CLI)

```bash
pnpm install
pnpm dlx supabase start            # local Postgres/Auth/Realtime/Storage (needs Docker)
pnpm dlx supabase db reset         # apply supabase/migrations/*.sql + seed.sql from zero
pnpm dlx supabase gen types typescript --local > src/lib/supabase/types.ts   # rerun after every migration
pnpm dev                           # http://localhost:5173
pnpm typecheck && pnpm lint && pnpm test -- --run && pnpm build   # the Phase gate; also CI "quality"
pnpm test -- path/to/file.test.ts  # single Vitest file
pnpm test:e2e                      # Playwright against local Supabase
pnpm exec playwright test -g "name"  # single E2E
pnpm dlx supabase test db          # pgTAP (RLS / RPC security tests)
```

Env: client gets only `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. `SUPABASE_SERVICE_ROLE_KEY` is confined to a small audited set of Edge Functions (provisioning, billing webhook, impersonation) and CI seeding — never the browser.

## Architecture (big picture)

- **Stack:** React 18 + TS (`strict`, `noUncheckedIndexedAccess`) + Vite + Tailwind + shadcn/ui + TanStack Query + Supabase (Postgres/Auth/Realtime/Storage) + Zod + Framer Motion + Recharts. Feature-based `src/features/*`; pure domain logic in `src/lib/domain`; `supabase/{migrations,functions,seed.sql}`.
- **Database is the authority.** Prices, VAT, totals, stock, payment confirmation, receipt numbers, permissions and tenant identity are decided server-side. The client sends only intents (e.g. `order_id`, `payment_method_id`, item ids + qty). Client money math is preview-only; use `numeric`, never floats.
- **Multi-tenancy:** one shared schema, `restaurants` is the tenant root, `restaurant_id` on every tenant table, RLS as the sole isolation boundary. Tenant comes from the authenticated identity (JWT/profile), never a client-supplied `restaurant_id` and never the URL slug (`/r/<slug>/...` is only a pre-auth resolver). Every new table needs RLS policies for all relevant verbs plus a pgTAP test proving cross-tenant denial.
- **Business commands are atomic `security definer` RPCs** (`fn_submit_order`, `fn_cancel_order`, `fn_confirm_payment`, `fn_generate_voucher`, `fn_confirm_installment`, `fn_open_day`, `fn_close_day`, stock fns, QR/table-session fns, role/permission fns, `fn_provision_tenant`). Each must: explicit `set search_path`, derive tenant server-side, check permission, validate input, write audit rows, return structured safe errors (`permission_denied`, `day_closed`, `insufficient_stock`, `order_not_cancellable`, `tenant_suspended`…) with no SQL/cross-tenant leakage. Idempotency is enforced via tenant-scoped unique keys. QR ordering must reuse the same order pipeline.
- **Two-layer authz:** editable role→permission matrix (relational: `roles`, `permissions`, `role_permissions`) drives UI; RLS/RPC checks are the hard ceiling. React `can()` is UX, not security.
- **Platform vs tenant:** `platform_admins` (role `platform_super_admin`) is a separate table/surface from tenant `profiles`; impersonation/suspension always writes `admin_audit_log`. Only two hardcoded roles exist: `platform_super_admin` and `tenant_admin` (prototype `super_admin`+`manager` collapse into it).
- **Realtime** (Supabase) drives KDS, cashier, dashboard, inventory alerts; no polling as primary sync. Query invalidation after mutations.
- **Immutability:** payments, audit logs and closed `day_sessions` are never edited; corrections are compensating records (stock reversals, payment reversals). Historical rows keep snapshots (`name_snapshot`, `price_snapshot`, station/payment-method snapshot).

## Hard rules (from the execution prompt)

- **Six dynamic tenant domains — roles (non-system), stations, categories, payment methods, table areas, expense categories — are relational rows keyed by UUID.** Never use PG enums, `switch`/`if` on their names, name-keyed colour/icon maps (`STATION_COLORS["bar"]`), or names as FKs. Presentation (`color`, `icon`) lives on the row. Station permissions are `station:<uuid>`. One generic `StationKDS` at `/stations/:stationId`; nav is generated from DB.
- Semantic status colours (cancelled/overdue/error/success/warning) are fixed platform-wide and never tenant-branded; tenant branding only touches primary/accent via CSS variables (`TenantThemeProvider`).
- Deletes: `ON DELETE RESTRICT` + soft deactivation (`is_active=false`); UI must explain the blocking dependency. `tenant_admin` role can't be deleted/disabled. No `CASCADE` on business records.
- Auth: Supabase Auth is identity. **`platform_super_admin` and `tenant_admin` never use PIN login — they sign in with standard Supabase Auth (email + password, MFA-capable).** PIN login is only for non-admin staff roles; PINs are hashed and verified server-side with lockout, and PIN verification must refuse admin accounts. No plaintext PINs, no `localStorage` as domain DB, no `innerHTML` with tenant data, no base64 images (use tenant-scoped Storage paths `restaurants/<id>/...` with MIME/size checks).
- Work order per phase: schema → migration → RPCs → RLS → DB tests → types → query/mutation hooks → UI → realtime → E2E → typecheck/lint/test. Never build UI before authorization. Phases 0–12 and their gates are in the execution prompt §58.
- The mandatory Playwright "generalization" test creates station **Grill**, category **Desserts**, payment method **Amole**, role **Runner** and runs the full order→KDS→pay flow with no code knowing those names. Also required: order lifecycle, installment lifecycle, day close/reopen E2E, plus tenant-isolation/IDOR/role-escalation/audit-integrity security tests.

## Conventions specific to this project

- Ethiopian user-facing conventions: use Arabic numerals (0–9) everywhere, including the Ethiopian calendar (no Ge'ez numerals); Amharic text uses `Tayitu.ttf` primary, `Jiret.ttf` secondary; names are First + Middle + Last (short form = First + Middle); Ethiopian clock is offset 6h from international (7:00 AM = 1:00 ጠዋት, 12:00 PM = 6:00 ቀትር, 7:00 PM = 1:00 ማታ, 12:00 AM = 6:00 ለሊት).
- Keep architecture docs, ERD, DFD, OpenAPI and security docs updated alongside code; classify endpoints Public/Private/Internal; target INSA/OWASP/NIST alignment.

## Review gate and subagents

Specialised subagents live in `.claude/agents/`. **Before merging any task, dispatch in order: `code-reviewer` (via `code-review` skill), `security-auditor` (via `security-review` skill), `rls-tester` when schema/RLS/RPC changed, then `verifier` (typecheck, lint, tests, build, pgTAP, E2E).** Do not merge on red.

## Context management

If the context reaches 60% of the limit, dispatch the compact skill immediately.
