# CafeOS

Secure multi-tenant restaurant-operations SaaS (Ethiopian market, currency ETB). React 18 + TypeScript + Vite + Tailwind + shadcn/ui on Supabase (Postgres, Auth, Realtime, Storage). The database is the authority for prices, VAT, totals, stock, payments and permissions; the client only sends intents.

Specs live in [`docs/spec`](docs/spec): the [execution prompt](docs/spec/execution-prompt.md) wins on conflicts, then the [roadmap](docs/spec/CafeOS-Development-Roadmap.md) and the [SaaS architecture](docs/spec/CafeOS-SaaS-Architecture.md). See [`CLAUDE.md`](CLAUDE.md) for the hard rules.

## Quick start

Requires Node 22+ (`.nvmrc`), pnpm 10 and Docker (for local Supabase).

```bash
pnpm install
pnpm dlx supabase start        # local Postgres, Auth, Realtime, Storage, Studio
pnpm dlx supabase db reset     # applies supabase/migrations/*.sql + supabase/seed.sql
cp .env.example .env.local     # fill VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY from `supabase start`
pnpm dlx supabase gen types typescript --local > src/lib/supabase/types.ts   # rerun after every migration
pnpm dev                       # http://localhost:5173
```

Only `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` ever reach the browser. The service-role key is never used client-side.

## Scripts

| Command                          | Purpose                                                                  |
| -------------------------------- | ------------------------------------------------------------------------ |
| `pnpm dev` / `build` / `preview` | Vite dev server, production build (typechecked), preview                 |
| `pnpm typecheck`                 | `tsc --noEmit` (strict, `noUncheckedIndexedAccess`)                      |
| `pnpm lint`                      | forbidden-pattern scan (`scripts/check-forbidden-patterns.mjs`) + ESLint |
| `pnpm format`                    | Prettier                                                                 |
| `pnpm test -- --run`             | Vitest (unit + component)                                                |
| `pnpm test:e2e`                  | Playwright (starts `pnpm dev`; needs local Supabase for later phases)    |
| `pnpm test:db`                   | pgTAP via `scripts/db-test.sh`                                           |

The phase gate (also CI `quality`): `pnpm typecheck && pnpm lint && pnpm test -- --run && pnpm build`.

## Layout

`src/app` (shell, providers, routes) · `src/features/*` · `src/components/ui` (shadcn) · `src/lib/{supabase,domain,utils}` · `src/hooks` · `src/services` · `src/types` · `supabase/{migrations,functions,seed.sql}` · `tests/{unit,e2e}`.
