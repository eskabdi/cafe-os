# Payments API (Phase 6, Cashier) — migration `20261003003400_payments.sql`

All endpoints are **Private** (signed-in tenant user) PostgREST RPCs: `POST /rest/v1/rpc/<name>`. The tenant and the actor come from the JWT
(`fn_tenant_status_guard`, `auth.uid()`), never from a parameter. Clients hold only SELECT on `payments` (RLS `payments_select`:
`payments.view`); these RPCs are the only writers. `fn_receipt_json` is **Internal** (no client EXECUTE): the receipt document builder.

| endpoint | permission | effect |
|---|---|---|
| `fn_confirm_payment(p_order_id, p_payment_method_id, p_reference, p_idempotency_key, p_tendered=null)` | `payments.create` | pays the order IN FULL: amount = `orders.total` (server-side), `RCT-nnnn`, method name / cash-drawer snapshots, `orders.payment_status = 'paid'`, audit `payment.confirmed`; returns the receipt + `tendered` / `change`. Replay of the same key returns the same receipt (`replayed: true`) |
| `fn_reverse_payment(p_payment_id, p_reason, p_idempotency_key)` | `payments.reverse` + step-up (TOTP ≤ 12 h) | appends a compensating `reversal` row (same amount / method, own receipt number, reason as reference) and sets the order back to `unpaid`; one reversal per payment (unique index); audit `payment.reversed` |
| `fn_get_receipt(p_payment_id)` | `payments.view` (any receipt of the tenant) or `payments.create` (only receipts the caller issued) | the receipt document |

Rules:
- The payment method is a tenant row (UUID), never a name. `requires_reference` → `p_reference` is required (≤ 120 chars, no control
  characters). `p_tendered` is accepted only for an `affects_cash_drawer` method and must cover the total; the change is returned, not stored.
- The client never sends an amount to charge. Money is `numeric`; the client change preview is display-only.
- Payments are immutable: never updated or deleted; corrections are reversals. A payment lands in the OPEN business day, and only an
  order of the open day can be paid or have its payment reversed: an order / payment of a closed day answers `day_closed`
  (`order business day is closed` / `payment business day is closed`); closed-day corrections belong to the day-close phase.
- A reversal requires the order to be `paid` (`invalid_state/order_not_paid` otherwise). After a reversal the order is unpaid and,
  if no line has started, can be cancelled (`fn_cancel_order` checks the NET payment).
- Replays rebuild the receipt (current `reversed` flag); the fingerprint includes the actor, so another user reusing a key conflicts.
- Lock order (every order command, including the 0034 redefinitions of `fn_cancel_order`, `fn_set_station_items_status`,
  `fn_serve_order`, and Phase 9 `fn_close_day`): idempotency key → open day (FOR SHARE) → order (FOR UPDATE) → payment method (FOR SHARE) → counter.

```http
POST /rest/v1/rpc/fn_confirm_payment
{ "p_order_id": "aaaa…", "p_payment_method_id": "1111…", "p_reference": "AM-998877", "p_idempotency_key": "6c0e…(uuid)", "p_tendered": null }
200 { "payment_id": "…", "receipt_no": "RCT-0007", "kind": "order_payment", "amount": 173.65, "method": "Amole", "reference": "AM-998877",
      "restaurant": { "name": "…", "tin": "…", "timezone": "Africa/Addis_Ababa" }, "order": { "order_no": "ORD-0042", "items": [ … ], "total": 173.65 },
      "tendered": null, "change": null, "replayed": false }
400 { "code": "P0001", "message": "order_not_payable", "details": "paid" }
400 { "code": "P0001", "message": "insufficient_tendered", "details": null }
```

Errors: `day_closed` (`no open business day|order business day is closed|payment business day is closed`), `order_not_payable` (`cancelled|paid|installment|zero_total`), `insufficient_tendered`, `idempotency_conflict`,
`invalid_state` (`idempotency_pending|already_reversed|not_an_order_payment|order_not_paid`), `invalid_input`
(`order_id|payment_method_id|reference|tendered|payment_id|reason`), `permission_denied`, `step_up_required`, `mfa_required`, `not_found`,
`tenant_suspended`, `tenant_read_only`.

Frontend: `/r/<slug>/cashier` (`src/features/cashier/CashierPage.tsx`, nav permission `payments.create`): unpaid orders of the open day
(Realtime on `orders` / `payments`), bill from the order rows, payment methods rendered from the tenant's rows (colour, icon, flags), one
idempotency key per intent (frozen and resent after an unknown outcome), printable 80 mm receipt (`ReceiptView`, print CSS) with the
Ethiopian date and clock (Arabic numerals, `src/lib/domain/ethiopian-time.ts`) and the international time. Payments of the day
(`payments.view`) with receipt reprint and reversal (`payments.reverse`, reason, step-up dialog).
