# Installments API (Phase 7) — migration `20261003003500_installments.sql`

All endpoints are **Private** (signed-in tenant user) PostgREST RPCs: `POST /rest/v1/rpc/<name>`. The tenant and the actor come from the JWT,
never from a parameter. Clients hold only SELECT on `vouchers` / `installments` (RLS: `vouchers.view`); these RPCs are the only writers.
`fn_voucher_json`, `fn_tenant_today` and `fn_receipt_json` are **Internal** (no client EXECUTE).

| endpoint | permission | effect |
|---|---|---|
| `fn_generate_voucher(p_order_id, p_customer_name, p_customer_phone, p_down_payment, p_down_method_id, p_down_reference, p_installment_count, p_interval_days, p_idempotency_key)` | `vouchers.manage` + `orders.view` | an unpaid order of the open day becomes a voucher `VCH-nnnn`: the schedule is computed server-side from the order total; optional down payment (own receipt); order → `installment` |
| `fn_confirm_installment(p_voucher_id, p_payment_method_id, p_reference, p_idempotency_key, p_installment_no=null, p_tendered=null)` | `vouchers.manage` + `orders.view` | collects the NEXT unpaid installment at its scheduled amount in the open day; own receipt with the voucher block (balance right after this payment) |
| `fn_get_voucher(p_voucher_id)` | `vouchers.view` | voucher, schedule, paid / outstanding, computed status, next due |
| `fn_list_vouchers(p_status=null, p_limit=200)` | `vouchers.view` | newest first, optionally filtered by computed status (`active|overdue|settled`) |

Rules:
- **Schedule** (server): balance = total − down; `ceil(balance / n)` whole birr per installment, remainder in the last; if that would leave the
  last installment ≤ 0, an even split to the cent with the remainder in the last. Due dates every `interval_days` from the tenant's local
  date (`restaurants.timezone`). The UI preview (`src/lib/domain/installments.ts`) mirrors the rule; the server is authoritative.
- **Down payment**: `0 ≤ down < total`; a positive down needs an active method row (reference rule of the row applies).
- **Status is computed, never stored**: `settled` (all paid) > `overdue` (an unpaid installment due before the tenant's today) > `active`.
- **Guards**: double payment (voucher lock + lowest unpaid installment; at issue: order lock + payment_status check; same key → same receipt; `p_installment_no` must be the next one →
  `invalid_installment_no|<next>`), overpayment (`voucher_already_settled`), invalid amount (amounts come from the schedule only),
  cross-tenant (`not_found`), an order with a live payment (`order_not_payable|paid`), closed-day orders (`day_closed`).
- Installment payments are not reversible here: a settled installment of a closed day is frozen by the day guard (0019).
- Lock order: generate — key → open day (FOR SHARE) → order (FOR UPDATE) → payment method (FOR SHARE) → counters; collect — key → open
  day (FOR SHARE) → voucher (FOR UPDATE) → next installment (FOR UPDATE) → payment method → counter (the voucher lock serialises
  collections; the order row is not touched).
- Both commands require the order to be visible to the caller (same rule as RLS `orders_select`); otherwise `not_found`.
- A settled voucher leaves its order at `payment_status = 'installment'` (a closed-day order is frozen); "fully paid" is the voucher's
  computed `settled` status, which reports use.
- `fn_get_receipt` also lets a `vouchers.manage` holder reprint the voucher payments they took.
- Customer names follow First + Middle + Last (form hint; not enforced, since a guest may give fewer names).

```http
POST /rest/v1/rpc/fn_confirm_installment
{ "p_voucher_id": "cccc…", "p_payment_method_id": "1111…", "p_reference": "AM-1", "p_idempotency_key": "6c0e…", "p_installment_no": 2 }
200 { "receipt_no": "RCT-0011", "kind": "installment_payment", "amount": 225.00,
      "voucher": { "voucher_no": "VCH-0003", "installment_no": 2, "installment_count": 4, "outstanding": 450.00 }, "voucher_status": "active", "replayed": false }
400 { "code": "P0001", "message": "invalid_installment_no", "details": "3" }
400 { "code": "P0001", "message": "voucher_already_settled", "details": null }
```

Frontend: `/r/<slug>/installments` (`src/features/installments/InstallmentsPage.tsx`, nav `vouchers.view`): status filter, cards with progress
and next due (Ethiopian date, Arabic numerals), voucher dialog with the schedule and collection (method rows, reference, amount received),
new-voucher dialog with the live schedule preview, printable receipts with the voucher block, Realtime on vouchers / installments.
