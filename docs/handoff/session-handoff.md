# Session handoff (2026-10-08)

Read this first in the next session, then `CLAUDE.md` and `docs/spec/execution-prompt.md` §58 (Phases 0–12).

## Where things stand

- **Branch:** `ccr-013f0187-mxaao1`. It is also the GitHub default branch; switching the default to `main` is recommended and needs the owner's OK.
- **Merged into `main` (squash):**
  - #1 foundation (Phases 0–1) as `d6ad985`
  - #8 action pin bumps as `35341e4`
  - Dependabot #2–#6 were superseded and closed.
- **Phases 0–1 are done:**
  - schema, RLS, Phase 1 RPCs
  - auth: Supabase Auth for admins with MFA/aal2; PIN login for staff
  - kiosk terminals, PIN-change approval, session timers
  - pgTAP tests 00–29; migrations through `20261003002800`
- **Phase 2 (generic app shell) is in progress, as `wip(unverified)` commits on the branch.** It was built by a frontend-engineer agent and is not yet verified or reviewed.
  - New: `src/features/shell/`, `src/features/stations/`, `TenantThemeProvider`, `src/lib/domain/{navigation,theme}.ts`, `src/lib/supabase/stations.ts`, plus tests.
  - Next session's first steps:
    1. Finish or verify Phase 2: `pnpm typecheck && pnpm lint && pnpm test -- --run && pnpm build`, plus `node scripts/check-forbidden-patterns.mjs` and E2E.
    2. Squash the WIP commits into one, or let the squash merge do it.
    3. Open a draft PR to `main` and subscribe to it.
    4. Run the review gate.
  - Phase 2 scope:
    - responsive shell (sidebar, header, mobile nav) with permission-driven nav from one config
    - placeholder module routes guarded by real permission codes
    - station nav loaded from the DB via RLS (`station:<uuid>`), linking to `/r/<slug>/stations/:stationId` with a generic StationKDS placeholder
    - TenantThemeProvider (validated hex, fallback `#dc2626`)
    - loading, error-boundary and empty states

## Remaining roadmap (§58)

Phase 3 menu/inventory → 4 POS → 5 KDS → 6 cashier → 7 installments → 8 dashboard → 9 day close → 10 settings → 11 hardening → 12 cutover.

Work order in every phase: schema → migration → RPCs → RLS → pgTAP → types → hooks → UI → realtime → E2E → gate.

## Standing rules

- **Review gate before every merge, in this order:**
  1. code-reviewer
  2. security-auditor
  3. rls-tester and tenant-isolation-review, when schema/RLS/RPC/auth/data access changed
  4. verifier

  Never merge on red, and never merge without the gate (the auto-mode classifier blocks it).
- Never run `db push` to staging or seed it without explicit confirmation.
- No force-push. Integrate `main` into the branch with a merge commit.
- Admins (`platform_super_admin`, `tenant_admin`) never use PIN login.
- **PIN rules:**
  - The role named `Cashier` uses 6 digits; every other PIN role uses 4. This is the single name-keyed exception.
  - Lockout: 15 min after the 3rd failure, 1 h after the 6th, 24 h after the 9th.
  - One session per PIN staff member.
  - Inactivity: warning at 15 s, sign-out at 30 s. Tenant admins may set custom timers.
- The six dynamic domains are UUID rows only: no enums, no name switches, no name-keyed maps.
- **Ethiopian conventions:**
  - Arabic numerals only (no Ge'ez).
  - Amharic font: Tayitu.ttf primary, Jiret.ttf secondary.
  - Names are First + Middle + Last; the short form is First + Middle.
  - The Ethiopian clock is offset 6 h from the international clock.
- Keep the docs in sync: ERD, DFD, RLS matrix, OpenAPI, security controls.
- Response style: terse, at most 2 lines unless there's a message for the user. Ask "do you need caveman?" at session start.

## Local testing

- pgTAP: `./scripts/db-test.sh`. Never run two at once.
- E2E: `PW_CHROMIUM_DIR=/opt/pw-browsers VITE_SUPABASE_URL=http://127.0.0.1:54321 VITE_SUPABASE_ANON_KEY=dummy pnpm test:e2e`
- The Husky pre-commit hook runs prettier/eslint, typecheck and forbidden-patterns.
- CI jobs: quality, database, e2e, security (pnpm audit, gitleaks with `.gitleaksignore` fingerprints), and CodeQL.
  - A squash merge that touches `docs/prototype/cafeos.html` creates a new gitleaks fingerprint. Allow-list it only after confirming it is the localStorage key.

## Open user decisions and residuals

- **Waiting on the user:**
  - lockout break-glass
  - `app.tenant_admin_mfa_required`
  - how the one-session rule behaves across device reboots
  - installments guard
  - whether the Cashier tile appears on kiosks
  - timing-parity measurement
- **Known gaps:**
  - A stolen JWT stays valid up to 1 h after a PIN change.
  - No admin action to revoke sessions.
  - Race between the session check and session minting.
  - The kiosk token is stored in localStorage.
  - Edge Functions are not run under Deno in CI.
  - `src/lib/supabase/types.ts` is a placeholder; regenerate it.
  - The CSP must be served by the host.
  - Deploy ordering.
  - The build has a chunk over 500 kB.
- **Optional CI hardening:**
  - `persist-credentials: false` on checkout steps
  - hash-pin the Supabase CLI download
  - the Playwright report artifact may contain seeded test data
