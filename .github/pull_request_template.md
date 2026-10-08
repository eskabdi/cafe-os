## Summary

<!-- What changed and why. Link the roadmap phase / issue. -->

## Review gate (CLAUDE.md)

Run in order; do not merge on red.

- [ ] `code-reviewer` (via `code-review` skill) - findings resolved
- [ ] `security-auditor` (via `security-review` skill) - findings resolved
- [ ] `rls-tester` - required if schema / RLS / RPC / auth / data access changed
- [ ] `tenant-isolation-review` - required if schema / RLS / RPC / auth / data access changed
- [ ] `verifier` - typecheck, lint, tests, build, pgTAP, E2E

## Evidence

- [ ] `pnpm typecheck && pnpm lint && pnpm test -- --run && pnpm build` green
- [ ] pgTAP (`supabase test db`) output attached/linked for any DB change (new tables have RLS + cross-tenant denial test)
- [ ] E2E / Playwright result for UI-affecting changes
- [ ] `pnpm audit --audit-level=high --prod` clean

## Docs

- [ ] Architecture docs / ERD / DFD / OpenAPI / security docs updated alongside the code
- [ ] No secrets, service-role keys or PINs committed; no new tenant-domain names hardcoded
