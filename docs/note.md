# Notes: future TODO tasks

Owner requests recorded on 2026-10-12. Tasks 1 and 2 are done; task 3 is **not implemented yet. Do not start them without picking them up as a planned task.**

## 1. Orders page scoped to the signed-in user

**Done 2026-10-12** (migration `20261003004100_orders_own_scope.sql`, pgTAP `53_orders_own_scope`, E2E `orders-own-scope.spec.ts`): scope decided by `orders.view_all` / new `orders.cancel_any`, see `docs/architecture/rls-matrix.md`.

- The orders page shows only the signed-in user's orders, filtered by user id.
  - A waiter can see and cancel **only their own orders**.
- Stations see only **their own ordered items**: the items routed to that station, not whole orders.
- Enforce the rule in the database (RLS policies and the RPCs such as `fn_cancel_order`), not only in the UI filter.

## 2. Staff-specific dashboard KPIs

**Done 2026-10-12** (migration `20261003004200_my_dashboard.sql`, pgTAP `54_my_dashboard`, E2E in `reports.spec.ts`): new `fn_my_dashboard(from, to)` (own orders / own stations only); variant chosen by permission in `src/lib/domain/dashboard.ts` (`reports.view` or `orders.view_all` keeps the main dashboard; otherwise `orders.create` gives the own-orders section and station access the station section, both when both). Also fixed: `fn_dashboard.orders_by_status` is now scoped like `recent`, and the KDS Cancel is decided per ticket (own order, or `orders.cancel_any`). See `docs/api/reports.md`.

- The dashboard shows KPIs for the signed-in staff member's own role and work:
  - **Waiter:** their own orders, sales, average order value, served and cancelled counts, and performance.
  - **Station:** their own station's items, such as queue, in progress, ready, and preparation times.
- Every other role keeps the current main dashboard unchanged.
- Choose the dashboard by role permissions or station access. Never key it on role or station names: these are the dynamic tenant domains.

## 3. Rename the product from "CafeOS" to "Asor"

- Replace every "CafeOS" name, text and string with "Asor". This covers:
  - UI copy, the page `<title>`, the PWA manifest (`name` and `short_name`), email templates, docs, the README and the specs where they refer to the product.
  - Code identifiers and comments.
- The new logo (`public/icons/*`, `favicon.ico`) is already in place.
- Do the rename as one planned task:
  - Do not rename database objects, migrations, storage paths or test container names (such as `cafeos-dbtest`) without a migration plan.
  - Keep `docs/prototype/cafeos.html` archived under its original name.
