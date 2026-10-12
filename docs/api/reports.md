# Dashboard and Reports API (Phase 8)

Migration `20261003003700_reports.sql`.

Both endpoints are **Private** PostgREST RPCs for a signed-in tenant user: `POST /rest/v1/rpc/<name>`. They are read-only
aggregations computed in the database; the client never adds money up. The tenant comes from the JWT / profile, never from a parameter.

`fn_report_days(restaurant_id, from, to)` is **Internal**: it takes a tenant id and has no client EXECUTE (asserted by `45_reports` and
`13_security_hygiene`).

| Endpoint | Permission | Returns |
|---|---|---|
| `fn_report(p_from_day_no = null, p_to_day_no = null)` | `reports.view` | aggregates over a range of business days |
| `fn_dashboard()` | `dashboard.view` (money figures also need `reports.view`) | the open day's floor figures and live activity |

## fn_report

**Range:**
- Both bounds null: the open day, or the most recent day when none is open.
- One bound null: open-ended.
- Both set: from..to inclusive, at most 367 days.

**Sources:**
- Money comes from `payments`, net of reversals, grouped by the payment's business day.
- Sales come from `orders` that are not cancelled, grouped by the order's day.
- Names come from rows (categories, expense categories) or snapshots (payment method, waiter); no name is known to the code.

```http
POST /rest/v1/rpc/fn_report
{ "p_from_day_no": 9, "p_to_day_no": 11 }
```

```json
{
  "timezone": "Africa/Addis_Ababa",
  "days": [{ "id": "7777…", "day_no": 9, "status": "closed", "opened_at": "2026-10-01T05:00:00Z", "closed_at": "2026-10-01T20:00:00Z" }],
  "kpis": {
    "order_count": 2, "cancelled_count": 1, "items_sold": 3, "sales_total": 414.00, "avg_order_value": 207.00,
    "gross_collected": 414.00, "cash_collected": 161.00, "expenses_total": 50.00, "net_position": 364.00,
    "unpaid_total": 0.00, "vouchers_outstanding": 0.00, "vouchers_overdue": 0
  },
  "by_payment_method":   [{ "payment_method_id": "2222…", "name": "Telebirr", "amount": 253.00, "count": 1 }],
  "by_category":         [{ "category_id": "3333…", "name": "Lunch", "qty": 1, "amount": 220.00 }],
  "by_waiter":           [{ "user_id": "4444…", "name": "Yonas Tesfaye", "orders": 2, "sales": 414.00 }],
  "by_expense_category": [{ "expense_category_id": "5555…", "name": "Purchases", "amount": 50.00, "count": 1 }],
  "by_hour":             [{ "hour": 0, "orders": 0, "sales": 0 }],
  "inventory": {
    "low_stock":   [{ "ingredient_id": "…", "name": "Milk", "unit": "l", "stock": 1.500, "min_level": 5.000 }],
    "consumption": [{ "ingredient_id": "…", "name": "Coffee beans", "unit": "kg", "qty": 0.250 }]
  }
}
```

`by_hour` always has 24 buckets in tenant-local time.

**Definitions:**
- `sales_total`: sum of order totals, VAT included.
- `by_category.amount`: `qty × price_snapshot` before VAT, grouped by the item's current category.
- `net_position`: `gross_collected − expenses_total`.
- `cash_collected`: payments whose method snapshot affects the cash drawer.
- `vouchers_*` and `inventory.low_stock`: tenant-wide, as of now.
- `consumption`: order consumption net of order reversals over the covered days.

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
  "money": { "…": "fn_report.kpis of the open day" },
  "by_hour": [],
  "by_payment_method": []
}
```

- `orders_by_status` is floor-wide and contains counts only.
- `recent` holds the last 15 orders of the open day that the caller can see under `fn_order_visible` (`orders.view` plus view_all, own or
  station).
- Without `reports.view`:
  - `recent[].total` is null;
  - `money`, `by_hour` and `by_payment_method` are absent.
- `low_stock_count` is null without `inventory.view` or `reports.view`.
- With no open day, `open_day` is null and there are no money keys.

## Errors

| Status | Body | When |
|---|---|---|
| 400 | `{ "code": "P0001", "message": "permission_denied" }` | missing permission; any platform admin (no tenant profile) |
| 400 | `{ "code": "P0001", "message": "invalid_input", "details": "day_range" }` | `from` or `to` < 1, `to` < `from`, or a span > 367 days |
| 400 | `{ "code": "P0001", "message": "tenant_suspended" }` | suspended or cancelled tenant (past_due keeps read access) |
| 400 | `{ "code": "P0001", "message": "not_authenticated" }` | no session |
| 401/403 | `42501 permission denied for function …` | anon: no EXECUTE |

There is no plan gate and no audit row, since both endpoints are read-only. Every subquery is filtered by the server-derived tenant id.

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
