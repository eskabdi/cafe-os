# Orders API (Phase 4, Waiter POS) — migration `20261003003300_orders_pos.sql`

All endpoints are **Private** (signed-in tenant user) PostgREST RPCs: `POST /rest/v1/rpc/<name>`. The tenant and the actor come from the JWT
(`fn_tenant_status_guard`, `auth.uid()`), never from a parameter. Clients hold only SELECT on `orders` / `order_items` (RLS `orders_select`:
`orders.view` and (`orders.view_all` or own order or a station the role covers)); these RPCs are the only writers. `fn_order_create` is
**Internal** (no client EXECUTE): the one order pipeline, reused later by the QR / table-session entry point.

| endpoint | permission | effect |
|---|---|---|
| `fn_submit_order(p_items, p_idempotency_key, p_order_type='dine-in', p_table_id=null, p_customer_note=null)` | `orders.create` | validates the cart, prices from `menu_items` (FOR SHARE), VAT from `restaurants.vat_rate`, totals, `ORD-nnnn`, station routing, recipe stock consumption, table state, audit; replay of the same key returns the same order (`replayed: true`) |
| `fn_cancel_order(p_order_id, p_reason=null)` | `orders.cancel` + visibility | only while every line is pending, nothing is paid and the day is open; compensating stock reversal; returns `{order_id, order_no, status, reversed_movements, already_cancelled}`. The table is released in the table-session phase (Phase 6/QR), not here |
| `fn_set_station_items_status(p_order_id, p_station_id, p_status)` | station access | `preparing` / `ready` for that station's lines; order status rolls up |
| `fn_serve_order(p_order_id)` | creator / `orders.view_all` | a READY order becomes `served` |

`p_items` = `[{ "menu_item_id": uuid, "qty": 1..99, "note": string ≤ 200 | null }]`, 1..50 lines. No price, subtotal or total is ever accepted.

```http
POST /rest/v1/rpc/fn_submit_order
{ "p_items": [{ "menu_item_id": "4f1c…", "qty": 2, "note": null }], "p_idempotency_key": "6c0e…(uuid)", "p_order_type": "dine-in", "p_table_id": "9a7d…" }
200 { "id": "…", "order_no": "ORD-0042", "status": "submitted", "subtotal": 71.00, "vat_rate": 15.00, "vat_amount": 10.65, "total": 81.65, "items": [ … ], "replayed": false }
400 { "code": "P0001", "message": "insufficient_stock", "details": null }
400 { "code": "P0001", "message": "day_closed", "details": "no open business day" }
```

Errors: `day_closed`, `insufficient_stock`, `item_unavailable`, `idempotency_conflict` (same key, different cart), `invalid_state`
(`idempotency_pending`, `table_unavailable`), `order_not_cancellable` (`in_preparation`, `payment_recorded`), `invalid_state_transition`,
`invalid_input` (`items|menu_item_id|qty|note|customer_note|order_type|table_id|reason|status`), `permission_denied`, `not_found`,
`tenant_suspended`, `tenant_read_only`.

Lock order (deadlock-free; race-tested): idempotency key → open day (FOR SHARE) → table → menu items (id order) → counter → every recipe
ingredient of the cart in ONE statement (id order) → ledger. Order quotas are monitor-only (owner decision 2026-10-08).

Frontend: `/r/<slug>/pos` (`src/features/pos/PosPage.tsx`): categories and menu from the tenant's rows, cart as intent, one idempotency key
per cart (kept across retries, renewed when the cart changes), send disabled without an open day, server totals shown after sending,
Realtime refresh of menu and orders.

## Station display (Phase 5)

`/r/<slug>/stations/<stationId>` (`src/features/stations/StationTickets.tsx`) is the ONE generic board for every station row:
- reads `order_items` of that station (`pending | preparing | ready`, order not cancelled / served) with the order header (RLS
  `order_items_select`: `orders.view` + station access); tickets grouped per order, oldest first, age badge (10 / 20 min bands, fixed
  status colours);
- actions: Start / Ready → `fn_set_station_items_status(order, station, preparing|ready)`; Cancel (only with `orders.cancel`, every line
  still pending) → `fn_cancel_order`;
- Realtime on `order_items` filtered by `station_id` (RLS applies to every event): any change refreshes the board, an INSERT plays the
  **order-fired chime** (owner requirement; Web Audio, armed by the "Turn sound on" button because browsers block audio without a
  gesture; the on/off choice is a per-device UI pref);
- a new station works without a redeploy: name, colour and icon come from its row (E2E `kds.spec.ts` uses a data-only "Grill").
