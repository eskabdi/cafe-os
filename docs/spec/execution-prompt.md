CafeOS — Production Transformation Master Execution Prompt

You are the lead principal engineer responsible for transforming the existing CafeOS prototype into a secure, production-ready, multi-tenant SaaS platform.

This is an execution task, not a planning exercise.

Do not merely describe what should be built. Inspect the existing project, create the architecture, implement the database, backend, frontend, security controls, tests, and deployment configuration, run the tests, fix failures, and leave the project in a working state.

The final application must be capable of serving real restaurants and real staff on multiple independent devices.

---

1. SOURCE OF TRUTH

Use the attached CafeOS materials as the authoritative product specification.

Primary functional source

"cafeos.html"

This is the authoritative reference for:

- existing screens
- user workflows
- terminology
- business rules
- menu/POS behavior
- order lifecycle
- station workflow
- payments
- installments
- inventory
- QR ordering
- tables
- expenses
- users/roles
- reports
- day close
- receipt/voucher behavior
- navigation structure
- UX patterns
- seeded restaurant data
- permission-matrix concept

Do not redesign the product simply because the prototype implementation is technically weak.

Preserve the product behavior and UX wherever practical while replacing the implementation underneath.

The prototype is the functional specification.

The prototype is NOT the security model, persistence model, authorization model, or production architecture.

Secondary architecture sources

Use the supplied CafeOS architecture and roadmap documents as the architectural baseline.

Preserve their intended direction:

- React 18
- TypeScript
- Vite
- Tailwind CSS
- shadcn/ui
- TanStack Query
- Supabase
- PostgreSQL
- Supabase Auth
- Supabase Realtime
- Supabase Storage
- Framer Motion
- Recharts
- Zod
- Vitest
- Playwright
- pgTAP / database security tests

Where the older architecture conflicts with the newer dynamic-reference-data requirements in this prompt, this prompt wins.

---

2. PRIMARY MISSION

Transform CafeOS from a single-browser prototype into:

«A secure, multi-tenant, real-time restaurant operations SaaS platform with server-authoritative business logic, PostgreSQL-enforced tenant isolation, dynamic tenant configuration, durable auditability, and production-grade testing.»

The application must support independent devices such as:

- waiter tablet
- cashier terminal
- kitchen KDS
- pastry KDS
- bar KDS
- manager laptop/tablet
- QR customer device

All devices must work against the same authoritative backend state.

An action performed on one device must become visible to authorized devices through the database and realtime layer.

There must be:

- no shared browser state
- no production localStorage domain database
- no client-authoritative permissions
- no client-authoritative pricing
- no client-authoritative stock
- no client-authoritative payment confirmation
- no tenant isolation based only on frontend logic

---

3. NON-NEGOTIABLE ARCHITECTURAL RULES

Rule 1 — DATABASE IS THE AUTHORITY

PostgreSQL is the source of truth for:

- tenants
- staff
- roles
- permissions
- stations
- categories
- payment methods
- table areas
- expense categories
- menu
- recipes
- inventory
- orders
- order items
- payments
- vouchers
- installments
- tables
- table sessions
- QR credentials
- customer sessions
- expenses
- business days
- audit logs

The client displays and requests changes.

The database and server-side domain functions decide whether those changes are valid.

---

Rule 2 — MULTI-TENANCY IS FOUNDATIONAL

Use:

shared database + shared PostgreSQL schema + tenant-scoped rows + PostgreSQL RLS

The tenant/root entity is "restaurants".

Every tenant-owned operational table must contain:

restaurant_id

or be transitively protected through a parent table whose tenant relationship is rigorously enforced.

Never trust a client-provided "restaurant_id" by itself.

The authenticated identity must determine tenant membership.

A malicious user must not be able to:

- change "restaurant_id"
- query another restaurant
- update another restaurant
- create data in another restaurant
- subscribe to another tenant's realtime data
- access another tenant's storage objects
- infer another tenant's sensitive records through error behavior

Cross-tenant isolation must be enforced by PostgreSQL RLS and tested directly.

---

4. THE SIX DYNAMIC TENANT CONFIGURATION DOMAINS

CafeOS has exactly six tenant-editable configuration domains that must be fully data-driven:

1. Roles
2. Stations
3. Categories
4. Payment Methods
5. Table Areas
6. Expense Categories

ABSOLUTE GENERALIZATION RULE

«For these six domains: NEVER implement the domain as PostgreSQL enums, hardcoded frontend string switches, or name-keyed color maps. IDs and database records are authoritative. Names are presentation data only. Adding, renaming, reordering, activating, deactivating, or extending one of these domains must work without source-code modification and without redeployment.»

This rule is mandatory.

Do not create:

create type station as enum (...);
create type menu_category as enum (...);
create type pay_method as enum (...);

Do not create code such as:

if (station === "kitchen") ...
switch (category) ...
if (paymentMethod === "cash") ...

Do not create:

ROLE_COLORS["waiter"]
STATION_ICONS["bar"]
CATEGORY_COLORS["breakfast"]
PAYMENT_LABELS["cash"]

Do not use human-readable names as foreign keys.

Use UUID identifiers and database relationships.

Finite workflow states such as order/item/payment lifecycle states may use constrained values or state tables where appropriate, but the six tenant-editable configuration domains must remain relational data.

---

5. DYNAMIC REFERENCE DATA MODEL

Implement relational tables similar to:

roles
stations
categories
payment_methods
table_areas
expense_categories

Every tenant-owned record must include:

id
restaurant_id
name
description/label where needed
sort_order
is_active
created_at
updated_at

Use UUID primary keys.

Add appropriate uniqueness constraints such as:

unique (restaurant_id, normalized_name)

where appropriate.

Names may be renamed.

IDs must remain stable.

Never use a name as an internal identity.

---

6. ROLE ARCHITECTURE

Only two roles are hardcoded as system concepts.

Hardcoded system roles

"platform_super_admin"

CafeOS platform-level operator.

Capabilities may include:

- tenant administration
- platform monitoring
- tenant suspension/reactivation
- platform configuration
- support operations
- platform audit access

This role is NOT a restaurant staff role.

It must never be granted merely because a tenant user changes their role.

---

"tenant_admin"

Restaurant owner/administrator.

This is the tenant-level administrative role.

The prototype's:

super_admin
manager

must collapse into this single concept.

There must not be separate tenant roles for prototype "super_admin" and "manager".

---

7. PROTOTYPE STAFF ROLES BECOME SEED DATA

The prototype's five operational roles become normal tenant role records:

- cashier
- waiter
- kitchen
- pastry
- bar

They are seed rows, not schema-level roles.

They may be renamed, deactivated, or extended according to dependency rules, except where a role is marked system-reserved.

Tenants must be able to create new roles.

Example:

Runner
Supervisor
Host
Delivery Coordinator
Shift Lead

A tenant-created role must behave like any other role without a redeployment.

---

8. ROLE/PERMISSION MODEL

Do not hardcode a role-to-module matrix in application code.

Use relational permission definitions.

Recommended structure:

roles
permissions
role_permissions

A permission should have a stable machine identity.

For example:

dashboard.view
orders.view
orders.create
orders.cancel
payments.create
inventory.adjust
users.manage
reports.view
day_close.execute

For stations use parameterized permissions:

station:<station_uuid>

or an equivalent structured representation.

Do not use:

station:kitchen
station:bar
station:pastry

as hardcoded application concepts.

The station UUID is the identity.

---

9. DYNAMIC STATIONS ARE TRUE MODULES

This is a mandatory architectural requirement.

The prototype contains:

- Kitchen
- Pastry
- Bar

Those must become ordinary station rows.

The frontend must not contain hardcoded assumptions that only those three stations can exist.

Required behavior

When a tenant creates:

Grill

the application must automatically support:

- new station record
- station-specific permissions
- sidebar entry
- KDS route
- KDS page
- role-permission matrix column
- station ticket filtering
- station inventory association
- menu-item assignment
- recipe association
- realtime updates
- authorization
- reporting

with:

zero source-code modification and zero redeployment.

---

10. GENERIC KDS

Replace hardcoded:

KitchenBoard
PastryBoard
BarBoard

with one generic station board component.

Conceptually:

StationKDS

receives:

stationId

and resolves all configuration from the database.

Example route:

/stations/:stationId

or equivalent.

The board must load:

- station details
- authorized user
- station orders
- item statuses
- ticket timing
- station-specific actions

from database state.

Never branch on station name.

---

11. DYNAMIC CATEGORIES

Categories such as:

- Breakfast
- Lunch
- Fast Food
- Beverages

must become tenant records.

A tenant can create:

Desserts

and immediately:

- see it in POS filters
- use it on menu items
- see it in menu management
- use it in reporting
- deactivate it
- rename it

without deployment.

The POS must obtain category lists dynamically.

Do not write:

const categories = ["Breakfast", "Lunch", "Fast Food", "Beverages"]

in production application code.

---

12. DYNAMIC PAYMENT METHODS

Payment methods such as:

- Cash
- CBE Birr
- Telebirr
- Card

must become tenant records.

A tenant can create:

Amole

and the entire application must automatically support it anywhere payment methods are relevant:

- payment dialog
- cash/payment summaries where applicable
- reports
- receipts
- voucher installment collection
- filters
- configuration
- audit records

Do not branch on payment method names.

Historical payments must retain a snapshot sufficient to render correctly even if a payment method is later renamed or deactivated.

---

13. DYNAMIC TABLE AREAS

The prototype areas:

- Main Hall
- Terrace
- VIP

must become database records.

A tenant can create:

Garden
Rooftop
Private Dining

without redeployment.

Tables reference "table_area_id".

Never store area names as the authoritative relation.

---

14. DYNAMIC EXPENSE CATEGORIES

The prototype categories:

- Purchases
- Utilities
- Rent
- Salaries
- Maintenance
- Transport
- Marketing
- Other

must become tenant records.

A tenant can add:

Licensing
Security
Cleaning

and these must appear automatically in:

- expense forms
- reports
- dashboard aggregates
- day-close snapshots
- filters

No code change.

---

15. NO NAME-KEYED COLOUR SYSTEM

Never do:

const colors = {
  kitchen: "...",
  pastry: "...",
  bar: "..."
}

Never do:

CATEGORY_COLORS["Desserts"]

Dynamic entities may contain presentation attributes such as:

color
icon
icon_name
display_color

or an equivalent structured field.

The UI resolves those values from the entity itself.

However:

semantic system status colors remain fixed.

For example:

- cancelled
- overdue
- error
- success
- warning

must not become tenant-branded meanings.

Tenant branding may affect application accent/brand colors, but semantic status meaning must remain globally consistent.

---

16. SAFE DELETION AND DEACTIVATION

"Delete" must never mean "destroy whatever is connected."

Use both:

1. database dependency protection
2. soft deactivation

Where historical/business references exist, deactivate rather than physically delete.

Use:

ON DELETE RESTRICT

for important domain relationships.

Do not casually use:

ON DELETE CASCADE

on business records.

Examples:

Station

Cannot be deleted if referenced by:

- menu items
- ingredients
- order item snapshots
- station-related historical records

Instead:

is_active = false

Category

Cannot be deleted if referenced by menu items or historical records.

Payment Method

Cannot be deleted if referenced by payment records.

Historical payments must always remain interpretable.

Table Area

Cannot be deleted while tables depend on it.

Expense Category

Cannot be deleted while expenses depend on it.

Role

Cannot be deleted while users are assigned to it.

System role "tenant_admin" can never be deleted or disabled.

General behavior

Deletion UI must explain the dependency preventing deletion.

Do not silently fail.

---

17. TENANT BRANDING

Restaurants must be able to customize tenant branding without separate frontend builds.

Support at minimum:

logo
primary_color
accent_color
restaurant name
phone
address
TIN

Load tenant branding from the database.

Apply it through CSS custom properties / theme provider.

Do not compile one tenant's branding into the application.

Semantic status colors remain platform-standard.

---

18. MULTI-TENANT ROUTING

Use tenant-aware routing such as:

/r/<tenant-slug>/...

or the architecture's equivalent.

Future custom-domain support should remain structurally possible.

The authenticated session must still resolve the actual restaurant identity server-side.

Do not use URL slug alone as a security boundary.

---

19. DATABASE CORE

Create production PostgreSQL migrations for at least the following logical entities.

SaaS/platform

restaurants
plans
subscriptions
platform_admins
platform_invoices
admin_audit_log

Identity and authorization

profiles
roles
permissions
role_permissions

Dynamic tenant configuration

stations
categories
payment_methods
table_areas
expense_categories

Restaurant operations

menu_items
recipe_lines
ingredients
stock_movements
tables
table_sessions
qr_credentials
customer_sessions
day_sessions
orders
order_items
payments
vouchers
installments
expenses
audit_logs

Add additional supporting tables where required by correct normalization, idempotency, or auditability.

---

20. ORDERS

Preserve the prototype's domain behavior.

Order submission must be a single atomic server-side transaction.

The authoritative server operation must:

1. verify tenant
2. verify authenticated user
3. verify permission
4. verify current business day is open
5. validate items
6. verify menu items are active
7. verify availability
8. read current authoritative prices
9. resolve restaurant VAT configuration
10. calculate subtotal
11. calculate VAT
12. calculate total
13. assign order number
14. enforce idempotency
15. create order
16. create order items
17. consume recipe-driven stock when enabled
18. create stock movement records
19. update table/session state if appropriate
20. write audit information
21. commit everything atomically

The client must never be able to submit:

arbitrary price
arbitrary VAT
arbitrary stock result
arbitrary tenant_id
arbitrary order total

---

21. IDEMPOTENCY

The prototype already uses a client order key.

Production must preserve the concept but enforce it server-side.

Create a durable idempotency mechanism such as:

idempotency_keys

or an equivalent unique constraint.

Repeated submission of the same logical command must not create duplicate orders.

Use a tenant-scoped uniqueness boundary.

---

22. ORDER CANCELLATION

Preserve the business invariant:

An order may be cancelled only when its items are still untouched/pending and payment is unpaid.

Cancellation must occur through a transactional server-side command.

When stock was consumed:

- reverse stock correctly
- create compensating stock movements
- preserve audit history

Never silently rewrite stock.

---

23. STATION WORKFLOW

Preserve:

submitted
→ preparing
→ ready
→ served

and item-level equivalents.

Station actions must verify:

- tenant
- user
- role/permission
- station membership/authorization
- order/item ownership of that tenant
- valid state transition

A Kitchen operator must not be able to modify Bar items merely by manipulating request data.

---

24. PAYMENTS

Payment confirmation must be server-side and transactional.

The client supplies:

order_id
payment_method_id
reference

The server determines:

- tenant
- outstanding amount
- order state
- amount
- receipt number
- payment status

Do not trust the browser to declare that an order is paid.

Receipt numbers must be generated server-side.

Payment records must be immutable from ordinary users after confirmation.

Correction/refund/reversal functionality must create compensating records rather than destructive edits.

---

25. INSTALLMENTS

Preserve the prototype's installment model:

- voucher
- customer
- phone
- down payment
- payment method
- schedule
- installment frequency
- installment records
- installment payment collection
- progress
- outstanding balance
- settled/overdue state

Server-side commands must protect against:

- double payment
- overpayment
- already-settled voucher
- invalid installment number
- invalid payment amount
- cross-tenant access

---

26. INVENTORY

Inventory must be server-authoritative.

Support:

- opening stock
- receiving
- consumption
- manual adjustment
- reversal
- minimum stock
- current stock
- cost per unit
- stock movement history

All movements must be durable.

Never "fix" stock by silently overwriting the current quantity.

Use movement/audit history.

Recipe consumption must execute transactionally with order submission when configured.

---

27. TABLES AND QR

Implement:

tables
table_areas
table_sessions
qr_credentials
customer_sessions

QR credentials must support:

- issue
- regenerate
- revoke
- active/inactive lifecycle
- table binding
- tenant binding
- auditability

When a QR credential is regenerated:

- previous active credential becomes revoked
- new credential becomes active

QR ordering must use the same canonical order-processing pipeline as waiter/cashier/manager orders.

Do not build a separate QR order engine.

QR-created orders must still pass through the same:

validation
pricing
VAT
inventory
idempotency
order creation
station routing
payment
audit

pipeline.

---

28. EXPENSES

Expenses must be tenant-scoped and tied to business-day/accounting context as appropriate.

Support:

- dynamic expense category
- amount
- payment method
- date
- description
- creator
- edits subject to authorization
- deletion subject to authorization/dependency/audit rules

Financial history must be durable.

---

29. BUSINESS DAY / EOD

Treat the business day as a real domain entity.

Use:

day_sessions

or equivalent.

Opening a day must:

- create the new business-day record
- establish opening float
- reset daily inventory counters as required
- make eligible tables available
- expire previous-day temporary sessions as required

Closing a day must calculate and snapshot:

- gross collected
- cash collected
- opening float
- cash expenses
- expected cash
- counted cash
- cash variance
- total expenses
- net position/profit
- station inventory expected counts
- station inventory counted values
- inventory variance
- expense breakdowns
- order count
- closing user
- timestamps

Once closed:

- financial day data must be frozen
- ordinary users must not edit closed-day records
- reopening must occur only through the defined new-day workflow
- historical day data must remain readable

Day close must be atomic.

---

30. AUDIT LOGGING

Create a durable audit system.

Log significant security and business events such as:

- login success/failure where practical
- account lock
- role changes
- permission changes
- staff activation/deactivation
- station creation/deactivation
- configuration changes
- menu price changes
- inventory adjustments
- stock receipt
- stock reversal
- order cancellation
- payment confirmation
- installment collection
- expense changes
- day close
- QR regeneration/revocation
- tenant suspension/reactivation
- platform impersonation/support access

Audit rows should capture enough context to answer:

who
what
when
which tenant
which record
what changed

Do not allow ordinary client code to rewrite its own audit history.

Where practical, create audit records from security-definer commands/triggers.

---

31. AUTHENTICATION

Supabase Auth must be the actual identity layer.

The prototype's profile-picker + PIN interaction may be preserved as the user experience, but:

Never store plaintext PINs.

Never verify a PIN purely in the browser.

Recommended model:

- authenticated staff identity through Supabase Auth
- profile record linked to "auth.users"
- server-side hashed PIN / fast unlock where PIN UX is required
- server-side lockout tracking
- secure session/token handling
- no PIN in client-readable domain state

At minimum enforce:

- failed-attempt counter
- temporary lockout
- active/inactive account
- tenant membership
- proper authorization
- secure session expiry

Never place privileged service-role credentials in the browser.

---

32. AUTHORIZATION

Authorization must have two layers.

Layer A — tenant configuration

The editable role-permission matrix determines what the UI exposes.

Layer B — server authorization ceiling

RLS and server-side command authorization determine what can actually happen.

Therefore:

«A permission checkbox can reduce access but can never grant a capability that the server does not permit.»

Do not treat "can(...)" in React as security.

Do not trust hidden buttons.

Do not trust disabled inputs.

Do not trust client route guards.

Every sensitive operation must be re-authorized server-side.

---

33. RLS

Enable Row Level Security on all tenant-sensitive tables.

Use secure helper functions where appropriate:

current_user_id()
current_restaurant_id()
current_role_id()
has_permission(...)
is_platform_super_admin(...)

Security-definer functions must use an explicit safe "search_path".

Avoid recursive RLS problems.

RLS policies must cover:

- SELECT
- INSERT
- UPDATE
- DELETE

where applicable.

Realtime access must respect the same tenant and authorization model.

Storage policies must also be tenant-aware.

---

34. PLATFORM ADMIN

Implement a separate platform-level administrative surface for:

platform_super_admin

It must not share tenant authorization simply because both use Supabase.

Support at least:

- tenant list
- tenant search
- tenant status
- tenant provisioning
- tenant activation
- tenant suspension
- subscription overview
- platform audit history
- controlled support/impersonation capability if implemented

Any impersonation/support access must:

- require explicit platform authorization
- generate an audit log
- produce a clearly scoped session
- never silently turn a tenant admin into a platform admin

---

35. FRONTEND ARCHITECTURE

Use a maintainable feature-based React structure.

Example:

src/
  app/
  components/
  features/
    auth/
    dashboard/
    orders/
    waiter/
    stations/
    cashier/
    menu/
    inventory/
    expenses/
    vouchers/
    tables/
    qr/
    users/
    reports/
    settings/
    tenant-config/
  lib/
  hooks/
  types/
  services/

Keep domain logic out of giant components.

Do not recreate the single-file prototype architecture in many smaller files.

---

36. TANSTACK QUERY

Use TanStack Query as the server-state layer.

Use it for:

- restaurant configuration
- role data
- permissions
- stations
- categories
- payment methods
- table areas
- expense categories
- menu
- inventory
- orders
- payments
- vouchers
- reports
- day sessions

Use query invalidation after successful server commands.

Do not make browser state the system of record.

Ephemeral UI state may remain local.

---

37. REALTIME

Use Supabase Realtime for authoritative operational changes.

Realtime consumers should include:

- KDS
- cashier unpaid orders
- order views
- dashboard live feed
- vouchers
- inventory alerts
- expenses
- configuration changes where useful

Do not poll every few seconds as the primary synchronization mechanism.

Target live operational updates of approximately two seconds or less under normal conditions.

---

38. API / RPC ARCHITECTURE

Sensitive domain operations must use server-side functions/RPCs.

At minimum create equivalents of:

fn_provision_tenant
fn_submit_order
fn_cancel_order
fn_consume_stock
fn_reverse_stock
fn_receive_stock
fn_adjust_stock
fn_confirm_payment
fn_generate_voucher
fn_confirm_installment
fn_open_day
fn_close_day
fn_manage_qr_credential
fn_create_table_session
fn_close_table_session
fn_update_role_permissions
fn_change_user_role

Add additional commands when required.

Each RPC must:

- verify authenticated user
- determine tenant server-side
- verify role/permission
- validate all inputs
- perform all related writes transactionally
- maintain invariants
- generate audit events
- return safe structured results
- avoid leaking sensitive data

---

39. SECURITY-DEFINER RPC RULES

Use:

security definer

only when genuinely required.

Every security-definer function must:

- explicitly set safe "search_path"
- qualify important object references
- validate tenant ownership
- validate caller authorization
- avoid trusting client-provided tenant IDs
- avoid privilege escalation paths

Never write insecure "god functions" that bypass all authorization.

---

40. FILE UPLOADS

Menu photos and future tenant assets must use Supabase Storage.

Do not store base64 images in localStorage or database rows.

Storage paths must be tenant-scoped, for example:

restaurants/<restaurant_id>/menu/<file>

Enforce:

- authentication where required
- tenant ownership
- MIME/type validation
- file size limits
- safe filenames
- object access policy
- no executable content
- safe image rendering
- delete/update authorization

Do not trust file extensions.

---

41. XSS / INPUT SAFETY

The old prototype uses direct HTML rendering patterns.

The production React implementation must never reproduce unsafe string-templated HTML.

Do not use raw HTML insertion unless absolutely required and safely sanitized.

Treat all tenant-entered data as untrusted:

- restaurant names
- menu names
- table names
- customer names
- notes
- expense descriptions
- role names
- station names
- category names
- payment method labels

Use React escaping by default.

---

42. DATABASE CONSTRAINTS

Use database constraints aggressively.

Examples:

- positive quantities
- non-negative prices
- valid monetary ranges
- unique tenant names/keys where needed
- unique tenant order numbers
- unique receipt numbers
- unique voucher numbers
- valid business-day references
- valid foreign keys
- restricted deletes
- immutable historical relationships where required

Do not depend exclusively on TypeScript validation.

---

43. MONEY

Use PostgreSQL "numeric", not floating-point money arithmetic.

All calculations must be deterministic.

Server-side pricing must control:

- subtotal
- VAT
- total
- paid
- outstanding
- variance
- expense totals
- net profit

Avoid financial calculations in JavaScript as the authoritative calculation.

Client calculations may be for previews only.

---

44. HISTORICAL SNAPSHOTS

Historical records must remain readable even when configuration entities change.

For example, an order item should retain:

menu_item_id
name_snapshot
price_snapshot
station_id or equivalent historical station reference

A payment should retain sufficient data to render the historical payment method correctly.

A closed day should contain required snapshots.

Do not make historical documents depend entirely on today's configuration labels.

---

45. RECEIPTS AND VOUCHERS

Preserve the prototype's receipt and installment-voucher UX.

Implement reusable React document components.

Support:

- on-screen preview
- print
- thermal-friendly layout
- future printer integration path

Do not rely exclusively on transient modal HTML.

Documents must be reproducible from durable database data.

---

46. UI / DESIGN

Preserve the CafeOS prototype's recognizable visual language and operational clarity.

Use:

- clean modern SaaS layout
- high information density where operationally useful
- strong hierarchy
- large touch targets for restaurant staff
- responsive tablet support
- desktop support
- mobile support where applicable
- accessible keyboard navigation
- clear loading/success/error states
- concise confirmations
- minimal distracting animation

Use:

- Tailwind
- shadcn/ui
- Framer Motion
- Lucide icons
- Recharts

Do not turn the application into a generic template dashboard.

The prototype's workflow and terminology have priority over generic SaaS conventions.

Use the supplied design references as refinement guidance rather than replacing CafeOS's established product identity.

---

47. MOTION

Use motion intentionally.

Appropriate examples:

- station ticket enter/exit
- realtime badge count pulse
- cart add/remove
- modal/drawer transitions
- voucher progress changes
- subtle route transitions

Do not add unnecessary animations to operational controls.

Restaurant staff optimize for speed and recognition.

---

48. MODULES

The production application must retain the core operational modules represented by the prototype:

1. Dashboard
2. Waiter POS
3. Dynamic Station/KDS modules
4. Cashier
5. All Orders
6. Tables & QR
7. Menu
8. Inventory
9. Expenses
10. Installments/Vouchers
11. Users & Roles
12. Reports / Day Close
13. Settings

Dynamic station modules must replace the prototype's hardcoded station pages.

Tenant configuration screens must expose management of:

- roles
- stations
- categories
- payment methods
- table areas
- expense categories

---

49. SETTINGS / TENANT CONFIGURATION UX

Create a clear tenant administration area.

The tenant admin must be able to:

Roles

- create
- edit
- activate/deactivate
- manage permissions
- prevent deletion when assigned

Stations

- create
- rename
- icon/color configuration
- activate/deactivate
- dependency-aware deletion

Categories

- create
- rename
- sort
- activate/deactivate
- dependency-aware deletion

Payment methods

- create
- rename
- configure
- activate/deactivate
- dependency-aware deletion

Table areas

- create
- rename
- sort
- activate/deactivate
- dependency-aware deletion

Expense categories

- create
- rename
- sort
- activate/deactivate
- dependency-aware deletion

Changes should take effect without redeployment.

---

50. SEED DATA

Seed one realistic demonstration tenant.

Seed:

- tenant_admin
- cashier
- waiter
- kitchen
- pastry
- bar

Seed representative:

- stations
- categories
- payment methods
- table areas
- expense categories
- menu items
- ingredients
- recipes
- tables

The seeded data should reproduce the prototype's normal operating behavior.

But remember:

seed data is data, not code.

The application must continue to work if those seed values are renamed, deactivated, or extended.

---

51. THE CRITICAL GENERALIZATION E2E TEST

This is mandatory.

Create a dedicated Playwright end-to-end test proving that CafeOS does not secretly depend on prototype names.

The test must use new values that never existed as prototype hardcoded concepts.

Create:

Station: Grill
Category: Desserts
Payment Method: Amole
Role: Runner

Then prove all of them work through the same generic mechanisms.

Test sequence

1. Sign in as tenant admin.
2. Create "Grill".
3. Confirm a dynamic "Grill" KDS entry appears without page redeploy.
4. Create "Desserts".
5. Create "Amole".
6. Create "Runner".
7. Assign "Runner" a suitable permission set.
8. Assign a staff user the "Runner" role.
9. Create a menu item under "Desserts".
10. Assign it to "Grill".
11. Create its recipe.
12. Create an order containing that item.
13. Confirm it routes to the generic Grill KDS.
14. Start the Grill ticket.
15. Mark it ready.
16. Serve the order.
17. Pay using Amole.
18. Confirm the payment appears in the payment list/report.
19. Confirm the Runner sees only the permissions assigned to Runner.
20. Reload the application.
21. Confirm all dynamic configuration survives.
22. Confirm no code path depends on the words Grill, Desserts, Amole, or Runner being known beforehand.

Stronger acceptance condition

This test should be capable of being repeated with another arbitrary station/category/payment method/role without source modification.

This is the architectural proof that the system is genuinely generalized.

---

52. REQUIRED CORE E2E FLOWS

Implement and pass at least these four functional gates.

E2E FLOW 1 — Complete order lifecycle

Waiter login
→ open order
→ menu selection
→ submit
→ station realtime
→ preparing
→ ready
→ serve
→ cashier
→ payment
→ receipt

Verify database state at each major stage.

---

E2E FLOW 2 — Installment lifecycle

Order
→ generate installment voucher
→ down payment
→ schedule
→ installment payment
→ next installment
→ final settlement

Verify:

- balances
- receipt numbers
- voucher status
- payment history

---

E2E FLOW 3 — Business day close/reopen

open day
→ create operational activity
→ create expense
→ collect payment
→ count cash
→ count station stock
→ close day
→ verify variance
→ open new day

Verify that historical day data remains frozen.

---

E2E FLOW 4 — Dynamic configuration generalization

Use:

Grill
Desserts
Amole
Runner

and prove the complete generalized path.

This fourth flow is non-negotiable.

It is the architectural regression test against accidental reintroduction of prototype-name assumptions.

---

53. SECURITY TESTING

Create explicit tests for:

Tenant isolation

Tenant A must not read/write Tenant B.

Test both:

- direct table access
- RPC invocation
- realtime subscriptions
- storage

---

IDOR / BOLA

Attempt to replace UUIDs in:

- order requests
- payment requests
- voucher requests
- inventory requests
- expense requests
- table requests
- user-management requests

with another tenant's IDs.

Every unauthorized attempt must fail.

---

Role escalation

Test:

waiter → admin
cashier → tenant_admin
Runner → unrestricted role

through:

- request tampering
- direct mutation attempts
- RPC parameter manipulation
- client-side UI manipulation

---

Permission bypass

A user with no permission must be unable to perform the action even if:

- frontend button is manually invoked
- API/RPC called directly
- route manually entered
- request body manipulated

---

Station isolation

A station operator must not modify another station's operational state unless explicitly authorized.

Example:

Grill operator
≠ automatically authorized to change Bar

---

Audit integrity

Verify ordinary clients cannot:

- edit audit rows
- delete audit rows
- forge actor identity
- create fake audit history for another user

---

54. MAKER-CHECKER / HIGH-RISK OPERATIONS

Where practical, introduce controlled confirmation for especially sensitive administrative operations.

At minimum consider stronger authorization/audit requirements for:

- role changes
- tenant suspension
- large financial corrections
- payment reversals
- day-close correction/reopen
- inventory adjustments above configured thresholds

Do not unnecessarily over-engineer normal floor operations.

---

55. TESTING STACK

Implement:

Unit tests

Vitest for:

- pricing
- VAT calculation
- installment schedule generation
- permission logic
- state-transition helpers
- normalization
- configuration selectors

Integration tests

Supabase/PostgreSQL tests for:

- RPC behavior
- constraints
- authorization
- transactionality
- dependency guards

Database security tests

Use pgTAP or equivalent.

Must include:

- tenant isolation
- role isolation
- RLS behavior
- platform/tenant boundary
- delete restrictions
- dynamic permission behavior

End-to-end

Use Playwright.

Run against a seeded disposable environment.

---

56. DEFINITION OF DONE

The system is NOT considered production-ready because the screens look correct.

It is done only when all of the following are true:

Foundation

- production React/Vite/TypeScript project
- linting
- formatting
- type checking
- CI
- environment management
- reproducible local setup

Database

- migrations cleanly apply from zero
- schema normalized
- constraints present
- tenant scoping present
- restricted deletes present
- audit support present

Security

- RLS enabled
- cross-tenant penetration tests pass
- RPC authorization tests pass
- no browser service-role key
- no plaintext PINs
- storage security implemented
- sensitive operations audited

Dynamic architecture

- no enums for the six tenant-editable configuration domains
- no hardcoded station names
- no hardcoded category names
- no hardcoded payment-method names
- no hardcoded table-area names
- no hardcoded expense-category names
- no name-keyed colour maps
- dynamic permissions work
- dynamic KDS works
- arbitrary tenant role works
- dynamic configuration survives reload

Operations

- order lifecycle works
- inventory math works
- payments work
- installments work
- QR ordering works
- expenses work
- day close works
- reports work
- receipts work

Realtime

- multi-device order updates work
- KDS updates live
- cashier receives live orders
- inventory changes propagate
- relevant configuration updates propagate

Testing

- unit suite green
- integration suite green
- pgTAP/RLS suite green
- Playwright suite green
- dynamic generalization E2E green

Production build

- "typecheck" passes
- "lint" passes
- tests pass
- production build passes
- no uncaught console errors
- no critical accessibility issues
- no exposed secrets
- no deprecated prototype persistence mechanisms remaining

---

57. FORBIDDEN PRODUCTION PATTERNS

Do NOT ship:

- localStorage as the domain database
- plaintext passwords/PINs
- client-side-only authorization
- frontend-only tenant isolation
- client-controlled totals
- client-controlled VAT
- client-controlled payment status
- client-controlled stock
- hardcoded station switch statements
- hardcoded category arrays
- hardcoded payment-method arrays
- role-name conditional security
- name-keyed color objects
- PostgreSQL enums for the six dynamic domains
- destructive cascade deletes for business reference data
- fake APIs
- static mock data presented as live data
- hidden routes as security
- service-role credentials in the frontend
- arbitrary "innerHTML" with tenant data
- duplicate order creation on retry
- silent financial edits
- mutable historical payment records
- mutable closed-day records

---

58. PHASED EXECUTION MODEL

Execute the project through these phases.

Do not jump directly to polishing UI while foundational security is incomplete.

Phase 0 — Foundations

Deliver:

- repository structure
- Vite/React/TypeScript
- Tailwind
- shadcn/ui
- Query
- Supabase configuration
- testing infrastructure
- ESLint/Prettier
- CI

Gate:

install
→ typecheck
→ lint
→ test
→ build

all green.

---

Phase 1 — Schema, Tenant Isolation, Auth

Deliver:

- restaurants
- platform_admins
- profiles
- roles
- permissions
- role_permissions
- six dynamic configuration domains
- core business schema
- migrations
- RLS
- seed data
- auth/session foundation
- helper SQL authorization functions
- core RPC infrastructure
- pgTAP security tests

Gate:

- clean database bootstrap
- seed succeeds
- login succeeds
- cross-tenant RLS tests pass
- dynamic reference tables work

No phase may bypass tenant isolation.

---

Phase 2 — Generic App Shell and Design System

Deliver:

- routing
- tenant resolution
- sidebar
- header
- mobile navigation
- tenant theme
- loading states
- error states
- generic permission-driven navigation
- generic dynamic station navigation

Gate:

- no hardcoded station navigation
- routes respect permissions
- responsive shell works

---

Phase 3 — Menu and Inventory

Deliver:

- dynamic categories
- dynamic stations
- menu CRUD
- recipes
- storage upload
- ingredients
- stock receiving
- stock adjustment
- stock movement log

Gate:

- menu item + recipe → real stock math works

---

Phase 4 — Waiter POS

Deliver:

- dynamic category filters
- dynamic menu
- cart
- order submission
- idempotency
- day-open checks
- server-side totals

Gate:

- order lands correctly in Postgres
- stock transaction correct

---

Phase 5 — Generic Station KDS

Deliver:

- generic StationKDS
- station permissions
- realtime
- dynamic sidebar
- dynamic station filtering
- start/ready/cancel
- ticket animation

Gate:

- create a new station and use it without redeploy
- realtime target passes

---

Phase 6 — Cashier and Payments

Deliver:

- payment methods from DB
- dynamic payment UI
- payment RPC
- receipts
- payment history

Gate:

- complete order-to-payment flow passes

---

Phase 7 — Installments

Deliver:

- vouchers
- schedules
- collection
- receipt generation
- outstanding balances

Gate:

- installment E2E passes

---

Phase 8 — Dashboard and Reports

Deliver:

- KPIs
- charts
- live activity
- expense aggregation
- category aggregation
- payment method aggregation
- waiter metrics
- inventory metrics

Gate:

- hand-calculated fixture comparison passes

---

Phase 9 — Day Close

Deliver:

- cash count
- station inventory count
- variance
- expense snapshot
- day closure
- new day

Gate:

- close/reopen E2E passes

---

Phase 10 — Settings, Roles and Dynamic Configuration

Deliver:

- roles
- role matrix
- stations
- categories
- payment methods
- table areas
- expense categories
- user management
- tenant branding

Gate:

- all six domains dynamically editable
- dependency guards work
- no redeploy needed

---

Phase 11 — Hardening

Deliver:

- complete Playwright suite
- RLS penetration testing
- IDOR/BOLA testing
- authorization bypass testing
- accessibility pass
- performance optimization
- query/index optimization
- storage security audit
- secret audit
- error handling audit

Gate:

zero critical or high-risk findings.

---

Phase 12 — Production Cutover

Deliver:

- production Supabase project
- production migrations
- secret configuration
- backups
- monitoring
- deployment
- domain routing
- tenant provisioning
- production seed/bootstrap
- operational documentation

Then perform:

staging verification
→ production migration
→ smoke tests
→ security verification
→ controlled launch

Archive the prototype.

Do not delete it.

---

59. IMPLEMENTATION ORDER WITHIN EACH PHASE

For each phase follow this exact pattern:

1. Inspect current code
2. Define/adjust schema
3. Create migration
4. Create/adjust RPCs
5. Create RLS policies
6. Add backend tests
7. Add TypeScript types
8. Implement query hooks
9. Implement mutation hooks
10. Implement UI
11. Implement realtime
12. Add E2E coverage
13. Run typecheck
14. Run lint
15. Run tests
16. Fix all failures
17. Verify against previous phases

Do not build UI first and postpone authorization.

---

60. ERROR HANDLING

Use structured errors.

Errors should expose safe business information such as:

order_not_cancellable
day_closed
insufficient_stock
permission_denied
dependency_exists
invalid_state_transition
voucher_already_settled
tenant_suspended

Do not expose:

- SQL
- stack traces
- secret values
- internal auth data
- cross-tenant existence information

Map technical errors into user-readable messages at the UI boundary.

---

61. PERFORMANCE

Optimize for restaurant operational usage.

Priorities:

1. fast POS interactions
2. fast KDS rendering
3. realtime latency
4. reliable transaction completion
5. low bundle size
6. minimal unnecessary rerenders

Use:

- code splitting
- lazy routes
- proper indexes
- selective queries
- pagination where appropriate
- TanStack Query caching
- efficient Realtime subscriptions

Do not compromise correctness for superficial performance optimization.

---

62. ACCESSIBILITY

Ensure:

- keyboard navigation
- visible focus
- accessible labels
- semantic buttons
- accessible dialogs
- accessible tables
- readable contrast
- no color-only status meaning
- adequate touch targets
- screen-reader-friendly controls

Particular attention:

- PIN keypad
- permission matrix
- KDS action buttons
- payment dialogs
- delete confirmations
- mobile navigation

---

63. CI/CD

CI must run:

install
lint
typecheck
unit tests
integration tests
build
E2E where environment permits

Database migrations must be version controlled.

Never make manual production schema edits part of the normal deployment process.

---

64. PRODUCTION ENVIRONMENT VARIABLES

Never commit secrets.

Frontend may receive only safe public configuration.

Never expose:

SUPABASE_SERVICE_ROLE_KEY

or equivalent privileged credentials.

Use environment-specific configuration.

---

65. MIGRATION AND BACKWARD COMPATIBILITY

Treat the prototype as a functional reference, not as a production data source.

Do not copy its "localStorage" architecture into the new app.

If an import utility is created for demo migration:

- make it explicit
- make it one-way
- validate all imported records
- run it server-side
- preserve audit context
- never allow it to bypass tenant isolation

---

66. IMPORTANT DESIGN PRINCIPLE

When a requirement can be solved either by:

A

adding a special case for the current prototype value

or

B

making the data model genuinely generic

always choose B.

Examples:

Do not add:

Grill support

Add:

generic station support

Do not add:

Amole support

Add:

generic payment-method support

Do not add:

Desserts support

Add:

generic category support

Do not add:

Runner support

Add:

generic tenant role support

---

67. FINAL ARCHITECTURAL TEST

Before declaring the project complete, answer this through actual automated tests:

«If the seeded restaurant's Kitchen, Pastry and Bar stations were renamed or deactivated, a new Grill station were created, the default categories were replaced with different categories, a new Amole payment method were introduced, and a new Runner role were created, would CafeOS still function correctly without changing source code?»

The answer must be:

YES.

And that answer must be demonstrated by automated tests, not by explanation.

---

68. FINAL EXECUTION INSTRUCTION

Do not stop after producing architecture diagrams.

Do not stop after creating migrations.

Do not stop after creating UI.

Do not stop after a successful build.

Do not declare the application production-ready while security tests or E2E tests are failing.

Implement the complete system.

Where an existing implementation is incompatible with the architecture, replace it.

Where the prototype has hardcoded assumptions, generalize them.

Where a security boundary exists, enforce it server-side.

Where data is historical, preserve it immutably.

Where configuration is tenant-editable, store it as tenant data.

Where a business transaction spans multiple writes, make it atomic.

Where the UI needs live state, use Realtime.

Where authorization matters, enforce it in PostgreSQL/RPCs.

Where a behavior is important enough to matter in production, create an automated test for it.

At the end, provide a concise implementation report containing:

1. architecture implemented
2. database migrations created
3. RPCs created
4. RLS policies created
5. frontend modules completed
6. dynamic configuration domains completed
7. E2E flows passed
8. security tests passed
9. remaining non-blocking issues, if any
10. production deployment instructions

Do not provide fake completion claims.

Only report something as complete when it has actually been implemented and verified.
