# Dashboard and Reports API (Phase 8)

Migration `20261003003700_reports.sql`.

All endpoints are **Private** PostgREST RPCs for a signed-in tenant user (`POST /rest/v1/rpc/<name>`). The figures are computed in the
database, so the client never adds money up. The tenant comes from the JWT / profile, never from a parameter.

**Internal** (no client EXECUTE; asserted by `45_reports` and `13_security_hygiene`): `fn_report_days(tenant, from, to)`,
`fn_report_light(tenant, day_ids)` (the dashboard's lighter builder) and `fn_report_build(tenant, day_ids)` (the full document behind
`fn_report` and `fn_report_period`).

| Endpoint | Permission | Returns |
|---|---|---|
| `fn_report(p_from_day_no = null, p_to_day_no = null)` | `reports.view` | report document over a range of business days (by number) |
| `fn_report_period(p_from date, p_to date)` | `reports.view` | the same document over tenant-local calendar dates, plus `period` |
| `fn_log_report_export(p_report, p_from, p_to, p_format)` | `reports.view` + `reports.export` (+ the section permission) | `{ok, exported_at}`; audits the export |
| `fn_dashboard()` | `dashboard.view` (money also needs `reports.view` and `payments.view`) | the open day's floor figures and live activity |

## Report types and periods (UI contract)

- **Report types:** the UI offers `summary`, `revenue`, `expenses`, `inventory`, `payments`, `staff`, `items`, `installments`,
  `cancellations` and `hourly`. Each one is a view over one `fn_report_period` document. There is no separate endpoint per type.
- **Periods:** Daily (`from = to`), Weekly, Monthly and Custom are all `[from, to]` date windows chosen by the client. The server only
  checks the window.
- **Output:** view, print, CSV and PDF are rendered client-side from the same document. Print, CSV and PDF must first succeed in
  `fn_log_report_export`.

## Range rules

`fn_report` (business-day numbers):
- Both bounds null: the open day, or the most recent day when none is open.
- One bound null: that single day (`(5, null)` = day 5 only).
- `from` or `to` < 1, `to` < `from`, or more than 367 days: `invalid_input|day_range`.

`fn_report_period` (calendar dates):
- It covers the business days whose `opened_at`, converted to `restaurants.timezone`, falls on a date within `[from, to]` inclusive. A
  day opened at local 00:30 belongs to that local date, even when the UTC date is still the previous day.
- A null bound, `to` < `from`, or more than 366 calendar days (`to - from > 365`): `invalid_input|period`.

## Sources

- Money comes from `payments`, net of reversals (a reversal row counts as minus its amount), and is grouped by the payment's business
  day. Down payments and installment payments count as collected money.
- Sales come from `orders` that are not cancelled, grouped by the order's day.
- `unpaid_total` covers non-cancelled orders with `payment_status = 'unpaid'`. A voucher order (`installment`) is not unpaid.
- Names come from the latest snapshot (payment method, waiter, item, category) or from the row (expense category, ingredient). They are
  always keyed by UUID; the code knows no names.
- `by_category` groups by `order_items.category_id_snapshot`, which is the item's category at order time (set by trigger). Moving a
  menu item to another category later does not rewrite history. Rows from before 0037 were backfilled with the category the item had
  at migration time.

## Section gating

`reports.view` is the floor: orders, sales, VAT, items, categories, hours and cancellations. Every other section needs one more
permission. A withheld section is JSON `null`, and its key appears in `restricted` (sorted).

| `restricted` key | Needs | Withheld fields |
|---|---|---|
| `payments` | `payments.view` | `kpis.gross_collected`, `kpis.cash_collected`, `kpis.net_position`, `by_payment_method`, `by_day[].collected`, `reversals` |
| `expenses` | `expenses.view` or `expenses.manage` | `kpis.expenses_total`, `kpis.net_position`, `by_expense_category`, `by_day[].expenses` |
| `installments` | `vouchers.view` | `kpis.vouchers_outstanding`, `kpis.vouchers_overdue`, `installments` |
| `inventory` | `inventory.view` | `inventory` (both lists) |
| `staff` | `reports.staff` | `by_waiter` |

Inventory is also station-scoped, using the same predicate as `ingredients_select` / `stock_movements_select`: only the caller's
stations, unless they hold `inventory.adjust` or `inventory.receive`. tenant_admin covers every station.

With the default roles, tenant_admin sees everything. Cashier (`reports.view`, `payments.view`, `vouchers.view`) gets
`restricted = ["expenses", "inventory", "staff"]`.

## fn_report / fn_report_period

```http
POST /rest/v1/rpc/fn_report_period
{ "p_from": "2026-10-01", "p_to": "2026-10-07" }
```

```json
{
  "timezone": "Africa/Addis_Ababa",
  "period": { "from": "2026-10-01", "to": "2026-10-07" },
  "days": [{ "id": "7777…", "day_no": 99, "status": "open", "opened_at": "2026-10-05T05:00:00+00:00", "closed_at": null }],
  "kpis": {
    "order_count": 4, "cancelled_count": 1, "items_sold": 6,
    "sales_total": 1000.50, "subtotal_total": 870.00, "vat_total": 130.50, "avg_order_value": 250.13, "unpaid_total": 80.50,
    "gross_collected": 720.00, "cash_collected": 720.00, "expenses_total": 50.00, "net_position": 670.00,
    "vouchers_outstanding": 200.00, "vouchers_overdue": 0
  },
  "by_day": [{ "day_session_id": "7777…", "day_no": 99, "date": "2026-10-05", "orders": 4, "sales": 1000.50, "collected": 720.00, "expenses": 50.00 }],
  "by_payment_method":   [{ "payment_method_id": "2222…", "name": "Cash", "amount": 720.00, "count": 4 },
                          { "payment_method_id": "2223…", "name": "Telebirr", "amount": 0.00, "count": 0 }],
  "by_category":         [{ "category_id": "3333…", "name": "Lunch", "qty": 3, "amount": 660.00 }],
  "by_item":             [{ "menu_item_id": "6666…", "name": "Shiro Wat", "qty": 3, "amount": 660.00 }],
  "by_waiter":           [{ "user_id": "4444…", "name": "Yonas Tesfaye", "orders": 3, "sales": 920.00 }],
  "by_expense_category": [{ "expense_category_id": "5555…", "name": "Purchases", "amount": 50.00, "count": 1 }],
  "by_hour":             [{ "hour": 0, "orders": 1, "sales": 506.00 }],
  "inventory": {
    "low_stock":   [{ "ingredient_id": "…", "name": "Blueberries", "unit": "kg", "stock": 1.200, "min_level": 1.500 }],
    "consumption": [{ "ingredient_id": "…", "name": "Coffee beans", "unit": "kg", "qty": 0.054 }]
  },
  "cancellations": { "count": 1, "amount": 80.50,
                     "items": [{ "order_no": "ORD-0003", "total": 80.50, "reason": "left", "cancelled_at": "2026-10-05T06:10:00+00:00", "by_name": "Yonas Tesfaye" }] },
  "reversals":     { "count": 1, "amount": 253.00,
                     "items": [{ "receipt_no": "RCT-0003", "amount": 253.00, "method": "Telebirr", "created_at": "2026-10-05T07:00:00+00:00", "by_name": "Selam Abate" }] },
  "installments":  { "issued_count": 1, "issued_total": 506.00, "down_total": 106.00, "collected_total": 200.00,
                     "outstanding_total": 200.00, "overdue_count": 0 },
  "restricted": []
}
```

`fn_report` returns the same document without `period`. With only `reports.view`, `restricted` is
`["expenses", "installments", "inventory", "payments", "staff"]`, and every field in the gating table is `null`.

**Definitions:**
- `sales_total`: sum of order totals, VAT included. `subtotal_total` / `vat_total`: the same orders' `subtotal` / `vat_amount`.
- `net_position`: `gross_collected − expenses_total`. It needs both the payments and the expenses permissions.
- `cash_collected`: payments whose method snapshot affects the cash drawer.
- `by_payment_method.amount` is net of reversals. `count` covers live payments only: a reversal row and the payment it reversed are not
  counted.
- `by_category.amount` / `by_item.amount`: `qty × price_snapshot`, before VAT. `by_item` is the top 100 by amount.
- `by_hour`: always 24 buckets, in the tenant's local hour of `orders.created_at`.
- `by_day.date`: the tenant-local date of the day's `opened_at`.
- `cancellations` / `reversals`: `count` and `amount` cover the whole range. `items` holds the latest 200 (`by_name` = the profile's
  short name; the reversal reason is kept only in the audit log).
- `installments`:
  - `issued_*` / `down_total`: vouchers whose order belongs to a covered day.
  - `collected_total`: installment payments taken on the covered days.
  - `outstanding_total` / `overdue_count`: tenant-wide as of now. They are computed set-based from unpaid installments; a voucher is
    overdue when one of its unpaid installments was due before the tenant's local today. These equal `kpis.vouchers_*`.
- `inventory.low_stock`: as of now. `inventory.consumption`: order consumption on the covered days, net of order reversals.

## fn_log_report_export

```http
POST /rest/v1/rpc/fn_log_report_export
{ "p_report": "revenue", "p_from": "2026-10-01", "p_to": "2026-10-31", "p_format": "pdf" }
```

```json
{ "ok": true, "exported_at": "2026-10-12T09:30:00.123+00:00" }
```

- `p_report` must be one of `summary`, `revenue`, `expenses`, `inventory`, `payments`, `staff`, `items`, `installments`,
  `cancellations`, `hourly`. `p_format` must be `csv`, `pdf` or `print`.
- The period is validated like `fn_report_period`.
- The caller needs `reports.view` and `reports.export`, plus the section permission of the report type: `expenses`, `inventory`,
  `payments`, `staff` and `installments` follow the gating table, and the other types need nothing more.
- It writes `audit_logs` with event `report.exported` and `new_data = {report, from, to, format}`. The actor and tenant come from the
  session.
- Every call is its own audited disclosure event. It is deliberately not idempotent: two exports make two rows.
- It is a read action, so a `past_due` tenant (otherwise `tenant_read_only`) may still export. A suspended or cancelled tenant gets
  `tenant_suspended`.

## fn_dashboard

```http
POST /rest/v1/rpc/fn_dashboard
{}
```

```json
{
  "timezone": "Africa/Addis_Ababa",
  "open_day": { "id": "7777…", "day_no": 12, "opened_at": "2026-10-10T05:00:00Z" },
  "orders_by_status": { "submitted": 2, "served": 1 },
  "recent": [{ "id": "aaaa…", "order_no": "ORD-0050", "status": "submitted", "payment_status": "unpaid", "table_label": "T2",
               "created_at": "2026-10-10T16:05:00Z", "total": 161.00 }],
  "low_stock_count": 1,
  "money": { "…": "kpis of the open day (same keys and gating as the report kpis)" },
  "by_hour": [],
  "by_payment_method": []
}
```

- `orders_by_status` is floor-wide and contains counts only.
- `recent` holds the last 15 orders of the open day that the caller can see under the `fn_order_visible` rule (`orders.view` plus
  view_all, own or station). The permissions are resolved once, not per row.
- Money (`money`, `by_hour`, `by_payment_method`, `recent[].total`) needs `reports.view` **and** `payments.view`. Otherwise `money`,
  `by_hour` and `by_payment_method` are absent, and `recent[].total` is null.
- Inside `money`, `expenses_total` / `net_position` are null without the expenses permission, and `vouchers_*` are null without
  `vouchers.view`.
- `low_stock_count` needs `inventory.view` and is station-scoped like `ingredients_select`; otherwise it is null.
- The dashboard uses the light builder, so it has no inventory, category, waiter or voucher lists.
- With no open day, `open_day` is null and there are no money keys.

## Errors

| Status | Body | When |
|---|---|---|
| 400 | `{ "code": "P0001", "message": "permission_denied" }` | missing permission (incl. `reports.export`, or the section permission of an export); any platform admin (no tenant profile) |
| 400 | `{ "code": "P0001", "message": "invalid_input", "details": "day_range" }` | `fn_report`: `from` or `to` < 1, `to` < `from`, or more than 367 days |
| 400 | `{ "code": "P0001", "message": "invalid_input", "details": "period" }` | `fn_report_period` / `fn_log_report_export`: null bound, `to` < `from`, or more than 366 days |
| 400 | `{ "code": "P0001", "message": "invalid_input", "details": "report" }` / `"format"` | `fn_log_report_export`: unknown report type / format |
| 400 | `{ "code": "P0001", "message": "tenant_suspended" }` | suspended or cancelled tenant (past_due keeps read access and exports) |
| 400 | `{ "code": "P0001", "message": "not_authenticated" }` | no session |
| 401/403 | `42501 permission denied for function …` | anon: no EXECUTE |

There is no plan gate. The report RPCs are read-only and write no audit row; the export RPC writes exactly one.

## Permissions

`reports.staff` ("See staff performance in reports") and `reports.export` ("Export, print and download reports") are catalogue rows in
module `reports`. The matrix UI reads their labels from the catalogue. Every existing tenant_admin role receives them through
`trg_grant_new_permission`, and new tenants receive them because `fn_seed_tenant_defaults` grants the whole catalogue to tenant_admin.
No other default role gets them; grant them in the matrix.

## Frontend

- **Dashboard:** `/r/<slug>/dashboard` (`src/features/reports/DashboardPage.tsx`, nav permission `dashboard.view`).
  - Realtime on `orders` and `payments`, with a unique channel topic per mount and debounced invalidation; no polling.
  - Realtime events are RLS-filtered: a waiter only receives events for their own orders, so floor-wide counts for other waiters'
    orders refresh on the next refetch.
- **Reports:** `/r/<slug>/reports` (`src/features/reports/ReportsPage.tsx`, nav permission `reports.view`). The business-day range is
  validated with Zod, and the server validates it again.
- **Charts:**
  - One hue (the tenant primary CSS variable) and one value axis.
  - Text is never coloured by series.
  - Each chart has an sr-only table.
- **Formatting:** ETB with Arabic numerals; Ethiopian date and clock.
- **Client:** `src/lib/supabase/reports.ts`.
