# Day Close API (Phase 9) — migration `20261003003800_day_close.sql`

All endpoints are **Private** (signed-in tenant user) PostgREST RPCs: `POST /rest/v1/rpc/<name>`. Tenant and actor come from the JWT
(`fn_tenant_status_guard`), never from a parameter. Clients hold only SELECT on `day_sessions` (RLS: `reports.view` / `day_close.execute` /
`day.open`); these RPCs are the only writers. `fn_day_figures(rid, day, counts)` and `fn_day_json(rid, day)` are **Internal** (no client EXECUTE).
No new table: `day_sessions` (0005) already carries the close snapshot columns; RLS is unchanged.

| endpoint | permission | effect |
|---|---|---|
| `fn_close_day_preview()` | `day_close.execute` | read-only: the figures the close would freeze for the open day (collections by method, expenses by category, expected cash, per-station ingredient stock, unpaid order count) |
| `fn_close_day(p_counted_cash, p_station_counts, p_note, p_idempotency_key)` | `day_close.execute` | atomic close of the open day: snapshot + variance, expires table / customer sessions, frees occupied tables, audit `day.closed` |
| `fn_open_day(p_opening_float, p_idempotency_key)` | `day.open` | opens the next day (`day_no = last + 1`) with the opening float; resets the daily inventory counters; audit `day.opened` |
| `fn_list_days(p_limit=60)` | `reports.view` or `day_close.execute` | day history, newest first, with the frozen figures (1..366) |

`p_station_counts` = `[{ "ingredient_id": uuid, "counted": number }]` (≤ 2000, distinct, this tenant's ingredients, 0..999999999.999, ≤ 3
decimals). An ingredient without a count is taken as counted = expected (ledger stock).

Figures (all `numeric`, computed server-side; the client sends intents only):
- `gross_collected` = order + down + installment payments of the day − reversals of the day; `cash_collected` = same, methods whose
  `affects_cash_drawer` snapshot is true (no name-keyed "Cash").
- `cash_expenses` = expenses of the day paid with a cash-drawer method; `expenses_total` = all expenses of the day.
- `expected_cash = opening_float + cash_collected − cash_expenses`; `cash_variance = counted_cash − expected_cash`.
- `net_profit = gross_collected − expenses_total`; `order_count` = non-cancelled orders of the day.
- `payment_snapshot` / `expense_snapshot` / `station_snapshot` keep ids **and** name snapshots; `inventory_variance` = Σ(counted − expected).
- The count does not post stock corrections: a variance is a finding; corrections stay explicit ledger rows in the next day.

Errors (`P0001`, message = code, detail): `permission_denied`, `invalid_input|counted_cash|station_counts|note|opening_float|limit`,
`day_closed|no open business day`, `day_close_blocked|unpaid_orders:<n>` (an order of a closed day can never be paid: pay, voucher or
cancel first), `invalid_state|day_open` (only one open day), `idempotency_conflict` (same key, different payload),
`invalid_state|idempotency_pending`, `tenant_suspended` / read-only tenant states from the guard.

Rules:
- **Idempotency**: tenant-scoped key per command (`day.close`, `day.open`) with a payload hash; a replay returns the stored result with
  `replayed: true` and writes no second audit row.
- **Locking**: `fn_close_day` takes the open day `FOR UPDATE`; every order / payment / stock command holds it `FOR SHARE` while writing, so
  nothing lands in the day while it closes. `fn_open_day` serialises on the tenant row; the one-open-day partial unique index is the backstop.
- **Frozen**: once closed, `trg_guard_day_session` refuses any update/delete (`closed_day_immutable`), and the `trg_01_closed_day` guards
  refuse writes to the day's orders, items, payments, stock movements, vouchers, installments and sessions (`day_closed`).
- **No reopen**: a closed day is never reopened; the new-day workflow is the only way forward (execution prompt §29).

Frontend: `src/lib/supabase/day.ts` (Zod-parsed wrappers), `src/lib/domain/day-close.ts` (display-only variance tones),
`src/features/day-close/DayClosePage.tsx` at `/r/<slug>/day-close` (route + nav gated by `day_close.execute`; the open-day form by `day.open`;
expenses by `expenses.view` / `expenses.manage`). Dates use the Ethiopian calendar and clock in the tenant time zone; Arabic numerals.
Tests: `supabase/tests/database/46_day_close.test.sql`, `src/lib/supabase/day.test.ts`, `src/lib/domain/day-close.test.ts`,
`tests/e2e/day-close.spec.ts` (gate: close → new day).
