# Notes: future TODO tasks

Owner requests recorded on 2026-10-12. **Not implemented yet. Do not start without picking them up as a planned task.**

## 1. Orders page scoped to the signed-in user

- The orders page shows only the signed-in user's orders, filtered by user id.
  - A waiter can see and cancel **only their own orders**.
- Stations see only **their own ordered items**: the items routed to that station, not whole orders.
- Enforce the rule in the database (RLS policies and the RPCs such as `fn_cancel_order`), not only in the UI filter.

## 2. Staff-specific dashboard KPIs

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
