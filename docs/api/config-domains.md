# Configuration Domains API (Phase 10) — migration `20261003003900_config_domains.sql`

Stations, menu categories, payment methods, table areas, expense categories (the dynamic tenant domains; roles and the permission matrix
are Phase 3B, `docs/api/portals.md`) and restaurant tables are relational rows keyed by UUID. Presentation (`color`, `icon`, `sort_order`)
lives on the row; no code knows a row by its name. Changes take effect at once (nav, POS, KDS, cashier, day close read the rows), with no
redeploy.

## Writes
| operation | path | permission | notes |
|---|---|---|---|
| list | `GET /rest/v1/<table>` | tenant member (RLS `<table>_select`) | no `restaurant_id` filter is sent; RLS scopes it |
| create | `POST /rest/v1/<table>` | `config.manage` (`tables.manage` for `tables`) + writable tenant | RLS `with check restaurant_id = current_restaurant_id()`; column grants limit the writable columns; row-audited (`trg_audit`) |
| edit / activate / deactivate | `PATCH /rest/v1/<table>?id=eq.<uuid>` | same | deactivation runs the guard below; zero rows touched = refused (the client reports `permission_denied`) |
| usage | `POST /rest/v1/rpc/fn_config_usage` `{p_domain, p_id}` | same | **Private**. Counts of every reference |
| delete | `POST /rest/v1/rpc/fn_delete_config_row` `{p_domain, p_id}` | same | **Private**. The UI's only delete path; audit `config.row_deleted` |

`p_domain` is a closed list of table identifiers: `stations`, `categories`, `payment_methods`, `table_areas`, `expense_categories`,
`tables`; anything else is `invalid_input|domain` before any SQL is built. Both RPCs are `security definer`, `search_path = ''`, take the
tenant from `fn_tenant_status_guard` (never a parameter) and answer `not_found` for another tenant's id (indistinguishable from a missing
one). `fn_config_usage_counts`, `fn_config_domain_check` and the trigger function are **Internal** (no client EXECUTE).

## Dependency guards
Deactivation is the supported, always-available path, even while rows depend on the row (Phases 3–5 rely on it: the order pipeline
answers `item_unavailable` for an inactive item / station / category, a station board still finishes its open tickets, history keeps
name snapshots). The one exception is `trg_guard_deactivation` (BEFORE UPDATE OF `is_active`, payment_methods only): the tenant's
LAST active payment method cannot be deactivated (`in_use|last_active_method`), or the cashier could take no money.

Delete is refused with `in_use|<key>:<n>,...` while ANY row (active or historical) refers to it (FKs are `ON DELETE RESTRICT`; history
keeps name snapshots, so the answer is "deactivate instead"). A reference that appears between the count and the delete is still answered
`in_use|references`. The last active payment method cannot be deleted either (`in_use|last_active_method`).

`fn_config_usage` result keys: stations `menu_items, active_menu_items, ingredients, active_ingredients, order_items,
active_open_order_items, stock_movements, role_access`; categories `menu_items, active_menu_items, order_items`; payment_methods
`payments, expenses, vouchers`; table_areas `tables, active_tables`; expense_categories `expenses`; tables `orders, table_sessions,
qr_credentials`. `active_*` keys are the live subset and never block a delete on their own.

Errors (`P0001`, message = code, detail): `in_use|<counted list>|last_active_method|references`, `invalid_input|domain|id`,
`permission_denied`, `not_found`, `tenant_suspended`, `tenant_read_only`; on direct writes also `23505` (duplicate name → UI
`duplicate_name`).

Frontend: `src/lib/supabase/config.ts` (domain specs, Zod-parsed reads, closed column lists per domain), one generic
`src/features/config/ConfigDomainPage.tsx` mounted per domain at `/r/<slug>/settings/{stations,categories,payment-methods,table-areas,
tables,expense-categories}`; routes and nav entries are generated from the same spec / catalogue and gated by `config.manage` /
`tables.manage`. Stations keep feeding the generated KDS nav (`StationsProvider`, Realtime). The delete dialog checks usage first and
explains the blocker; the server refusal is shown the same way.
Tests: `supabase/tests/database/51_config_domains.test.sql`, `src/lib/supabase/config.test.ts`, `tests/e2e/config-domains.spec.ts`
(guards), `tests/e2e/generalization.spec.ts` (Grill / Desserts / Amole / Runner created at runtime, full order → KDS → pay).
