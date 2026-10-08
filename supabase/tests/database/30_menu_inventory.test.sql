-- Phase 3 (migration 0029): menu / recipe / ingredient / stock RPCs, the stock ledger, menu-image Storage policies.
-- Covers per RPC: happy path, permission denied, cross-tenant (not_found, no existence oracle), validation, replay/idempotency,
-- closed day, tenant status, audit rows, step-up, and the Phase-3 gate (menu item + recipe -> real stock math).
-- Review hardening (0029 edited in place): RPC-only writes, step-up on receive / initial stock / zero-cost quantity / cost edits,
-- per-tenant stock_stepup_threshold (fn_set_stock_stepup_threshold), keyset (created_at, id), case-sensitive Storage paths, rename
-- guard, overflow pre-check, recipe/reactivation locking, unit lock by recipe, idempotency key checked first, Phase-4 hooks deriving
-- the tenant from the order row, narrow duplicate_name mapping.
begin;
select plan(263);

create temp table _f on commit drop as
select tests.tenant_id('central-cafe') a, tests.tenant_id('second-cafe') b,
       tests.user_id('selam', 'central-cafe') a_admin, tests.user_id('yonas', 'central-cafe') a_waiter,
       tests.user_id('abebe', 'central-cafe') a_kitchen, tests.user_id('sara', 'central-cafe') a_pastry,
       tests.user_id('owner', 'second-cafe') b_admin, tests.user_id('waiter', 'second-cafe') b_waiter,
       tests.role_id('Kitchen', 'central-cafe') a_kitchen_role;
grant all on _f to public;
create temp table _n (k text primary key, v text);
grant all on _n to public;
create function tests.nv(p_k text) returns uuid language sql stable as $$ select v::uuid from _n where k = p_k $$;
create function tests.jv(p_k text) returns jsonb language sql stable as $$ select v::jsonb from _n where k = p_k $$;
create function tests.ev(p_rid uuid, p_event text) returns int language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.audit_logs a where a.restaurant_id = p_rid and a.event = p_event $$;
create function tests.ledger_gap(p_rid uuid) returns bigint language sql stable security definer set search_path = '' as $$
  -- ingredients whose on-hand differs from the ledger sum (must be 0)
  select count(*) from public.ingredients i
  where i.restaurant_id = p_rid and i.stock <> coalesce((select sum(m.qty_delta) from public.stock_movements m where m.ingredient_id = i.id), 0) $$;
create function tests.mov_count(p_ing uuid) returns int language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.stock_movements where ingredient_id = p_ing $$;
create function tests.stock_of(p_ing uuid) returns numeric language sql stable security definer set search_path = '' as $$
  select stock from public.ingredients where id = p_ing $$;
grant execute on all functions in schema tests to public;

-- fixtures (owner): ids of reference rows, uploaded images, an open day order, a foreign-tenant menu item and ingredient
insert into _n select 'a_cat', (select id::text from public.categories where restaurant_id = (select a from _f) and name = 'Lunch');
insert into _n select 'a_kit', (select id::text from public.stations where restaurant_id = (select a from _f) and name = 'Kitchen');
insert into _n select 'a_pas', (select id::text from public.stations where restaurant_id = (select a from _f) and name = 'Pastry');
insert into _n select 'b_cat', (select id::text from public.categories where restaurant_id = (select b from _f) and name = 'Lunch');
insert into _n select 'b_kit', (select id::text from public.stations where restaurant_id = (select b from _f) and name = 'Kitchen');
insert into _n select 'a_day', (select id::text from public.day_sessions where restaurant_id = (select a from _f) and status = 'open');
insert into storage.objects (bucket_id, name) select 'menu-images', 'restaurants/' || a || '/menu/burger.png' from _f;
insert into storage.objects (bucket_id, name) select 'menu-images', 'restaurants/' || b || '/menu/foreign.png' from _f;
-- an object whose path only differs in case from a valid one (only the owner / service could ever create it)
insert into storage.objects (bucket_id, name) select 'menu-images', 'RESTAURANTS/' || a || '/MENU/case.png' from _f;
insert into public.orders (restaurant_id, day_session_id, order_no, created_by, created_by_name_snapshot, subtotal, vat_rate_snapshot, vat_amount, total)
select a, tests.nv('a_day'), 'ORD-9001', a_waiter, 'Yonas Tesfaye', 100, 15, 15, 115 from _f;
insert into _n select 'a_order', (select id::text from public.orders where order_no = 'ORD-9001' and restaurant_id = (select a from _f));
insert into public.ingredients (restaurant_id, name, station_id, unit, stock, opening_stock) values ((select b from _f), 'B Rice', tests.nv('b_kit'), 'kg', 10, 10);
insert into public.stock_movements (restaurant_id, ingredient_id, station_id, qty_delta, reason, day_session_id)
select restaurant_id, id, station_id, 10, 'opening', (select id from public.day_sessions where restaurant_id = (select b from _f) and status = 'open')
from public.ingredients where name = 'B Rice';
insert into _n select 'b_ing', (select id::text from public.ingredients where restaurant_id = (select b from _f) and name = 'B Rice');
insert into _n select 'b_mov', (select id::text from public.stock_movements where ingredient_id = tests.nv('b_ing'));
insert into _n select 'b_menu', (select id::text from public.menu_items where restaurant_id = (select b from _f) limit 1);
create temp table _snap on commit drop as select tests.snapshot((select b from _f)) b;
grant all on _snap to public;

-- ═════════ structure and privileges ═════════
select is((select count(*)::int from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosecdef and p.proconfig @> array['search_path=""']
           and p.proname in ('fn_create_menu_item','fn_update_menu_item','fn_set_menu_item_active','fn_set_recipe','fn_create_ingredient','fn_update_ingredient',
                             'fn_set_ingredient_active','fn_receive_stock','fn_adjust_stock','fn_reverse_stock_movement','fn_list_stock_movements',
                             'fn_post_stock_movement','fn_apply_recipe_consumption','fn_reverse_order_consumption','fn_stock_day','fn_menu_check_refs',
                             'fn_menu_check_image','fn_menu_item_json','fn_ingredient_json','fn_check_idempotency_key','fn_stock_stepup_threshold',
                             'fn_stock_step_up','fn_set_stock_stepup_threshold')), 23, 'all 23 new functions: security definer with a pinned empty search_path');
select is((select string_agg(p.proname, ',' order by p.proname) from pg_proc p where p.pronamespace = 'public'::regnamespace
           and p.proname in ('fn_create_menu_item','fn_update_menu_item','fn_set_menu_item_active','fn_set_recipe','fn_create_ingredient','fn_update_ingredient',
                             'fn_set_ingredient_active','fn_receive_stock','fn_adjust_stock','fn_reverse_stock_movement','fn_list_stock_movements',
                             'fn_set_stock_stepup_threshold')
             and has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')
             and not has_function_privilege('public', p.oid, 'execute')),
          'fn_adjust_stock,fn_create_ingredient,fn_create_menu_item,fn_list_stock_movements,fn_receive_stock,fn_reverse_stock_movement,fn_set_ingredient_active,fn_set_menu_item_active,fn_set_recipe,fn_set_stock_stepup_threshold,fn_update_ingredient,fn_update_menu_item',
          'the 12 command / read RPCs: authenticated only (not anon, not PUBLIC)');
select is((select string_agg(p.proname, ',' order by p.proname) from pg_proc p where p.pronamespace = 'public'::regnamespace
           and p.proname in ('fn_post_stock_movement','fn_apply_recipe_consumption','fn_reverse_order_consumption','fn_stock_day','fn_menu_check_refs',
                             'fn_menu_check_image','fn_menu_item_json','fn_ingredient_json','fn_check_idempotency_key','fn_stock_stepup_threshold','fn_stock_step_up')
             and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute')
                  or has_function_privilege('service_role', p.oid, 'execute'))), null, 'internal helpers (ledger writer, consumption, json) have no client EXECUTE');
select is((select file_size_limit::text || ':' || public::text || ':' || array_to_string(allowed_mime_types, ',') from storage.buckets where id = 'menu-images'),
          '2097152:false:image/png,image/jpeg,image/webp', 'bucket menu-images: private, 2 MiB, png/jpeg/webp only');
select is((select string_agg(cmd, ',' order by cmd) from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'menu_images_%'),
          'DELETE,INSERT,SELECT,UPDATE', 'storage.objects: one menu_images policy per verb');
select ok(not exists (select 1 from pg_policies where schemaname = 'storage' and policyname like 'menu_images_%' and (qual ~ '^\(?true\)?$' or with_check ~ '^\(?true\)?$')),
          'storage policies are never USING (true)');
select ok(not has_column_privilege('authenticated', 'public.ingredients', 'stock', 'update')
      and not has_column_privilege('authenticated', 'public.ingredients', 'stock', 'insert')
      and not has_table_privilege('authenticated', 'public.stock_movements', 'insert,update,delete'), 'clients cannot write stock / the ledger directly');
select is((select string_agg(t || ':' || p, ',' order by t, p) from unnest(array['menu_items', 'recipe_lines', 'ingredients']) t, unnest(array['insert', 'update', 'delete']) p
           where case when p = 'delete' then has_table_privilege('authenticated', ('public.' || t)::regclass, p)
                      else has_any_column_privilege('authenticated', ('public.' || t)::regclass, p) end),
          null, 'menu_items / recipe_lines / ingredients: no client INSERT / UPDATE / DELETE (table or column level); the RPCs are the only write path');
select ok(has_table_privilege('authenticated', 'public.menu_items', 'select') and has_table_privilege('authenticated', 'public.recipe_lines', 'select')
      and has_table_privilege('authenticated', 'public.ingredients', 'select'), '... SELECT (under RLS) stays');
select ok((select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('fn_set_recipe', 'fn_set_menu_item_active')
           and pg_get_functiondef(p.oid) ~* 'for share') = 2, 'fn_set_recipe and fn_set_menu_item_active take FOR SHARE locks on the recipe ingredients');

-- ═════════ menu items ═════════
select tests.authenticate_as((select a_waiter from _f));
select is(tests.run(format($q$select public.fn_create_menu_item('Nope', %L, %L, 10)$q$, tests.nv('a_cat'), tests.nv('a_kit'))), 'P0001|permission_denied|', 'create menu item: waiter (no menu.manage) denied');
select is(tests.run(format($q$select public.fn_update_menu_item(%L, '{"price": 1}')$q$, gen_random_uuid())), 'P0001|permission_denied|', 'update menu item: waiter denied (before any lookup)');
select is(tests.run(format($q$select public.fn_set_menu_item_active(%L, false)$q$, gen_random_uuid())), 'P0001|permission_denied|', 'set active: waiter denied');
select is(tests.run(format($q$select public.fn_set_recipe(%L, '[]')$q$, gen_random_uuid())), 'P0001|permission_denied|', 'set recipe: waiter denied');
select tests.clear_auth();

select tests.authenticate_as((select a_admin from _f));
insert into _n select 'burger', (public.fn_create_menu_item('  Gate Burger ', tests.nv('a_cat'), tests.nv('a_kit'), 120.50, 'Test item', 'B', 'restaurants/' || (select a from _f) || '/menu/burger.png', 5) ->> 'id');
select is((select m.name || '|' || m.price || '|' || m.restaurant_id::text || '|' || m.image_path from public.menu_items m where m.id = tests.nv('burger')),
          'Gate Burger|120.50|' || (select a from _f) || '|restaurants/' || (select a from _f) || '/menu/burger.png', 'admin creates a menu item: trimmed name, server tenant, price numeric');
select is(tests.ev((select a from _f), 'menu.item_created'), 1, 'create: audit event written');
select is(tests.run(format($q$select public.fn_create_menu_item('gate  BURGER', %L, %L, 10)$q$, tests.nv('a_cat'), tests.nv('a_kit'))), 'P0001|duplicate_name|name', 'create: duplicate name (normalised) -> duplicate_name');
select is(tests.run(format($q$select public.fn_create_menu_item('', %L, %L, 10)$q$, tests.nv('a_cat'), tests.nv('a_kit'))), 'P0001|invalid_input|name', 'create: empty name');
select is(tests.run(format($q$select public.fn_create_menu_item('X1', %L, %L, -1)$q$, tests.nv('a_cat'), tests.nv('a_kit'))), 'P0001|invalid_input|price', 'create: negative price');
select is(tests.run(format($q$select public.fn_create_menu_item('X2', %L, %L, 1.234)$q$, tests.nv('a_cat'), tests.nv('a_kit'))), 'P0001|invalid_input|price', 'create: price with 3 decimals refused (no silent rounding)');
select is(tests.run(format($q$select public.fn_create_menu_item('X3', %L, %L, null)$q$, tests.nv('a_cat'), tests.nv('a_kit'))), 'P0001|invalid_input|price', 'create: null price');
select is(tests.run(format($q$select public.fn_create_menu_item('X4', %L, %L, 10)$q$, tests.nv('b_cat'), tests.nv('a_kit'))), 'P0001|invalid_input|category_id', 'create: foreign-tenant category refused');
select is(tests.run(format($q$select public.fn_create_menu_item('X5', %L, %L, 10)$q$, tests.nv('a_cat'), tests.nv('b_kit'))), 'P0001|invalid_station|', 'create: foreign-tenant station refused');
select is(tests.run(format($q$select public.fn_create_menu_item('X6', %L, %L, 10)$q$, gen_random_uuid(), tests.nv('a_kit'))), 'P0001|invalid_input|category_id', 'create: unknown category = same answer as foreign');
select is(tests.run(format($q$select public.fn_create_menu_item('X7', %L, %L, 10, null, null, %L)$q$, tests.nv('a_cat'), tests.nv('a_kit'), 'restaurants/' || (select b from _f) || '/menu/foreign.png')),
          'P0001|invalid_input|image_path', 'create: image path under another tenant prefix refused');
select is(tests.run(format($q$select public.fn_create_menu_item('X8', %L, %L, 10, null, null, %L)$q$, tests.nv('a_cat'), tests.nv('a_kit'), 'restaurants/' || (select a from _f) || '/menu/../../x.png')),
          'P0001|invalid_input|image_path', 'create: path traversal refused');
select is(tests.run(format($q$select public.fn_create_menu_item('X9', %L, %L, 10, null, null, %L)$q$, tests.nv('a_cat'), tests.nv('a_kit'), 'restaurants/' || (select a from _f) || '/menu/not-uploaded.png')),
          'P0001|invalid_input|image_path', 'create: path to an object that was never uploaded refused');
select is(tests.run(format($q$select public.fn_create_menu_item('X10', %L, %L, 10, null, null, %L)$q$, tests.nv('a_cat'), tests.nv('a_kit'), 'https://evil.example/x.png')),
          'P0001|invalid_input|image_path', 'create: URL instead of a storage path refused');
select is(tests.run(format($q$select public.fn_create_menu_item('X11', %L, %L, 10, null, null, %L)$q$, tests.nv('a_cat'), tests.nv('a_kit'), 'RESTAURANTS/' || (select a from _f) || '/MENU/case.png')),
          'P0001|invalid_input|image_path', 'create: case-variant prefix refused although such an object exists (path check is case-sensitive)');
-- no rows were created by any refused call
select is((select count(*)::int from public.menu_items where restaurant_id = (select a from _f) and name like 'X%'), 0, 'refused creates left no rows');

select is((public.fn_update_menu_item(tests.nv('burger'), '{"price": 99.99, "description": null, "name": "Gate Burger 2"}') ->> 'price'), '99.99', 'update: price patched');
select is((select m.name || '|' || coalesce(m.description, 'NULL') from public.menu_items m where m.id = tests.nv('burger')), 'Gate Burger 2|NULL', 'update: name changed, description cleared with null');
select is(tests.ev((select a from _f), 'menu.item_updated'), 1, 'update: audit event');
select public.fn_update_menu_item(tests.nv('burger'), '{"price": 99.99}');
select is(tests.ev((select a from _f), 'menu.item_updated'), 1, 'update: a no-op writes no second audit event');
select is(tests.run(format($q$select public.fn_update_menu_item(%L, '{"is_active": false}')$q$, tests.nv('burger'))), 'P0001|invalid_input|patch', 'update: unknown / non-patchable key (is_active, restaurant_id...) refused');
select is(tests.run(format($q$select public.fn_update_menu_item(%L, '{"restaurant_id": "%s"}')$q$, tests.nv('burger'), (select b from _f))), 'P0001|invalid_input|patch', 'update: restaurant_id in the patch refused');
select is(tests.run(format($q$select public.fn_update_menu_item(%L, '{"price": "12"}')$q$, tests.nv('burger'))), 'P0001|invalid_input|price', 'update: price must be a JSON number');
select is(tests.run(format($q$select public.fn_update_menu_item(%L, '{"station_id": "%s"}')$q$, tests.nv('burger'), tests.nv('b_kit'))), 'P0001|invalid_station|', 'update: foreign station refused');
select is(tests.run(format($q$select public.fn_update_menu_item(%L, '{"category_id": "%s"}')$q$, tests.nv('burger'), tests.nv('b_cat'))), 'P0001|invalid_input|category_id', 'update: foreign category refused');
select is(tests.run(format($q$select public.fn_update_menu_item(%L, '{"image_path": "restaurants/%s/menu/foreign.png"}')$q$, tests.nv('burger'), (select b from _f))), 'P0001|invalid_input|image_path', 'update: foreign image path refused');
select is(tests.run(format($q$select public.fn_update_menu_item(%L, '{}')$q$, tests.nv('burger'))), 'P0001|invalid_input|patch', 'update: empty patch refused');
select is(tests.oracle($q$select public.fn_update_menu_item({id}, '{"price": 1}')$q$, tests.nv('b_menu')), 'P0001|not_found|', 'update: other tenant menu item = unknown id (no existence oracle)');
select is(tests.oracle($q$select public.fn_set_menu_item_active({id}, false)$q$, tests.nv('b_menu')), 'P0001|not_found|', 'set active: other tenant menu item = not_found');
select is((public.fn_set_menu_item_active(tests.nv('burger'), false) ->> 'is_active'), 'false', 'deactivate menu item (row kept, soft)');
select is(tests.ev((select a from _f), 'menu.item_active_changed'), 1, 'deactivate: audit event');
select is((public.fn_set_menu_item_active(tests.nv('burger'), true) ->> 'is_active'), 'true', 'reactivate menu item');
select tests.clear_auth();
select is((select count(*)::int from public.menu_items where id = tests.nv('b_menu') and is_active), 1, 'tenant B menu item untouched by the A admin');

-- plan limit (owner raises / lowers the cap)
update public.plans set max_menu_items = (select count(*) from public.menu_items where restaurant_id = (select a from _f) and is_active)
 where id = (select plan_id from public.subscriptions where restaurant_id = (select a from _f));
select tests.authenticate_as((select a_admin from _f));
select is(tests.run(format($q$select public.fn_create_menu_item('Over Limit', %L, %L, 10)$q$, tests.nv('a_cat'), tests.nv('a_kit'))), 'P0001|plan_limit_reached|menu_items', 'create: plan max_menu_items enforced');
select tests.clear_auth();
update public.plans set max_menu_items = null where id = (select plan_id from public.subscriptions where restaurant_id = (select a from _f));

-- unique_violation -> duplicate_name ONLY for the name key: an extra (test-only) unique index must surface as a generic conflict
create unique index _t_menu_sort_uq on public.menu_items (restaurant_id, sort_order) where sort_order = 424242;
create unique index _t_ing_min_uq on public.ingredients (restaurant_id, min_level) where min_level = 4242;
select tests.authenticate_as((select a_admin from _f));
select is(tests.run(format($q$select public.fn_create_menu_item('Sort One', %L, %L, 10, null, null, null, 424242)$q$, tests.nv('a_cat'), tests.nv('a_kit'))), 'ok:1', 'unique narrowing: first row with the test key');
select is(tests.run(format($q$select public.fn_create_menu_item('Sort Two', %L, %L, 10, null, null, null, 424242)$q$, tests.nv('a_cat'), tests.nv('a_kit'))),
          'P0001|invalid_state|unique_conflict', 'menu item: a non-name unique violation is NOT reported as duplicate_name');
select is(tests.run(format($q$select public.fn_update_menu_item(%L, '{"sort_order": 424242}')$q$, tests.nv('burger'))),
          'P0001|invalid_state|unique_conflict', 'update menu item: same narrowing');
select is(tests.run(format($q$select public.fn_create_ingredient('Min One', %L, 'kg', 4242)$q$, tests.nv('a_kit'))), 'ok:1', 'unique narrowing: first ingredient with the test key');
select is(tests.run(format($q$select public.fn_create_ingredient('Min Two', %L, 'kg', 4242)$q$, tests.nv('a_kit'))),
          'P0001|invalid_state|unique_conflict', 'ingredient: a non-name unique violation is NOT reported as duplicate_name');
select tests.clear_auth();
drop index public._t_menu_sort_uq;
drop index public._t_ing_min_uq;

-- ═════════ ingredients ═════════
select tests.authenticate_as((select a_waiter from _f));
select is(tests.run(format($q$select public.fn_create_ingredient('Nope', %L, 'kg')$q$, tests.nv('a_kit'))), 'P0001|permission_denied|', 'create ingredient: waiter denied');
select is(tests.run(format($q$select public.fn_update_ingredient(%L, '{"min_level": 1}')$q$, tests.nv('b_ing'))), 'P0001|permission_denied|', 'update ingredient: waiter denied');
select is(tests.run(format($q$select public.fn_set_ingredient_active(%L, false)$q$, tests.nv('b_ing'))), 'P0001|permission_denied|', 'set ingredient active: waiter denied');
select tests.clear_auth();

select tests.authenticate_as((select a_admin from _f));
insert into _n select 'flour', (public.fn_create_ingredient('Gate Flour', tests.nv('a_kit'), 'kg', 5, 100) ->> 'id');
insert into _n select 'beef', (public.fn_create_ingredient('Gate Beef', tests.nv('a_kit'), 'kg', 2, 10, 50.5) ->> 'id');
insert into _n select 'sugar', (public.fn_create_ingredient('Gate Sugar', tests.nv('a_pas'), 'kg', 0, 0, 10) ->> 'id');
select is(tests.stock_of(tests.nv('flour')), 0.000, 'create ingredient without initial stock: on-hand 0, no ledger row');
select is(tests.mov_count(tests.nv('flour')), 0, '... and no movement');
select is(tests.stock_of(tests.nv('beef')) || '|' || tests.mov_count(tests.nv('beef')), '50.500|1', 'create ingredient with initial stock: opening movement, on-hand 50.5');
select is((select reason || '|' || qty_delta || '|' || day_session_id::text from public.stock_movements where ingredient_id = tests.nv('beef')), 'opening|50.500|' || tests.nv('a_day')::text, 'opening row bound to the open business day');
select is(tests.ev((select a from _f), 'inventory.ingredient_created'), 4, 'create ingredient: audit events (3 here + Min One of the unique-narrowing check)');
select is(tests.run(format($q$select public.fn_create_ingredient('gate flour', %L, 'kg')$q$, tests.nv('a_kit'))), 'P0001|duplicate_name|name', 'create ingredient: duplicate name');
select is(tests.run(format($q$select public.fn_create_ingredient('Bad Unit', %L, 'lb')$q$, tests.nv('a_kit'))), 'P0001|invalid_input|unit', 'create ingredient: unit outside the allowed set');
select is(tests.run(format($q$select public.fn_create_ingredient('Neg', %L, 'kg', -1)$q$, tests.nv('a_kit'))), 'P0001|invalid_input|min_level', 'create ingredient: negative min_level');
select is(tests.run(format($q$select public.fn_create_ingredient('Neg2', %L, 'kg', 0, 0, -5)$q$, tests.nv('a_kit'))), 'P0001|invalid_input|initial_stock', 'create ingredient: negative initial stock');
select is(tests.run(format($q$select public.fn_create_ingredient('Foreign', %L, 'kg')$q$, tests.nv('b_kit'))), 'P0001|invalid_station|', 'create ingredient: foreign station refused');
select is(tests.run(format($q$select public.fn_update_ingredient(%L, '{"stock": 999}')$q$, tests.nv('flour'))), 'P0001|invalid_input|patch', 'update ingredient: stock is not patchable');
select is((public.fn_update_ingredient(tests.nv('flour'), '{"min_level": 7, "cost_per_unit": 100, "name": "Gate Flour"}') ->> 'min_level'), '7.000', 'update ingredient: min_level patched');
select is(tests.run(format($q$select public.fn_update_ingredient(%L, '{"unit": "g"}')$q$, tests.nv('beef'))), 'P0001|invalid_state|unit_locked', 'update ingredient: unit locked once movements exist');
select is((public.fn_update_ingredient(tests.nv('flour'), '{"unit": "g"}') ->> 'unit'), 'g', 'update ingredient: unit may change while no movement exists');
select public.fn_update_ingredient(tests.nv('flour'), '{"unit": "kg"}');
select is(tests.run(format($q$select public.fn_update_ingredient(%L, '{"station_id": "%s"}')$q$, tests.nv('flour'), tests.nv('b_kit'))), 'P0001|invalid_station|', 'update ingredient: foreign station refused');
select is(tests.oracle($q$select public.fn_update_ingredient({id}, '{"min_level": 1}')$q$, tests.nv('b_ing')), 'P0001|not_found|', 'update ingredient: other tenant id = unknown id');
select is(tests.oracle($q$select public.fn_set_ingredient_active({id}, false)$q$, tests.nv('b_ing')), 'P0001|not_found|', 'set ingredient active: other tenant id = not_found');

-- ═════════ recipes ═════════
select is(tests.run(format($q$select public.fn_set_recipe(%L, '[{"ingredient_id": "%s", "qty_per_serving": 0.2}, {"ingredient_id": "%s", "qty_per_serving": 0.15}]')$q$,
                           tests.nv('burger'), tests.nv('flour'), tests.nv('beef'))), 'ok:1', 'set recipe: 2 lines');
select is((select string_agg(qty_per_serving::text, ',' order by qty_per_serving) from public.recipe_lines where menu_item_id = tests.nv('burger')), '0.150,0.200', 'recipe stored with numeric(12,3) quantities');
select is(tests.ev((select a from _f), 'menu.recipe_set'), 1, 'set recipe: audit event');
select public.fn_set_recipe(tests.nv('burger'), format('[{"ingredient_id": "%s", "qty_per_serving": 0.2}, {"ingredient_id": "%s", "qty_per_serving": 0.15}]', tests.nv('flour'), tests.nv('beef'))::jsonb);
select is(tests.ev((select a from _f), 'menu.recipe_set'), 1, 'set recipe: identical replay writes no new audit event');
select public.fn_set_recipe(tests.nv('burger'), format('[{"ingredient_id": "%s", "qty_per_serving": 0.25}]', tests.nv('flour'))::jsonb);
select is((select count(*)::int || '|' || min(qty_per_serving)::text from public.recipe_lines where menu_item_id = tests.nv('burger')), '1|0.250', 'set recipe: replace = removed line deleted, kept line updated');
select is(tests.run(format($q$select public.fn_set_recipe(%L, '[{"ingredient_id": "%s", "qty_per_serving": 0}]')$q$, tests.nv('burger'), tests.nv('flour'))), 'P0001|invalid_input|qty_per_serving', 'recipe: zero quantity refused');
select is(tests.run(format($q$select public.fn_set_recipe(%L, '[{"ingredient_id": "%s", "qty_per_serving": 0.0001}]')$q$, tests.nv('burger'), tests.nv('flour'))), 'P0001|invalid_input|qty_per_serving', 'recipe: 4 decimals refused');
select is(tests.run(format($q$select public.fn_set_recipe(%L, '[{"ingredient_id": "%s", "qty_per_serving": -1}]')$q$, tests.nv('burger'), tests.nv('flour'))), 'P0001|invalid_input|qty_per_serving', 'recipe: negative quantity refused');
select is(tests.run(format($q$select public.fn_set_recipe(%L, '[{"ingredient_id": "%s", "qty_per_serving": 1}, {"ingredient_id": "%s", "qty_per_serving": 2}]')$q$, tests.nv('burger'), tests.nv('flour'), tests.nv('flour'))), 'P0001|invalid_input|duplicate_ingredient', 'recipe: duplicate ingredient refused');
select is(tests.run(format($q$select public.fn_set_recipe(%L, '[{"ingredient_id": "%s", "qty_per_serving": 1}]')$q$, tests.nv('burger'), tests.nv('b_ing'))), 'P0001|invalid_input|ingredient_id', 'recipe: foreign-tenant ingredient refused');
select is(tests.run(format($q$select public.fn_set_recipe(%L, '[{"ingredient_id": "%s", "qty_per_serving": 1}]')$q$, tests.nv('burger'), gen_random_uuid())), 'P0001|invalid_input|ingredient_id', 'recipe: unknown ingredient = same answer');
select is(tests.run(format($q$select public.fn_set_recipe(%L, '{"a": 1}')$q$, tests.nv('burger'))), 'P0001|invalid_input|lines', 'recipe: lines must be an array');
select is(tests.run(format($q$select public.fn_set_recipe(%L, '[{"qty_per_serving": 1}]')$q$, tests.nv('burger'))), 'P0001|invalid_input|lines', 'recipe: line without ingredient_id refused');
select is(tests.oracle(format($q$select public.fn_set_recipe({id}, '[{"ingredient_id": "%s", "qty_per_serving": 1}]')$q$, tests.nv('flour')), tests.nv('b_menu')), 'P0001|not_found|', 'recipe: other tenant menu item = not_found');
select is((select count(*)::int from public.recipe_lines where menu_item_id = tests.nv('burger')), 1, 'refused recipe calls changed nothing (still 1 line)');
-- deactivation blocked by an active recipe
select is(tests.run(format($q$select public.fn_set_ingredient_active(%L, false)$q$, tests.nv('flour'))), 'P0001|invalid_state|ingredient_in_active_recipe', 'ingredient used by an active menu item recipe cannot be deactivated (explained)');
select is((public.fn_set_ingredient_active(tests.nv('sugar'), false) ->> 'is_active'), 'false', 'unused ingredient deactivates (soft)');
select is(tests.run(format($q$select public.fn_set_recipe(%L, '[{"ingredient_id": "%s", "qty_per_serving": 1}]')$q$, tests.nv('burger'), tests.nv('sugar'))), 'P0001|invalid_input|ingredient_id', 'recipe: inactive ingredient refused');
select public.fn_set_ingredient_active(tests.nv('sugar'), true);
-- unit lock by recipe (no movement yet) and reactivation of a menu item whose recipe uses a deactivated ingredient
insert into _n select 'cake', (public.fn_create_menu_item('Gate Cake', tests.nv('a_cat'), tests.nv('a_pas'), 50) ->> 'id');
insert into _n select 'salt', (public.fn_create_ingredient('Gate Salt', tests.nv('a_kit'), 'kg') ->> 'id');
select public.fn_set_recipe(tests.nv('cake'), format('[{"ingredient_id": "%s", "qty_per_serving": 0.1}, {"ingredient_id": "%s", "qty_per_serving": 0.01}]', tests.nv('sugar'), tests.nv('salt'))::jsonb);
select is(tests.mov_count(tests.nv('salt')), 0, 'salt has no movement ...');
select is(tests.run(format($q$select public.fn_update_ingredient(%L, '{"unit": "g"}')$q$, tests.nv('salt'))), 'P0001|invalid_state|unit_locked', '... but a recipe uses it: unit locked (recipe quantities are in that unit)');
select is((public.fn_set_menu_item_active(tests.nv('cake'), false) ->> 'is_active'), 'false', 'cake taken off sale');
select is((public.fn_set_ingredient_active(tests.nv('sugar'), false) ->> 'is_active'), 'false', 'sugar may now be deactivated (only an INACTIVE item uses it)');
select is(tests.run(format($q$select public.fn_set_menu_item_active(%L, true)$q$, tests.nv('cake'))), 'P0001|invalid_state|ingredient_inactive', 'reactivating the cake re-checks its recipe: inactive ingredient refused');
select is((select is_active from public.menu_items where id = tests.nv('cake')), false, '... and the cake stays inactive');
select public.fn_set_ingredient_active(tests.nv('sugar'), true);
select is((public.fn_set_menu_item_active(tests.nv('cake'), true) ->> 'is_active'), 'true', 'with the ingredient active again the cake can be reactivated');
select tests.clear_auth();

-- ═════════ stock: visibility first (before the Kitchen role is granted receive) ═════════
select tests.authenticate_as((select a_kitchen from _f));
select is(tests.run($q$select public.fn_list_stock_movements()$q$), 'ok:1', 'list movements: inventory.view holder may read');
select is(jsonb_array_length(public.fn_list_stock_movements(tests.nv('beef'))), 1, 'kitchen (station access only) sees the Kitchen-station ingredient movements (beef opening)');
select is(jsonb_array_length(public.fn_list_stock_movements(tests.nv('sugar'))), 0, 'kitchen does not see Pastry-station movements');
select is((select count(*)::int from jsonb_array_elements(public.fn_list_stock_movements(null, 200)) e where e ->> 'station_id' <> tests.nv('a_kit')::text), 0, 'kitchen: the unfiltered log contains Kitchen-station rows only');
select is(tests.run(format($q$select public.fn_receive_stock(%L, 5, 'key-kitchen-denied-1')$q$, tests.nv('flour'))), 'P0001|permission_denied|', 'receive: inventory.view alone is not enough');
select is(tests.run(format($q$select public.fn_adjust_stock(%L, -1, 'attempt', 'key-kitchen-denied-2')$q$, tests.nv('flour'))), 'P0001|permission_denied|', 'adjust: inventory.view alone is not enough');
select tests.clear_auth();
select tests.authenticate_as((select a_pastry from _f));
select is(jsonb_array_length(public.fn_list_stock_movements(tests.nv('beef'))), 0, 'pastry sees no Kitchen movements');
select is(jsonb_array_length(public.fn_list_stock_movements(tests.nv('sugar'))), 1, 'pastry sees its own station movements (sugar opening)');
select tests.clear_auth();
select tests.authenticate_as((select a_waiter from _f));
select is(tests.run($q$select public.fn_list_stock_movements()$q$), 'P0001|permission_denied|', 'list movements: waiter (no inventory.view) denied');
select tests.clear_auth();

-- ═════════ stock receive ═════════
select tests.authenticate_as((select a_admin from _f));
select is((public.fn_receive_stock(tests.nv('flour'), 100, 'key-receive-0001', 'delivery #1') ->> 'stock'), '100.000', 'receive 100: on-hand 100');
select is((select reason || '|' || qty_delta || '|' || note || '|' || created_by::text from public.stock_movements where ingredient_id = tests.nv('flour')),
          'received|100.000|delivery #1|' || (select a_admin from _f)::text, 'receive: one ledger row, actor from the session');
select is((select received_today from public.ingredients where id = tests.nv('flour')), 100.000, 'receive: received_today counter follows');
select is(tests.ev((select a from _f), 'inventory.stock_received'), 1, 'receive: audit event');
select is((public.fn_receive_stock(tests.nv('flour'), 100, 'key-receive-0001', 'delivery #1') ->> 'stock'), '100.000', 'replay with the same key returns the stored result');
select is(tests.mov_count(tests.nv('flour')), 1, '... and writes no second movement');
select is(tests.stock_of(tests.nv('flour')), 100.000, '... and does not double the stock');
select is(tests.ev((select a from _f), 'inventory.stock_received'), 1, '... nor a second audit event');
select is(tests.run(format($q$select public.fn_receive_stock(%L, 7, 'key-receive-0001', 'delivery #1')$q$, tests.nv('flour'))), 'P0001|idempotency_conflict|', 'same key, different payload -> idempotency_conflict');
select is(tests.run(format($q$select public.fn_receive_stock(%L, 5, 'short')$q$, tests.nv('flour'))), 'P0001|invalid_input|idempotency_key', 'receive: key shorter than 8 chars refused');
select is(tests.run(format($q$select public.fn_receive_stock(%L, 5, null)$q$, tests.nv('flour'))), 'P0001|invalid_input|idempotency_key', 'receive: missing key refused');
select is(tests.run(format($q$select public.fn_receive_stock(%L, 5, 'short')$q$, tests.nv('b_ing'))), 'P0001|invalid_input|idempotency_key', 'receive: the key is validated BEFORE the ingredient lookup / lock (foreign id: still the key error)');
select is(tests.run(format($q$select public.fn_adjust_stock(%L, -1, 'any reason', 'short')$q$, gen_random_uuid())), 'P0001|invalid_input|idempotency_key', 'adjust: key validated before the lookup');
select is(tests.run(format($q$select public.fn_reverse_stock_movement(%L, 'any reason', null)$q$, gen_random_uuid())), 'P0001|invalid_input|idempotency_key', 'reverse: key validated before the lookup');
select is(tests.run(format($q$select public.fn_receive_stock(%L, 0, 'key-receive-0002')$q$, tests.nv('flour'))), 'P0001|invalid_input|qty', 'receive: zero qty');
select is(tests.run(format($q$select public.fn_receive_stock(%L, -5, 'key-receive-0003')$q$, tests.nv('flour'))), 'P0001|invalid_input|qty', 'receive: negative qty (use adjust)');
select is(tests.run(format($q$select public.fn_receive_stock(%L, 1.2345, 'key-receive-0004')$q$, tests.nv('flour'))), 'P0001|invalid_input|qty', 'receive: 4 decimals refused');
select is(tests.oracle($q$select public.fn_receive_stock({id}, 5, 'key-receive-0005')$q$, tests.nv('b_ing')), 'P0001|not_found|', 'receive: other tenant ingredient = unknown id');
select is(tests.stock_of(tests.nv('flour')), 100.000, 'refused receives changed nothing');
select tests.clear_auth();
select is(tests.snapshot((select b from _f)), (select b from _snap), 'tenant B data byte-for-byte unchanged after every A admin attack so far');

-- a second tenant's key space is separate: B's admin may reuse A's key text on its own ingredient
select tests.authenticate_as((select b_admin from _f));
select is((public.fn_receive_stock(tests.nv('b_ing'), 3, 'key-receive-0001') ->> 'stock') is not null, true, 'idempotency keys are tenant-scoped: same key text works in tenant B');
select is(tests.oracle($q$select public.fn_receive_stock({id}, 1, 'key-receive-0006')$q$, tests.nv('flour')), 'P0001|not_found|', 'B admin cannot receive into A ingredient (IDOR): not_found');
select is(tests.oracle($q$select public.fn_adjust_stock({id}, -1, 'reason here', 'key-adjust-b-0001')$q$, tests.nv('flour')), 'P0001|not_found|', 'B admin cannot adjust A ingredient: not_found');
select is(jsonb_array_length(public.fn_list_stock_movements(tests.nv('flour'))), 0, 'B admin: movement log filtered to an A ingredient is empty');
select tests.clear_auth();
select is(tests.stock_of(tests.nv('flour')), 100.000, 'A ingredient unchanged by tenant B');

-- receive permission alone (Kitchen role is granted inventory.receive by the owner)
insert into public.role_permissions (role_id, permission_id, restaurant_id)
select (select a_kitchen_role from _f), pm.id, (select a from _f) from public.permissions pm where pm.key = 'inventory.receive';
select tests.authenticate_as((select a_kitchen from _f));
select is((public.fn_receive_stock(tests.nv('beef'), 4.5, 'key-kitchen-recv-1') ->> 'stock'), '55.000', 'receive: holder of inventory.receive (not adjust) may receive');
select is(tests.run(format($q$select public.fn_adjust_stock(%L, -1, 'attempt', 'key-kitchen-denied-3')$q$, tests.nv('beef'))), 'P0001|permission_denied|', 'adjust still denied without inventory.adjust');
select tests.clear_auth();

-- ═════════ stock adjust ═════════
select tests.authenticate_as((select a_admin from _f));
select is((public.fn_adjust_stock(tests.nv('flour'), -30, 'spillage', 'key-adjust-0001') ->> 'stock'), '70.000', 'adjust -30 with a reason: on-hand 70');
select is((select reason || '|' || note from public.stock_movements where ingredient_id = tests.nv('flour') and qty_delta = -30), 'manual_adjustment|spillage', 'adjust: ledger row carries reason text');
select is((select consumed_today from public.ingredients where id = tests.nv('flour')), 0.000, 'adjust does not count as consumption');
select is(tests.ev((select a from _f), 'inventory.stock_adjusted'), 1, 'adjust: audit event');
select public.fn_adjust_stock(tests.nv('flour'), -30, 'spillage', 'key-adjust-0001');
select is(tests.stock_of(tests.nv('flour')), 70.000, 'adjust replay: no second deduction');
select is(tests.run(format($q$select public.fn_adjust_stock(%L, -1, '', 'key-adjust-0002')$q$, tests.nv('flour'))), 'P0001|invalid_input|reason', 'adjust: reason required (empty)');
select is(tests.run(format($q$select public.fn_adjust_stock(%L, -1, null, 'key-adjust-0003')$q$, tests.nv('flour'))), 'P0001|invalid_input|reason', 'adjust: reason required (null)');
select is(tests.run(format($q$select public.fn_adjust_stock(%L, 0, 'zero delta', 'key-adjust-0004')$q$, tests.nv('flour'))), 'P0001|invalid_input|qty_delta', 'adjust: zero delta refused');
select is(tests.run(format($q$select public.fn_adjust_stock(%L, -1000, 'way too much', 'key-adjust-0005')$q$, tests.nv('flour'))), 'P0001|insufficient_stock|Gate Flour', 'adjust below zero -> insufficient_stock (own ingredient name only)');
select is(tests.stock_of(tests.nv('flour')), 70.000, '... and the stock did not move');
-- step-up: |delta| * cost (100) >= 5000 needs an authenticator session for enrolled / forced admins
select set_config('app.tenant_admin_mfa_required', 'on', true);
select is(tests.run(format($q$select public.fn_adjust_stock(%L, 60, 'recount found more', 'key-adjust-0006')$q$, tests.nv('flour'))), 'P0001|mfa_required|', 'adjust worth >= 5000 ETB without aal2 -> mfa_required');
select is(tests.run(format($q$select public.fn_adjust_stock(%L, 1, 'small recount', 'key-adjust-0007')$q$, tests.nv('flour'))), 'ok:1', 'small adjustment (value < 5000) needs no step-up');
select tests.aal2((select a_admin from _f));
select is(tests.run(format($q$select public.fn_adjust_stock(%L, 60, 'recount found more', 'key-adjust-0006')$q$, tests.nv('flour'))), 'ok:1', 'same large adjustment with aal2 succeeds');
select tests.clear_auth();
select set_config('app.tenant_admin_mfa_required', 'off', true);
select is(tests.stock_of(tests.nv('flour')), 131.000, 'stock = 100 - 30 + 1 + 60');

-- ═════════ reversal (compensating record) ═════════
select tests.authenticate_as((select a_admin from _f));
insert into _n select 'adj30', (select id::text from public.stock_movements where ingredient_id = tests.nv('flour') and qty_delta = -30);
select is((public.fn_reverse_stock_movement(tests.nv('adj30'), 'entered by mistake', 'key-reverse-0001') ->> 'stock'), '161.000', 'reverse the -30 adjustment: compensating +30 row');
select is((select reason || '|' || qty_delta || '|' || (reverses_movement_id = tests.nv('adj30'))::text from public.stock_movements where reverses_movement_id = tests.nv('adj30')), 'reversal|30.000|true', 'reversal row links the original');
select is((select qty_delta from public.stock_movements where id = tests.nv('adj30')), -30.000, 'the original row is untouched (append-only)');
select is(tests.ev((select a from _f), 'inventory.stock_reversed'), 1, 'reversal: audit event');
select public.fn_reverse_stock_movement(tests.nv('adj30'), 'entered by mistake', 'key-reverse-0001');
select is(tests.mov_count(tests.nv('flour')), 5, 'reversal replay writes no second row (receive + 3 adjusts + 1 reversal = 5 flour rows)');
select is(tests.run(format($q$select public.fn_reverse_stock_movement(%L, 'again please', 'key-reverse-0002')$q$, tests.nv('adj30'))), 'P0001|invalid_state|already_reversed', 'a movement can be reversed once');
insert into _n select 'rev', (select id::text from public.stock_movements where reverses_movement_id = tests.nv('adj30'));
select is(tests.run(format($q$select public.fn_reverse_stock_movement(%L, 'reverse the reversal', 'key-reverse-0003')$q$, tests.nv('rev'))), 'P0001|invalid_state|not_reversible', 'a reversal cannot be reversed');
select is(tests.run(format($q$select public.fn_reverse_stock_movement(%L, 'x', 'key-reverse-0004')$q$, tests.nv('adj30'))), 'P0001|invalid_input|reason', 'reversal: reason of at least 3 chars required');
select is(tests.oracle($q$select public.fn_reverse_stock_movement({id}, 'not mine at all', 'key-reverse-0005')$q$, tests.nv('b_mov')), 'P0001|not_found|', 'reversal: other tenant movement = not_found');
select tests.clear_auth();
select tests.authenticate_as((select a_waiter from _f));
select is(tests.run(format($q$select public.fn_reverse_stock_movement(%L, 'not allowed', 'key-reverse-0006')$q$, tests.nv('adj30'))), 'P0001|permission_denied|', 'reversal: waiter denied');
select tests.clear_auth();

-- ═════════ the Phase-3 gate: menu item + recipe -> real stock math ═════════
-- flour: 131 + 30 = 161 on hand. Recipe: 0.25 kg per Gate Burger. Add a second ingredient so a multi-line recipe is exercised.
select tests.authenticate_as((select a_admin from _f));
select public.fn_set_recipe(tests.nv('burger'), format('[{"ingredient_id": "%s", "qty_per_serving": 0.25}, {"ingredient_id": "%s", "qty_per_serving": 0.2}]', tests.nv('flour'), tests.nv('beef'))::jsonb);
select tests.clear_auth();
select tests.set_jwt((select a_admin from _f));    -- internal helpers run as the owner with the caller's identity
insert into _n select 'consumed_rows', public.fn_apply_recipe_consumption(tests.nv('a_order'), tests.nv('burger'), 4)::text;
select is((select v from _n where k = 'consumed_rows'), '2', 'consuming 4 burgers writes one movement per recipe line');
select is(tests.stock_of(tests.nv('flour')), 160.000, 'flour: 161 - 4 * 0.25 = 160');
select is(tests.stock_of(tests.nv('beef')), 54.200, 'beef: 50.5 + 4.5 - 4 * 0.2 = 54.2');
select is((select consumed_today from public.ingredients where id = tests.nv('flour')), 1.000, 'consumed_today follows');
select is((select count(*)::int from public.stock_movements where order_id = tests.nv('a_order') and reason = 'consumed' and qty_delta < 0), 2, 'consumption rows are negative and linked to the order');
select is(tests.run(format($q$select public.fn_apply_recipe_consumption(%L, %L, 100000)$q$, tests.nv('a_order'), tests.nv('burger'))), 'P0001|invalid_input|qty', 'consumption: absurd quantity refused');
select matches(tests.run(format($q$select public.fn_apply_recipe_consumption(%L, %L, 999)$q$, tests.nv('a_order'), tests.nv('burger'))), '^P0001\|insufficient_stock\|Gate (Flour|Beef)$', 'consumption beyond on-hand -> insufficient_stock (own ingredient name only)');
select is(tests.stock_of(tests.nv('flour')), 160.000, '... atomically: the flour line of the failed call was rolled back too');
select is(tests.run(format($q$select public.fn_apply_recipe_consumption(%L, %L, 1)$q$, gen_random_uuid(), tests.nv('burger'))), 'P0001|not_found|', 'consumption: unknown order = not_found');
select is(tests.run(format($q$select public.fn_apply_recipe_consumption(%L, %L, 1)$q$, tests.nv('a_order'), tests.nv('b_menu'))), 'P0001|not_found|', 'consumption: other tenant menu item = not_found');
select is(public.fn_reverse_order_consumption(tests.nv('a_order')), 2, 'cancelling the order reverses both consumption rows (compensating)');
select is(tests.stock_of(tests.nv('flour')) || '|' || tests.stock_of(tests.nv('beef')), '161.000|55.000', 'stock back to 161 / 55 after the reversal');
select is((select consumed_today from public.ingredients where id = tests.nv('flour')), 0.000, 'consumed_today follows the reversal');
select is(public.fn_reverse_order_consumption(tests.nv('a_order')), 0, 'second cancel is a no-op (already reversed)');
-- QR / table-session path: no profile behind the call at all; the tenant comes from the order row
select tests.clear_auth();
select is(public.fn_apply_recipe_consumption(tests.nv('a_order'), tests.nv('burger'), 1), 2, 'hooks work with NO signed-in profile (QR path): tenant derived from orders.restaurant_id');
select is((select count(*)::int from public.stock_movements where order_id = tests.nv('a_order') and reason = 'consumed' and created_by is null), 2, '... rows carry no actor (null), never a foreign one');
select tests.set_jwt((select b_admin from _f));
select is(tests.run(format($q$select public.fn_apply_recipe_consumption(%L, %L, 1)$q$, tests.nv('a_order'), tests.nv('b_menu'))), 'P0001|not_found|', 'a menu item of another tenant than the ORDER is not_found (caller identity irrelevant)');
select is(public.fn_reverse_order_consumption(tests.nv('a_order')), 2, 'reversal also keyed on the order tenant (caller is a tenant-B identity)');
select is((select count(*)::int from public.stock_movements where order_id = tests.nv('a_order') and created_by = (select b_admin from _f)), 0, 'a foreign caller is never recorded as the actor of tenant A rows');
select tests.clear_auth();
select tests.set_jwt((select a_admin from _f));
select is(tests.stock_of(tests.nv('flour')) || '|' || tests.stock_of(tests.nv('beef')), '161.000|55.000', 'stock back to 161 / 55');
select is(tests.ledger_gap((select a from _f)), 0::bigint, 'LEDGER INVARIANT: every ingredient on-hand = sum of its movements (tenant A, incl. seed)');
select is(tests.ledger_gap((select b from _f)), 0::bigint, 'LEDGER INVARIANT holds for tenant B');
select tests.clear_auth();

-- ═════════ immutability of the ledger from the RPC side ═════════
select throws_ok(format($q$update public.stock_movements set qty_delta = 1 where id = %L$q$, tests.nv('adj30')), 'P0001', 'immutable_record', 'ledger row cannot be edited, even by the owner');
select tests.authenticate_as((select a_admin from _f));
select is(tests.run(format($q$update public.ingredients set stock = 9999 where id = %L$q$, tests.nv('flour'))), '42501|permission denied for table ingredients|', 'client cannot overwrite on-hand directly');
select tests.clear_auth();

-- ═════════ movement log ═════════
select tests.authenticate_as((select a_admin from _f));
select is(jsonb_array_length(public.fn_list_stock_movements(tests.nv('flour'))), 9, 'admin log for flour: receive, 3 adjusts, 1 reversal, 2 consumptions, 2 consumption reversals');
select is((public.fn_list_stock_movements(tests.nv('flour'), 1) -> 0 ->> 'ingredient_name'), 'Gate Flour', 'log rows carry the ingredient name');
select is((select string_agg(distinct coalesce(e ->> 'created_by_name', 'NULL'), ',') from jsonb_array_elements(public.fn_list_stock_movements(tests.nv('flour'), 200)) e
           where e ->> 'created_by' = (select a_admin from _f)::text), (select short_name from public.profiles where id = (select a_admin from _f)), 'log rows carry the actor short name');
select is(jsonb_array_length(public.fn_list_stock_movements(tests.nv('flour'), 3)), 3, 'limit respected');
select is(tests.run($q$select public.fn_list_stock_movements(null, 0)$q$), 'P0001|invalid_input|limit', 'limit 0 refused');
select is(tests.run($q$select public.fn_list_stock_movements(null, 1000)$q$), 'P0001|invalid_input|limit', 'limit 1000 refused');
select is(jsonb_array_length(public.fn_list_stock_movements(tests.nv('flour'), 50, now() - interval '1 day')), 0, 'keyset p_before filters');
-- all 9 flour rows share created_at (one transaction): only the (created_at, id) keyset can page through them
insert into _n select 'log_full', public.fn_list_stock_movements(tests.nv('flour'), 200)::text;
insert into _n select 'log_p1', public.fn_list_stock_movements(tests.nv('flour'), 4)::text;
select is(jsonb_array_length(public.fn_list_stock_movements(tests.nv('flour'), 50, (tests.jv('log_p1') -> 3 ->> 'created_at')::timestamptz)), 0,
          'p_before alone (created_at only) loses every row that shares the timestamp ...');
select is((select string_agg(e ->> 'id', ',' order by n) from jsonb_array_elements(
             tests.jv('log_p1') || public.fn_list_stock_movements(tests.nv('flour'), 4, (tests.jv('log_p1') -> 3 ->> 'created_at')::timestamptz, (tests.jv('log_p1') -> 3 ->> 'id')::uuid))
             with ordinality as t(e, n)),
          (select string_agg(e ->> 'id', ',' order by n) from jsonb_array_elements(tests.jv('log_full')) with ordinality as t(e, n) where n <= 8),
          '... (p_before, p_before_id) continues exactly after the last row: page1 || page2 = the first 8 rows, no gap, no repeat');
select is(jsonb_array_length(public.fn_list_stock_movements(tests.nv('flour'), 200, (tests.jv('log_full') -> 8 ->> 'created_at')::timestamptz, (tests.jv('log_full') -> 8 ->> 'id')::uuid)), 0,
          'after the oldest row: empty page');
select is(tests.run(format($q$select public.fn_list_stock_movements(null, 10, null, %L)$q$, gen_random_uuid())), 'P0001|invalid_input|before', 'p_before_id without p_before refused');
select tests.clear_auth();

-- ═════════ step-up hardening + per-tenant threshold (a_admin owns a verified factor since the aal2 call above) ═════════
select tests.authenticate_as((select a_admin from _f));
insert into _n select 'oil', (public.fn_create_ingredient('Gate Oil', tests.nv('a_kit'), 'L', 0, 100) ->> 'id');
insert into _n select 'water', (public.fn_create_ingredient('Gate Water', tests.nv('a_kit'), 'L') ->> 'id');
select is(tests.run(format($q$select public.fn_receive_stock(%L, 50, 'key-stepup-0001')$q$, tests.nv('oil'))), 'P0001|mfa_required|', 'receive worth 50 x 100 = 5000 ETB without aal2 -> mfa_required (receive is gated too)');
select is(tests.mov_count(tests.nv('oil')), 0, '... and no ledger row survived the refusal');
select is((public.fn_receive_stock(tests.nv('oil'), 49, 'key-stepup-0002') ->> 'stock'), '49.000', 'receive worth 4900 ETB: no step-up');
select is(tests.run(format($q$select public.fn_create_ingredient('Gate Saffron', %L, 'g', 0, 100, 50)$q$, tests.nv('a_kit'))), 'P0001|mfa_required|', 'create ingredient with initial stock worth 5000 ETB -> mfa_required');
select is((select count(*)::int from public.ingredients where name = 'Gate Saffron'), 0, '... and no ingredient row was created');
select is(tests.run(format($q$select public.fn_create_ingredient('Gate Saffron', %L, 'g', 0, 100, 49)$q$, tests.nv('a_kit'))), 'ok:1', 'initial stock worth 4900 ETB: no step-up');
select is(tests.run(format($q$select public.fn_receive_stock(%L, 5000, 'key-stepup-0003')$q$, tests.nv('water'))), 'P0001|mfa_required|', 'cost 0: gated on quantity (|qty| 5000 >= threshold)');
select is(tests.run(format($q$select public.fn_adjust_stock(%L, 4999, 'opening count', 'key-stepup-0004')$q$, tests.nv('water'))), 'ok:1', 'cost 0, |qty| 4999: no step-up');
select is(tests.run(format($q$select public.fn_adjust_stock(%L, -4999, 'wrong count', 'key-stepup-0005')$q$, tests.nv('water'))), 'ok:1', 'negative quantity below the threshold: no step-up');
insert into _n select 'water_mov', (select id::text from public.stock_movements where ingredient_id = tests.nv('water') and qty_delta = 4999);
select is(tests.run(format($q$select public.fn_update_ingredient(%L, '{"cost_per_unit": 0}')$q$, tests.nv('oil'))), 'P0001|mfa_required|', 'changing cost_per_unit of an ingredient WITH movements needs step-up (zeroing the cost cannot evade the value rule)');
select is((select cost_per_unit from public.ingredients where id = tests.nv('oil')), 100.00, '... cost unchanged');
select is((public.fn_update_ingredient(tests.nv('oil'), '{"min_level": 3}') ->> 'min_level'), '3.000', 'other fields of that ingredient need no step-up');
select is((public.fn_update_ingredient(tests.nv('salt'), '{"cost_per_unit": 9}') ->> 'cost_per_unit'), '9.00', 'cost of an ingredient without movements changes without step-up');
-- threshold RPC: permission, aal2, validation
select is(tests.run($q$select public.fn_set_stock_stepup_threshold(1000)$q$), 'P0001|mfa_required|', 'threshold: settings.manage holder on an aal1 session -> mfa_required');
select tests.clear_auth();
select tests.authenticate_as((select a_waiter from _f));
select is(tests.run($q$select public.fn_set_stock_stepup_threshold(1000)$q$), 'P0001|permission_denied|', 'threshold: waiter (no settings.manage) denied');
select tests.clear_auth();
select tests.as_anon();
select is(tests.run($q$select public.fn_set_stock_stepup_threshold(1000)$q$), '42501|permission denied for function fn_set_stock_stepup_threshold|', 'threshold: anon has no EXECUTE');
select tests.clear_auth();
select tests.aal2((select a_admin from _f));
select is(tests.run($q$select public.fn_set_stock_stepup_threshold(99)$q$), 'P0001|invalid_input|stock_stepup_threshold', 'threshold below 100 refused');
select is(tests.run($q$select public.fn_set_stock_stepup_threshold(1000001)$q$), 'P0001|invalid_input|stock_stepup_threshold', 'threshold above 1000000 refused');
select is(tests.run($q$select public.fn_set_stock_stepup_threshold(1000.001)$q$), 'P0001|invalid_input|stock_stepup_threshold', 'threshold with 3 decimals refused');
select is(tests.run($q$select public.fn_set_stock_stepup_threshold(null)$q$), 'P0001|invalid_input|stock_stepup_threshold', 'null threshold refused');
select is((public.fn_set_stock_stepup_threshold(1000) ->> 'stock_stepup_threshold'), '1000.00', 'aal2 tenant admin sets the threshold to 1000 ETB');
select is((select (new_data ->> 'old') || '|' || (new_data ->> 'new') || '|' || actor_id::text from public.audit_logs
           where restaurant_id = (select a from _f) and event = 'settings.stock_stepup_threshold_updated'),
          '5000.00|1000.00|' || (select a_admin from _f)::text, 'threshold change audited with old / new value and the real actor');
select public.fn_set_stock_stepup_threshold(1000);
select is(tests.ev((select a from _f), 'settings.stock_stepup_threshold_updated'), 1, 'replay with the same value writes no second audit event');
select is((select stock_stepup_threshold from public.restaurants), 1000.00, 'clients can read their own threshold');
select is(tests.run($q$update public.restaurants set stock_stepup_threshold = 100$q$), '42501|permission denied for table restaurants|', 'the threshold is not client-updatable (RPC only)');
select tests.clear_auth();
select is((select stock_stepup_threshold from public.restaurants where id = (select b from _f)), 5000.00, 'tenant B keeps its own threshold (5000)');
select tests.aal2((select b_admin from _f));
select is((public.fn_set_stock_stepup_threshold(2000) ->> 'stock_stepup_threshold'), '2000.00', 'B admin sets B''s threshold ...');
select tests.clear_auth();
select is((select string_agg(stock_stepup_threshold::text, ',' order by id = (select a from _f) desc) from public.restaurants where id in ((select a from _f), (select b from _f))), '1000.00,2000.00',
          '... which never touches A''s (tenant from identity, no tenant parameter)');
select tests.authenticate_as((select a_admin from _f));
select is(tests.run(format($q$select public.fn_receive_stock(%L, 10, 'key-stepup-0006')$q$, tests.nv('oil'))), 'P0001|mfa_required|', 'with threshold 1000: a 10 x 100 = 1000 ETB receive now needs step-up');
select is(tests.run(format($q$select public.fn_receive_stock(%L, 9, 'key-stepup-0007')$q$, tests.nv('oil'))), 'ok:1', '900 ETB: no step-up');
select is(tests.run(format($q$select public.fn_reverse_stock_movement(%L, 'counted twice', 'key-stepup-0008')$q$, tests.nv('water_mov'))), 'P0001|mfa_required|', 'reversal of a 4999-unit zero-cost row: quantity >= threshold 1000 -> mfa_required');
select tests.clear_auth();
update public.restaurants set status = 'past_due' where id = (select a from _f);
select tests.aal2((select a_admin from _f));
select is(tests.run($q$select public.fn_set_stock_stepup_threshold(3000)$q$), 'P0001|tenant_read_only|', 'threshold: past_due tenant is read-only');
select tests.clear_auth();
update public.restaurants set status = 'active', stock_stepup_threshold = 5000 where id = (select a from _f);

-- ═════════ overflow: resulting on-hand / counters are pre-checked (numeric(12,3)) ═════════
insert into public.ingredients (restaurant_id, name, station_id, unit, stock, opening_stock) values ((select a from _f), 'Gate Max', tests.nv('a_kit'), 'g', 999999999, 999999999);
insert into public.stock_movements (restaurant_id, ingredient_id, station_id, qty_delta, reason, day_session_id)
select restaurant_id, id, station_id, 999999999, 'opening', tests.nv('a_day') from public.ingredients where name = 'Gate Max';
insert into _n select 'max', (select id::text from public.ingredients where name = 'Gate Max');
select tests.authenticate_as((select a_admin from _f));
select is(tests.run(format($q$select public.fn_receive_stock(%L, 1, 'key-overflow-0001')$q$, tests.nv('max'))), 'P0001|invalid_input|qty', 'receive that would push on-hand past 999999999.999 -> invalid_input (no numeric overflow error)');
select is(tests.run(format($q$select public.fn_adjust_stock(%L, 0.999, 'fill to the brim', 'key-overflow-0002')$q$, tests.nv('max'))), 'ok:1', 'exactly 999999999.999 is accepted');
select is(tests.run(format($q$select public.fn_adjust_stock(%L, 0.001, 'one more gram', 'key-overflow-0003')$q$, tests.nv('max'))), 'P0001|invalid_input|qty', 'one more thousandth refused');
select is(tests.stock_of(tests.nv('max')), 999999999.999, 'on-hand at the maximum, nothing half-written');
select tests.clear_auth();
select is(tests.ledger_gap((select a from _f)), 0::bigint, 'LEDGER INVARIANT still holds after the step-up / overflow cases');

-- ═════════ closed business day ═════════
update public.day_sessions set status = 'closed', closed_at = now(), closed_by = (select a_admin from _f), order_count = 1, gross_collected = 100,
  cash_collected = 100, cash_expenses = 0, expenses_total = 0, expected_cash = 2600, counted_cash = 2600, cash_variance = 0, net_profit = 100,
  inventory_variance = 0, station_snapshot = '[]', expense_snapshot = '[]', payment_snapshot = '[]' where id = tests.nv('a_day');
select tests.authenticate_as((select a_admin from _f));
select is(tests.run(format($q$select public.fn_receive_stock(%L, 1, 'key-closed-0001')$q$, tests.nv('flour'))), 'P0001|day_closed|no open business day', 'receive with no open day -> day_closed');
select is(tests.run(format($q$select public.fn_adjust_stock(%L, -1, 'closed day try', 'key-closed-0002')$q$, tests.nv('flour'))), 'P0001|day_closed|no open business day', 'adjust with no open day -> day_closed');
select is(tests.run(format($q$select public.fn_create_ingredient('Closed Day Item', %L, 'kg', 0, 0, 5)$q$, tests.nv('a_kit'))), 'P0001|day_closed|no open business day', 'create ingredient with initial stock and no open day -> day_closed');
select is(tests.run(format($q$select public.fn_create_ingredient('Closed Day Item', %L, 'kg')$q$, tests.nv('a_kit'))), 'ok:1', 'master data (no stock) can still be created while the day is closed');
select is(tests.stock_of(tests.nv('flour')), 161.000, 'closed day: stock unchanged by refused commands');
select is(jsonb_array_length(public.fn_list_stock_movements(tests.nv('flour'), 200)) > 0, true, 'the movement log stays readable');
select tests.clear_auth();
select is(tests.run(format($q$select public.fn_apply_recipe_consumption(%L, %L, 1)$q$, tests.nv('a_order'), tests.nv('burger'))), 'P0001|day_closed|no open business day', 'Phase-4 hook: consumption with no open day -> day_closed');
select is(tests.run(format($q$select public.fn_reverse_order_consumption(%L)$q$, tests.nv('a_order'))), 'P0001|day_closed|order business day is closed', 'Phase-4 hook: cancelling an order of a CLOSED day -> day_closed (Phase 4 must handle it)');

-- ═════════ tenant status ═════════
update public.restaurants set status = 'past_due' where id = (select a from _f);
select tests.authenticate_as((select a_admin from _f));
select is(tests.run(format($q$select public.fn_create_menu_item('PastDue', %L, %L, 1)$q$, tests.nv('a_cat'), tests.nv('a_kit'))), 'P0001|tenant_read_only|', 'past_due: menu write refused');
select is(tests.run(format($q$select public.fn_receive_stock(%L, 1, 'key-pastdue-0001')$q$, tests.nv('flour'))), 'P0001|tenant_read_only|', 'past_due: stock write refused');
select is(tests.run($q$select public.fn_list_stock_movements()$q$), 'ok:1', 'past_due: the movement log is still readable');
select tests.clear_auth();
update public.restaurants set status = 'suspended' where id = (select a from _f);
select tests.authenticate_as((select a_admin from _f));
select is(tests.run($q$select public.fn_list_stock_movements()$q$), 'P0001|tenant_suspended|', 'suspended: log refused');
select is(tests.run(format($q$select public.fn_adjust_stock(%L, -1, 'suspended try', 'key-susp-0001')$q$, tests.nv('flour'))), 'P0001|tenant_suspended|', 'suspended: adjust refused');
select tests.clear_auth();
update public.restaurants set status = 'active' where id = (select a from _f);

-- unauthenticated / anon
select tests.as_anon();
select is(tests.run(format($q$select public.fn_receive_stock(%L, 1, 'key-anon-00001')$q$, tests.nv('flour'))), '42501|permission denied for function fn_receive_stock|', 'anon: no EXECUTE on fn_receive_stock');
select is(tests.run($q$select public.fn_list_stock_movements()$q$), '42501|permission denied for function fn_list_stock_movements|', 'anon: no EXECUTE on the movement log');
select tests.clear_auth();

-- ═════════ storage policies (menu images) ═════════
select tests.authenticate_as((select a_admin from _f));
select is(tests.run(format($q$insert into storage.objects (bucket_id, name) values ('menu-images', 'restaurants/%s/menu/new-photo.webp')$q$, (select a from _f))), 'ok:1', 'storage: admin uploads under its own tenant prefix');
select is(tests.run(format($q$insert into storage.objects (bucket_id, name) values ('menu-images', 'restaurants/%s/menu/evil.png')$q$, (select b from _f))), '42501|new row violates row-level security policy for table "objects"|', 'storage: foreign tenant prefix refused');
select is(tests.run(format($q$insert into storage.objects (bucket_id, name) values ('menu-images', 'restaurants/%s/other/x.png')$q$, (select a from _f))), '42501|new row violates row-level security policy for table "objects"|', 'storage: own tenant but outside /menu/ refused');
select is(tests.run(format($q$insert into storage.objects (bucket_id, name) values ('menu-images', 'restaurants/%s/menu/x.exe')$q$, (select a from _f))), '42501|new row violates row-level security policy for table "objects"|', 'storage: non-image extension refused');
select is(tests.run(format($q$insert into storage.objects (bucket_id, name) values ('menu-images', 'restaurants/%s/menu/../../%s/menu/x.png')$q$, (select a from _f), (select b from _f))), '42501|new row violates row-level security policy for table "objects"|', 'storage: traversal refused');
select is(tests.run(format($q$insert into storage.objects (bucket_id, name) values ('other-bucket', 'restaurants/%s/menu/x.png')$q$, (select a from _f))), '42501|new row violates row-level security policy for table "objects"|', 'storage: no other bucket is writable (policies only ever grant menu-images)');
select is((select count(*)::int from storage.objects where name like 'restaurants/' || (select b from _f) || '/%'), 0, 'storage: tenant A cannot list tenant B objects');
select is(tests.run(format($q$delete from storage.objects where name = 'restaurants/%s/menu/burger.png'$q$, (select a from _f))), 'ok:0', 'storage: an image still referenced by a menu item cannot be deleted');
select is(tests.run(format($q$delete from storage.objects where name = 'restaurants/%s/menu/new-photo.webp'$q$, (select a from _f))), 'ok:1', 'storage: an unreferenced image can be deleted');
select is(tests.run(format($q$insert into storage.objects (bucket_id, name) values ('menu-images', 'RESTAURANTS/%s/MENU/upper.png')$q$, (select a from _f))), '42501|new row violates row-level security policy for table "objects"|', 'storage: case-variant prefix refused (case-sensitive path)');
select is(tests.run(format($q$insert into storage.objects (bucket_id, name) values ('menu-images', 'restaurants/%s/menu/Photo.PNG')$q$, (select a from _f))), 'ok:1', 'storage: mixed-case file name and upper-case extension accepted');
select is(tests.run(format($q$update storage.objects set name = 'restaurants/%s/menu/renamed.png' where name = 'restaurants/%s/menu/burger.png'$q$, (select a from _f), (select a from _f))), 'ok:0', 'storage: an image still referenced by a menu item cannot be renamed (no dangling image_path)');
select is(tests.run(format($q$update storage.objects set name = 'restaurants/%s/menu/photo2.webp' where name = 'restaurants/%s/menu/Photo.PNG'$q$, (select a from _f), (select a from _f))), 'ok:1', 'storage: an unreferenced image can be renamed');
select is((select count(*)::int from storage.objects where name ~ ('^restaurants/' || (select a from _f) || '/menu/burger\.png$')), 1, 'storage: the referenced image is still in place');
select tests.clear_auth();
select tests.authenticate_as((select a_waiter from _f));
select is(tests.run(format($q$insert into storage.objects (bucket_id, name) values ('menu-images', 'restaurants/%s/menu/waiter.png')$q$, (select a from _f))), '42501|new row violates row-level security policy for table "objects"|', 'storage: waiter (no menu.manage) cannot upload');
select is((select count(*)::int from storage.objects where bucket_id = 'menu-images'), 2, 'storage: waiter (menu.view) reads own tenant objects only (burger.png, photo2.webp; never the case-variant object)');
select tests.clear_auth();
select tests.authenticate_as((select b_admin from _f));
select is((select count(*)::int from storage.objects where bucket_id = 'menu-images' and name like 'restaurants/' || (select a from _f) || '/%'), 0, 'storage: tenant B cannot see tenant A objects');
select is(tests.run(format($q$delete from storage.objects where name like 'restaurants/%s/%%'$q$, (select a from _f))), 'ok:0', 'storage: tenant B cannot delete tenant A objects');
select tests.clear_auth();

select finish();
rollback;
