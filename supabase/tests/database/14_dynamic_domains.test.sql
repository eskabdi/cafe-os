-- Adversarial: the six dynamic tenant domains (roles, stations, categories, payment methods, table areas,
-- expense categories) are plain relational rows. No enum, no hard-coded name anywhere in the schema, RESTRICT
-- deletes with soft deactivation, renames that keep ids, and a DB-level generalisation proof with names this
-- codebase has never seen (Grill, Runner, Amole, ...).
begin;
select plan(83);

-- ═════════ schema contains no knowledge of domain names ═════════
select is((select count(*)::int from pg_type t join pg_namespace n on n.oid = t.typnamespace
           where n.nspname = 'public' and t.typtype in ('e', 'd')), 0, 'no enum or domain types in public');
select is((select count(*)::int from pg_type t join pg_namespace n on n.oid = t.typnamespace
           where t.typtype = 'e' and n.nspname not in ('pg_catalog', 'information_schema', 'auth', 'storage', 'realtime', 'vault', 'graphql', 'graphql_public', 'net', 'pgsodium', 'supabase_functions')),
          0, 'no enum type outside platform-owned schemas');
select is((select count(*)::int from pg_type t join pg_namespace n on n.oid = t.typnamespace
           where n.nspname = 'public' and t.typtype = 'e'
             and t.typname ~* '(station|categor|pay_?ment|table_?area|expense|role)'), 0, 'none of the six domains is an enum type');
select is((select string_agg(c.conrelid::regclass || '.' || c.conname, ',') from pg_constraint c
           where c.connamespace = 'public'::regnamespace and c.contype = 'c'
             and c.conrelid <> 'public.platform_invoices'::regclass   -- CafeOS's own billing gateways, not a tenant domain
             and pg_get_constraintdef(c.oid) ~* '''[^'']*\y(kitchen|bar|pastry|grill|juice|barista|cash|telebirr|cbe birr|card|amole|breakfast|lunch|beverages|desserts|main hall|terrace|vip|purchases|utilities|rent|salaries|waiter|cashier|runner|administrator)\y[^'']*'''),
          null, 'no CHECK constraint spells out a station / category / method / area / expense category / role name');
select is((select string_agg(p.proname, ',' order by p.proname) from pg_proc p
           where p.pronamespace = 'public'::regnamespace and p.proname not in ('fn_seed_tenant_defaults', 'fn_pin_length_for_role_name')
             and p.prosrc ~* '''(kitchen|bar|pastry|grill|juice|barista|cash|telebirr|cbe birr|card|amole|breakfast|lunch|beverages|desserts|main hall|terrace|vip|purchases|utilities|rent|salaries|waiter|cashier|runner|administrator)'''),
          null, 'no function branches on a domain name (only the data seeder, and the ONE documented user-decided exception fn_pin_length_for_role_name = Cashier PIN length, mention them)');
select is((select string_agg(p.proname, ',' order by p.proname) from pg_proc p
           where p.pronamespace = 'public'::regnamespace and p.prosrc ~* '''cashier'''),
          'fn_pin_length_for_role_name,fn_seed_tenant_defaults', 'the Cashier literal appears in exactly two functions: the seeder and the exception');
select is((select string_agg(tablename || '.' || policyname, ',') from pg_policies
           where schemaname = 'public' and coalesce(qual, '') || coalesce(with_check, '') ~* '''(kitchen|bar|pastry|grill|cash|waiter|cashier|administrator)'''),
          null, 'no RLS policy names a domain value');
select is((select string_agg(conrelid::regclass || '.' || conname, ',') from pg_constraint
           where connamespace = 'public'::regnamespace and contype = 'f' and confdeltype <> 'r'),
          null, 'every foreign key is ON DELETE RESTRICT');
select is((select string_agg(distinct attrelid::regclass::text, ',') from pg_attribute a join pg_class c on c.oid = a.attrelid
           where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
             and a.attname in ('station', 'category', 'payment_method', 'table_area', 'expense_category', 'role', 'method', 'area')
             and a.atttypid = 'text'::regtype
             and c.relname not in ('platform_invoices', 'platform_admins')),   -- platform surface, not tenant domains
          null, 'no tenant table stores a domain value as free text (all are uuid references)');
select is((select count(*)::int from pg_attribute a join pg_class c on c.oid = a.attrelid
           where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and not a.attisdropped
             and a.attname in ('color', 'icon') and c.relname in ('stations', 'categories', 'payment_methods', 'table_areas', 'expense_categories', 'roles')), 12,
          'presentation (color, icon) lives on the six domain rows');

-- ═════════ fixtures ═════════
create temp table _f on commit drop as
select tests.tenant_id('central-cafe') a, tests.tenant_id('second-cafe') b,
       tests.user_id('selam', 'central-cafe') admin, tests.user_id('abebe', 'central-cafe') kitchen_user,
       tests.user_id('yonas', 'central-cafe') waiter, tests.user_id('owner', 'second-cafe') b_admin,
       tests.role_id('Kitchen', 'central-cafe') kitchen_role, tests.role_id('Cashier', 'central-cafe') cashier_role,
       (select id from public.stations where restaurant_id = tests.tenant_id('central-cafe') and name = 'Kitchen') st_kitchen,
       (select id from public.stations where restaurant_id = tests.tenant_id('central-cafe') and name = 'Bar') st_bar,
       (select id from public.categories where restaurant_id = tests.tenant_id('central-cafe') and name = 'Lunch') cat_lunch,
       (select id from public.payment_methods where restaurant_id = tests.tenant_id('central-cafe') and name = 'Cash') pm_cash,
       (select id from public.table_areas where restaurant_id = tests.tenant_id('central-cafe') and name = 'Main Hall') area_main,
       (select id from public.expense_categories where restaurant_id = tests.tenant_id('central-cafe') and name = 'Rent') exp_rent,
       (select id from public.day_sessions where restaurant_id = tests.tenant_id('central-cafe') and status = 'open') day_id;
grant all on _f to public;
create temp table _ctx (grill uuid, desserts uuid, amole uuid, rooftop uuid, fuel uuid, runner uuid, captain uuid, fish uuid, order1 uuid, order2 uuid,
                        kitchen_item uuid, grill_ing uuid, kitchen_ing uuid);
insert into _ctx (order1) values (null);
grant all on _ctx to public;

-- an order for the cashier-visible history: payment + expense referencing Cash / Rent; item at Kitchen
insert into public.orders (restaurant_id, day_session_id, order_no, created_by, created_by_name_snapshot, subtotal, vat_rate_snapshot, vat_amount, total)
  select a, day_id, 'ORD-0002', waiter, 'Yonas Tesfaye', 420, 15, 63, 483 from _f;
update _ctx set order2 = (select id from public.orders where order_no = 'ORD-0002');
update _ctx set kitchen_item = (select id from public.menu_items where restaurant_id = (select a from _f) and name = 'Doro Wat');
insert into public.order_items (restaurant_id, order_id, menu_item_id, name_snapshot, price_snapshot, qty, station_id, station_name_snapshot)
  select f.a, c.order2, c.kitchen_item, 'Doro Wat', 420, 1, f.st_kitchen, 'Kitchen' from _f f, _ctx c;
insert into public.payments (restaurant_id, day_session_id, order_id, kind, amount, payment_method_id, method_name_snapshot, method_affects_drawer_snapshot, receipt_no)
  select f.a, f.day_id, c.order2, 'order_payment', 483, f.pm_cash, 'Cash', true, 'RCT-0001' from _f f, _ctx c;
insert into public.expenses (restaurant_id, expense_category_id, payment_method_id, amount, description)
  select a, exp_rent, pm_cash, 1000, 'rent' from _f;
update _ctx set kitchen_ing = (select id from public.ingredients where restaurant_id = (select a from _f) and name = 'Onion');

-- ═════════ deleting a row that has dependents fails with a dependency error (client path and service path) ═════════
select tests.authenticate_as((select admin from _f));
select matches(tests.run(format($q$delete from public.stations where id = %L$q$, (select st_kitchen from _f))),
               '^23503\|update or delete on table "stations" violates foreign key constraint', 'station with menu items / ingredients / order items cannot be deleted');
select matches(tests.run(format($q$delete from public.categories where id = %L$q$, (select cat_lunch from _f))),
               '^23503\|update or delete on table "categories" violates foreign key constraint', 'category with menu items cannot be deleted');
select matches(tests.run(format($q$delete from public.payment_methods where id = %L$q$, (select pm_cash from _f))),
               '^23503\|update or delete on table "payment_methods" violates foreign key constraint', 'payment method with payments / expenses cannot be deleted');
select matches(tests.run(format($q$delete from public.table_areas where id = %L$q$, (select area_main from _f))),
               '^23503\|update or delete on table "table_areas" violates foreign key constraint', 'table area with tables cannot be deleted');
select matches(tests.run(format($q$delete from public.expense_categories where id = %L$q$, (select exp_rent from _f))),
               '^23503\|update or delete on table "expense_categories" violates foreign key constraint', 'expense category with expenses cannot be deleted');
select matches(tests.run(format($q$select public.fn_delete_role(%L)$q$, (select cashier_role from _f))),
               '^P0001\|role_in_use\|users:', 'role with users cannot be deleted (structured error)');
select matches(tests.run(format($q$select public.fn_delete_role(%L)$q$, (select kitchen_role from _f))),
               '^P0001\|role_in_use\|users:', 'role with users + matrix rows cannot be deleted');
select is(tests.run(format($q$delete from public.stations where id = %L$q$, (select st_kitchen from _f))) , tests.run(format($q$delete from public.stations where id = %L$q$, (select st_kitchen from _f))), 'the dependency error is stable (idempotent)');
-- soft deactivation is the supported path
select is(tests.run(format($q$update public.stations set is_active = false where id = %L$q$, (select st_bar from _f))), 'ok:1', 'station with dependents can be deactivated');
select is(tests.run(format($q$update public.categories set is_active = false where id = %L$q$, (select cat_lunch from _f))), 'ok:1', 'category with dependents can be deactivated');
select is(tests.run(format($q$update public.payment_methods set is_active = false where id = %L$q$, (select pm_cash from _f))), 'ok:1', 'payment method with dependents can be deactivated');
select is(tests.run(format($q$update public.table_areas set is_active = false where id = %L$q$, (select area_main from _f))), 'ok:1', 'table area with dependents can be deactivated');
select is(tests.run(format($q$update public.expense_categories set is_active = false where id = %L$q$, (select exp_rent from _f))), 'ok:1', 'expense category with dependents can be deactivated');
select matches(tests.run(format($q$select public.fn_set_role_active(%L, false)$q$, (select cashier_role from _f))), '^P0001\|role_in_use\|active_users:',
               'a role held by active users cannot be deactivated (reassign or deactivate the users first)');
select tests.clear_auth();
select tests.authenticate_as_service_role();
select matches(tests.run(format($q$delete from public.stations where id = %L$q$, (select st_kitchen from _f))), '^23503\|', 'service_role is held to the same dependency rule (station)');
select matches(tests.run(format($q$delete from public.payment_methods where id = %L$q$, (select pm_cash from _f))), '^23503\|', 'service_role is held to the same dependency rule (payment method)');
select matches(tests.run(format($q$delete from public.roles where id = %L$q$, (select kitchen_role from _f))), '^23503\|', 'service_role is held to the same dependency rule (role)');
select tests.clear_auth();

-- ═════════ renaming keeps ids and history ═════════
select tests.authenticate_as((select admin from _f));
select is(tests.run(format($q$update public.stations set name = 'Hot Line' where id = %L$q$, (select st_kitchen from _f))), 'ok:1', 'rename a station');
select is(tests.run(format($q$update public.categories set name = 'Midday' where id = %L$q$, (select cat_lunch from _f))), 'ok:1', 'rename a category');
select is(tests.run(format($q$update public.payment_methods set name = 'Cash Drawer' where id = %L$q$, (select pm_cash from _f))), 'ok:1', 'rename a payment method');
select is(tests.run(format($q$update public.table_areas set name = 'Atrium' where id = %L$q$, (select area_main from _f))), 'ok:1', 'rename a table area');
select is(tests.run(format($q$update public.expense_categories set name = 'Premises' where id = %L$q$, (select exp_rent from _f))), 'ok:1', 'rename an expense category');
select is(tests.run(format($q$select public.fn_update_role(%L, '{"name": "Line Cook"}')$q$, (select kitchen_role from _f))), 'ok:1', 'rename a role');
select tests.clear_auth();
select is((select name from public.stations where id = (select st_kitchen from _f)), 'Hot Line', 'station keeps its id under a new name');
select is((select count(*)::int from public.menu_items where station_id = (select st_kitchen from _f)), 12, 'menu items still point at the renamed station (by id)');
select is((select station_name_snapshot from public.order_items where order_id = (select order2 from _ctx)), 'Kitchen', 'order item keeps the historical station name snapshot');
select is((select method_name_snapshot from public.payments where receipt_no = 'RCT-0001' and restaurant_id = (select a from _f)), 'Cash', 'payment keeps the historical method name snapshot');
select is((select method_name_snapshot from public.expenses where restaurant_id = (select a from _f) and description = 'rent'), 'Cash', 'expense keeps the historical method name snapshot');
select is((select count(*)::int from public.profiles where role_id = (select kitchen_role from _f)), 1, 'staff keep the renamed role');
select ok((select count(*) from public.role_permissions where role_id = (select kitchen_role from _f)) = 2, 'the renamed role keeps its permission matrix');
select ok(exists (select 1 from public.role_station_access where role_id = (select kitchen_role from _f) and station_id = (select st_kitchen from _f)), 'the renamed role keeps its station access');

-- ═════════ DB-level generalisation proof: names the code has never seen ═════════
select tests.authenticate_as((select admin from _f));
select is(tests.run(format($q$insert into public.stations (restaurant_id, name, color, icon) values (%L, 'Grill', '#ff5500', 'flame')$q$, (select a from _f))), 'ok:1', 'new station "Grill" is just a row');
select is(tests.run(format($q$insert into public.categories (restaurant_id, name) values (%L, 'Desserts')$q$, (select a from _f))), 'ok:1', 'new category "Desserts" is just a row');
select is(tests.run(format($q$insert into public.payment_methods (restaurant_id, name, requires_reference) values (%L, 'Amole', true)$q$, (select a from _f))), 'ok:1', 'new payment method "Amole" is just a row');
select is(tests.run(format($q$insert into public.table_areas (restaurant_id, name) values (%L, 'Rooftop')$q$, (select a from _f))), 'ok:1', 'new table area "Rooftop" is just a row');
select is(tests.run(format($q$insert into public.expense_categories (restaurant_id, name) values (%L, 'Fuel')$q$, (select a from _f))), 'ok:1', 'new expense category "Fuel" is just a row');
select is(tests.run($q$select public.fn_create_role('{"name": "Runner"}')$q$), 'ok:1', 'new role "Runner" is just a row');
select is(tests.run($q$select public.fn_create_role('{"name": "ሰራተኛ"}')$q$), 'ok:1', 'names are free text (Amharic script)');
select is(tests.run(format($q$insert into public.stations (restaurant_id, name) values (%L, ' GRILL ')$q$, (select a from _f))), '23505|duplicate key value violates unique constraint "stations_tenant_name_key"|', 'names are unique per tenant after normalisation');
update _ctx set grill = (select id from public.stations where restaurant_id = (select a from _f) and name = 'Grill'),
                desserts = (select id from public.categories where restaurant_id = (select a from _f) and name = 'Desserts'),
                amole = (select id from public.payment_methods where restaurant_id = (select a from _f) and name = 'Amole'),
                rooftop = (select id from public.table_areas where restaurant_id = (select a from _f) and name = 'Rooftop'),
                fuel = (select id from public.expense_categories where restaurant_id = (select a from _f) and name = 'Fuel'),
                runner = (select id from public.roles where restaurant_id = (select a from _f) and name = 'Runner');
select is(tests.run(format($q$select public.fn_update_role_permissions(%L, array['orders.view','inventory.view'], array[%L]::uuid[])$q$, (select runner from _ctx), (select grill from _ctx))),
          'ok:1', 'the matrix accepts the new role and the new station');
select is(tests.run(format($q$select public.fn_create_menu_item('Grilled Fish', %L, %L, 350)$q$, (select desserts from _ctx), (select grill from _ctx))),
          'ok:1', 'a menu item can live in the new category at the new station');
select is(tests.run(format($q$insert into public.table_areas (restaurant_id, name) values (%L, 'Hall 2')$q$, (select a from _f))), 'ok:1', 'more areas on demand');
select is(tests.run(format($q$insert into public.tables (restaurant_id, table_area_id, label) values (%L, %L, 'R01')$q$, (select a from _f), (select rooftop from _ctx))), 'ok:1', 'a table in the new area');
select is(tests.run(format($q$insert into public.expenses (restaurant_id, expense_category_id, payment_method_id, amount, description) values (%L, %L, %L, 80, 'diesel')$q$, (select a from _f), (select fuel from _ctx), (select amole from _ctx))),
          'ok:1', 'an expense in the new category paid with the new method');
select is((select method_name_snapshot from public.expenses where description = 'diesel'), 'Amole', 'the expense snapshots the new method name');
select is((select method_affects_drawer_snapshot from public.expenses where description = 'diesel'), false, 'cash-drawer behaviour is a data flag on the method row (Amole: off)');
select is(tests.run(format($q$select public.fn_create_ingredient('Charcoal', %L, 'kg')$q$, (select grill from _ctx))),
          'ok:1', 'an ingredient at the new station');
-- the admin gives the new role to an existing staff member (Kitchen -> Runner)
select is(tests.run(format($q$select public.fn_change_user_role(%L, %L)$q$, (select kitchen_user from _f), (select runner from _ctx))), 'ok:1', 'assign the brand-new role to a user');
select tests.clear_auth();

-- order with an item at the NEW station, created by someone else
insert into public.orders (restaurant_id, day_session_id, order_no, created_by, created_by_name_snapshot, subtotal, vat_rate_snapshot, vat_amount, total)
  select a, day_id, 'ORD-0001', waiter, 'Yonas Tesfaye', 350, 15, 52.5, 402.5 from _f;
update _ctx set order1 = (select id from public.orders where order_no = 'ORD-0001' and restaurant_id = (select a from _f)),
                fish = (select id from public.menu_items where name = 'Grilled Fish');
insert into public.order_items (restaurant_id, order_id, menu_item_id, name_snapshot, price_snapshot, qty, station_id, station_name_snapshot)
  select f.a, c.order1, c.fish, 'Grilled Fish', 350, 1, c.grill, 'Grill' from _f f, _ctx c;
update _ctx set grill_ing = (select id from public.ingredients where name = 'Charcoal');

select tests.authenticate_as((select kitchen_user from _f));
select ok(public.has_permission('orders.view') and public.has_permission('inventory.view'), 'Runner holds exactly the permissions the matrix gave it');
select ok(not public.has_permission('payments.create') and not public.has_permission('menu.manage') and not public.is_tenant_admin(), 'Runner holds nothing else');
select ok(public.has_station_access((select grill from _ctx)), 'has_station_access works for a station created a minute ago');
select ok(not public.has_station_access((select st_kitchen from _f)) and not public.has_station_access((select st_bar from _f)), 'Runner has no access to the other stations');
select is((select count(*)::int from public.order_items), 1, 'Runner sees only the item at its station');
select is((select item_status from public.order_items where station_id = (select grill from _ctx)), 'pending', 'ticket visible at the new station');
select is((select count(*)::int from public.orders), 1, 'Runner sees only the order that has an item at its station');
select is((select order_no from public.orders), 'ORD-0001', 'and it is the right order');
select is((select count(*)::int from public.ingredients), 1, 'stock visibility follows station access (Runner sees the Charcoal row only)');
select is((select name from public.ingredients), 'Charcoal', 'and it is the new-station ingredient');
select is(tests.run($q$update public.stations set name = 'x'$q$), 'ok:0', 'Runner cannot edit stations (no config.manage)');
select is((select count(*)::int from public.payments), 0, 'Runner cannot read payments');
select tests.clear_auth();

-- a second invented role with a different shape: sees every order but no station-only data
select tests.authenticate_as((select admin from _f));
select is(tests.run($q$select public.fn_create_role('{"name": "Floor Captain"}')$q$), 'ok:1', 'another invented role');
select is(tests.run(format($q$select public.fn_update_role_permissions((select id from public.roles where name = 'Floor Captain' and restaurant_id = %L), array['orders.view','orders.view_all','tables.view'], '{}')$q$, (select a from _f))),
          'ok:1', 'matrix: orders.view + orders.view_all, no stations');
select is(tests.run(format($q$select public.fn_change_user_role(%L, (select id from public.roles where name = 'Floor Captain' and restaurant_id = %L))$q$, (select kitchen_user from _f), (select a from _f))),
          'ok:1', 'reassign the user to the second invented role');
select tests.clear_auth();
select tests.authenticate_as((select kitchen_user from _f));
select is((select count(*)::int from public.orders), 2, 'Floor Captain (orders.view_all) sees every order');
select is((select count(*)::int from public.order_items), 2, 'orders.view_all also exposes the items of every order');
select is((select count(*)::int from public.ingredients), 0, 'and no stock');
select tests.clear_auth();

-- the role in use cannot now be deleted, but an unused one can once its matrix is cleared
select tests.authenticate_as((select admin from _f));
select matches(tests.run(format($q$select public.fn_delete_role((select id from public.roles where name = 'Floor Captain' and restaurant_id = %L))$q$, (select a from _f))),
               '^P0001\|role_in_use\|users:1', 'the role in use cannot be deleted');
select is(tests.run(format($q$select public.fn_delete_role(%L)$q$, (select runner from _ctx))), 'ok:1', 'an unused role (matrix and station rows included) can be deleted');
select is((select count(*)::int from public.role_permissions where role_id = (select runner from _ctx))
          + (select count(*)::int from public.role_station_access where role_id = (select runner from _ctx)), 0, 'its matrix and station rows went with it');
select is(tests.run(format($q$delete from public.stations where id = %L$q$, (select grill from _ctx))), '23503|update or delete on table "stations" violates foreign key constraint "menu_items_station_fk" on table "menu_items"|Key is still referenced from table "menu_items".', 'the new station is protected as soon as it has dependents');
select tests.clear_auth();

-- ═════════ names are scoped per tenant: B can use the very same names ═════════
select tests.authenticate_as((select b_admin from _f));
select is(tests.run(format($q$insert into public.stations (restaurant_id, name) values (%L, 'Grill')$q$, (select b from _f))), 'ok:1', 'tenant B creates its own "Grill" (no cross-tenant collision, no oracle on A''s names)');
select is(tests.run($q$select public.fn_create_role('{"name": "Runner"}')$q$), 'ok:1', 'tenant B creates its own "Runner"');
select is((select count(*)::int from public.stations where normalized_name = 'grill'), 1, 'B sees only its own Grill');
select tests.clear_auth();

select * from finish();
rollback;
