-- Phase 3 (migration 0029) adversarial supplement to 30_menu_inventory.test.sql.
--
-- Adds: every command/read RPC x {anon, no-permission role, view-only role, past_due, suspended}; B-to-A and A-to-B IDOR with real vs unknown
-- ids on every RPC not already probed in 30_*; foreign category / station / image references from the other direction; the internal
-- ledger writer called by clients; direct-DML bypass of the ledger and of the stock columns; station-scoped inventory visibility (direct
-- SELECT as well as the RPC); role escalation with only inventory.receive; replay of another tenant's idempotency key; deterministic
-- substitutes for the concurrent-adjust race; extra storage policy cases (sub-folder, move to a foreign prefix, anon, waiter, status).
--
-- The two "KNOWN-GAP probe" sections assert the SECURE behaviour for gaps found while reading the first version of 0029; 0029 was
-- hardened in place (RPC-only writes on menu_items / recipe_lines / ingredients, step-up on receive and cost edits, storage rename
-- guard, case-sensitive paths) and they must pass. Since 0029 clients hold NO write privilege on those three tables, so direct DML
-- answers 42501 permission denied (no row count, no RLS / FK message); the composite-FK backstops are probed as the owner.
begin;
select plan(110);

create temp table _f on commit drop as
select tests.tenant_id('central-cafe') a, tests.tenant_id('second-cafe') b,
       tests.user_id('selam', 'central-cafe') a_admin, tests.user_id('yonas', 'central-cafe') a_waiter,
       tests.user_id('abebe', 'central-cafe') a_kitchen, tests.user_id('sara', 'central-cafe') a_pastry,
       tests.user_id('owner', 'second-cafe') b_admin,
       tests.role_id('Kitchen', 'central-cafe') a_kitchen_role;
grant all on _f to public;
create temp table _n (k text primary key, v text);
grant all on _n to public;
create function tests.nv(p_k text) returns uuid language sql stable as $$ select v::uuid from _n where k = p_k $$;
create function tests.ledger_gap(p_rid uuid) returns bigint language sql stable security definer set search_path = '' as $$
  select count(*) from public.ingredients i
  where i.restaurant_id = p_rid and i.stock <> coalesce((select sum(m.qty_delta) from public.stock_movements m where m.ingredient_id = i.id), 0) $$;
create function tests.stock_of(p_ing uuid) returns numeric language sql stable security definer set search_path = '' as $$
  select stock from public.ingredients where id = p_ing $$;
create function tests.adv_count(p_sql text) returns bigint language plpgsql as $$
declare v bigint;
begin execute p_sql into v; return v; exception when others then return -1; end $$;
-- Runs all 11 command / read RPCs as the CURRENT role; returns 'all as expected' or the list of statements whose outcome did not start
-- with the expected prefix (statement 11 is the read, 1..10 are writes).
create function tests.adv_matrix(p_w text, p_r text) returns text language plpgsql as $$
declare
  v_sql text[];
  v_bad text := '';
  v_res text;
  i int;
begin
  v_sql := array[
    format($q$select public.fn_create_menu_item('Mx', %L, %L, 1)$q$, tests.nv('a_cat'), tests.nv('a_kit')),
    format($q$select public.fn_update_menu_item(%L, '{"price": 1}')$q$, tests.nv('a_menu')),
    format($q$select public.fn_set_menu_item_active(%L, false)$q$, tests.nv('a_menu')),
    format($q$select public.fn_set_recipe(%L, '[]')$q$, tests.nv('a_menu')),
    format($q$select public.fn_create_ingredient('Mx', %L, 'kg')$q$, tests.nv('a_kit')),
    format($q$select public.fn_update_ingredient(%L, '{"min_level": 1}')$q$, tests.nv('adv_k')),
    format($q$select public.fn_set_ingredient_active(%L, false)$q$, tests.nv('adv_k')),
    format($q$select public.fn_receive_stock(%L, 1, 'key-matrix-0001')$q$, tests.nv('adv_k')),
    format($q$select public.fn_adjust_stock(%L, -1, 'matrix try', 'key-matrix-0002')$q$, tests.nv('adv_k')),
    format($q$select public.fn_reverse_stock_movement(%L, 'matrix try', 'key-matrix-0003')$q$, tests.nv('a_kmov')),
    $q$select public.fn_list_stock_movements()$q$];
  for i in 1..array_length(v_sql, 1) loop
    v_res := tests.run(v_sql[i]);
    if v_res not like (case when i = 11 then p_r else p_w end || '%') then v_bad := v_bad || i || '=' || v_res || '; '; end if;
  end loop;
  return case when v_bad = '' then 'all as expected' else v_bad end;
end $$;
grant execute on all functions in schema tests to public;

-- fixtures (owner)
insert into _n select 'a_cat', (select id::text from public.categories where restaurant_id = (select a from _f) and name = 'Lunch');
insert into _n select 'a_kit', (select id::text from public.stations where restaurant_id = (select a from _f) and name = 'Kitchen');
insert into _n select 'a_pas', (select id::text from public.stations where restaurant_id = (select a from _f) and name = 'Pastry');
insert into _n select 'b_cat', (select id::text from public.categories where restaurant_id = (select b from _f) and name = 'Lunch');
insert into _n select 'b_kit', (select id::text from public.stations where restaurant_id = (select b from _f) and name = 'Kitchen');
insert into _n select 'a_day', (select id::text from public.day_sessions where restaurant_id = (select a from _f) and status = 'open');
insert into _n select 'b_day', (select id::text from public.day_sessions where restaurant_id = (select b from _f) and status = 'open');
insert into storage.objects (bucket_id, name) select 'menu-images', 'restaurants/' || a || '/menu/adv.png' from _f;
insert into storage.objects (bucket_id, name) select 'menu-images', 'restaurants/' || b || '/menu/foreign.png' from _f;
insert into public.menu_items (restaurant_id, name, category_id, station_id, price, image_path)
select a, 'Adv Burger', tests.nv('a_cat'), tests.nv('a_kit'), 10, 'restaurants/' || a || '/menu/adv.png' from _f;
insert into _n select 'a_menu', (select id::text from public.menu_items where restaurant_id = (select a from _f) and name = 'Adv Burger');
insert into _n select 'b_menu', (select id::text from public.menu_items where restaurant_id = (select b from _f) limit 1);
insert into public.ingredients (restaurant_id, name, station_id, unit, stock, opening_stock, cost_per_unit)
select a, 'Adv Kitchen', tests.nv('a_kit'), 'kg', 10, 10, 1000 from _f
union all select a, 'Adv Pastry', tests.nv('a_pas'), 'kg', 10, 10, 1 from _f
union all select a, 'Adv Costly', tests.nv('a_kit'), 'kg', 10, 10, 1000 from _f
union all select b, 'Adv B Rice', tests.nv('b_kit'), 'kg', 10, 10, 1 from _f;
insert into public.stock_movements (restaurant_id, ingredient_id, station_id, qty_delta, reason, day_session_id)
select i.restaurant_id, i.id, i.station_id, 10, 'opening',
       case when i.restaurant_id = (select a from _f) then tests.nv('a_day') else tests.nv('b_day') end
from public.ingredients i where i.name like 'Adv %';
insert into _n select 'adv_k', (select id::text from public.ingredients where name = 'Adv Kitchen');
insert into _n select 'adv_p', (select id::text from public.ingredients where name = 'Adv Pastry');
insert into _n select 'adv_c', (select id::text from public.ingredients where name = 'Adv Costly');
insert into _n select 'adv_b', (select id::text from public.ingredients where name = 'Adv B Rice');
insert into _n select 'a_kmov', (select id::text from public.stock_movements where ingredient_id = tests.nv('adv_k'));
create temp table _snap on commit drop as select tests.snapshot((select a from _f)) a, tests.snapshot((select b from _f)) b;
grant all on _snap to public;

-- ═════════ anon / no-permission / view-only roles x every RPC ═════════
select tests.as_anon();
select is(tests.adv_matrix('42501|permission denied for function', '42501|permission denied for function'), 'all as expected', 'anon: none of the 11 RPCs is executable');
select tests.clear_auth();
select tests.authenticate_as((select a_waiter from _f));
select is(tests.adv_matrix('P0001|permission_denied|', 'P0001|permission_denied|'), 'all as expected', 'waiter (no menu/inventory permissions): all 11 RPCs permission_denied');
select tests.clear_auth();
select tests.authenticate_as((select a_kitchen from _f));
select is(tests.adv_matrix('P0001|permission_denied|', 'ok:1'), 'all as expected', 'kitchen (inventory.view only): all 10 writes permission_denied, the log is readable');
select tests.clear_auth();

-- ═════════ internal ledger writer / consumption hooks called by clients ═════════
select tests.authenticate_as((select a_admin from _f));
select is(tests.run(format($q$select public.fn_post_stock_movement(%L, %L, 1000, 'received', null, null, null)$q$, (select a from _f), tests.nv('adv_k'))),
          '42501|permission denied for function fn_post_stock_movement|', 'A admin cannot call the ledger writer directly (would bypass permission, idempotency, step-up, audit)');
select is(tests.run(format($q$select public.fn_apply_recipe_consumption(gen_random_uuid(), %L, 1)$q$, tests.nv('a_menu'))),
          '42501|permission denied for function fn_apply_recipe_consumption|', 'A admin cannot call the consumption hook');
select is(tests.run($q$select public.fn_reverse_order_consumption(gen_random_uuid())$q$),
          '42501|permission denied for function fn_reverse_order_consumption|', 'A admin cannot call the consumption-reversal hook');
select tests.clear_auth();
select tests.authenticate_as((select b_admin from _f));
select is(tests.run(format($q$select public.fn_post_stock_movement(%L, %L, 1000, 'received', null, null, null)$q$, (select a from _f), tests.nv('adv_k'))),
          '42501|permission denied for function fn_post_stock_movement|', 'B admin cannot post a movement into tenant A by passing A''s tenant id to the internal writer');
select tests.clear_auth();
select is(tests.stock_of(tests.nv('adv_k')), 10.000, 'refused internal calls moved no stock');

-- ═════════ tenant B attacking tenant A (IDOR with real vs unknown ids) ═════════
select tests.authenticate_as((select b_admin from _f));
select is(tests.oracle($q$select public.fn_update_menu_item({id}, '{"price": 1}')$q$, tests.nv('a_menu')), 'P0001|not_found|', 'B -> A: update menu item = unknown id');
select is(tests.oracle($q$select public.fn_set_menu_item_active({id}, false)$q$, tests.nv('a_menu')), 'P0001|not_found|', 'B -> A: set menu item active = unknown id');
select is(tests.oracle(format($q$select public.fn_set_recipe({id}, '[{"ingredient_id": "%s", "qty_per_serving": 1}]')$q$, tests.nv('adv_b')), tests.nv('a_menu')), 'P0001|not_found|', 'B -> A: set recipe on A menu item = unknown id');
select is(tests.oracle($q$select public.fn_update_ingredient({id}, '{"min_level": 1}')$q$, tests.nv('adv_k')), 'P0001|not_found|', 'B -> A: update ingredient = unknown id');
select is(tests.oracle($q$select public.fn_set_ingredient_active({id}, false)$q$, tests.nv('adv_k')), 'P0001|not_found|', 'B -> A: set ingredient active = unknown id');
select is(tests.oracle($q$select public.fn_reverse_stock_movement({id}, 'not mine at all', 'key-adv-b-rev1')$q$, tests.nv('a_kmov')), 'P0001|not_found|', 'B -> A: reverse an A movement = unknown id');
select is(jsonb_array_length(public.fn_list_stock_movements(tests.nv('adv_k'))), 0, 'B -> A: the movement log filtered to an A ingredient is empty');
select is(tests.run(format($q$select public.fn_create_menu_item('Adv Steal', %L, %L, 1)$q$, tests.nv('a_cat'), tests.nv('b_kit'))), 'P0001|invalid_input|category_id', 'B create item with A category refused');
select is(tests.run(format($q$select public.fn_create_menu_item('Adv Steal', %L, %L, 1)$q$, tests.nv('b_cat'), tests.nv('a_kit'))), 'P0001|invalid_station|', 'B create item with A station refused');
select is(tests.run(format($q$select public.fn_create_menu_item('Adv Steal', %L, %L, 1, null, null, %L)$q$, tests.nv('b_cat'), tests.nv('b_kit'), 'restaurants/' || (select a from _f) || '/menu/adv.png')),
          'P0001|invalid_input|image_path', 'B create item pointing at an A image (an object that really exists) refused');
select is(tests.run(format($q$select public.fn_create_ingredient('Adv Steal', %L, 'kg')$q$, tests.nv('a_kit'))), 'P0001|invalid_station|', 'B create ingredient on an A station refused');
select is(tests.run(format($q$select public.fn_update_menu_item(%L, '{"category_id": "%s"}')$q$, tests.nv('b_menu'), tests.nv('a_cat'))), 'P0001|invalid_input|category_id', 'B move own item into an A category refused');
select is(tests.run(format($q$select public.fn_update_menu_item(%L, '{"station_id": "%s"}')$q$, tests.nv('b_menu'), tests.nv('a_kit'))), 'P0001|invalid_station|', 'B move own item to an A station refused');
select is(tests.run(format($q$select public.fn_update_menu_item(%L, '{"image_path": "restaurants/%s/menu/adv.png"}')$q$, tests.nv('b_menu'), (select a from _f))), 'P0001|invalid_input|image_path', 'B patch own item with an A image refused');
select is(tests.run(format($q$select public.fn_set_recipe(%L, '[{"ingredient_id": "%s", "qty_per_serving": 1}]')$q$, tests.nv('b_menu'), tests.nv('adv_k'))), 'P0001|invalid_input|ingredient_id', 'B recipe line using an A ingredient refused (same answer as unknown)');
select tests.clear_auth();
select is(tests.snapshot((select a from _f)), (select a from _snap), 'tenant A data byte-for-byte unchanged after every B attack');

-- ═════════ tenant A attacking tenant B: RPCs and direct DML ═════════
select tests.authenticate_as((select a_admin from _f));
select is(tests.oracle($q$select public.fn_adjust_stock({id}, -1, 'not yours at all', 'key-adv-a-adj1')$q$, tests.nv('adv_b')), 'P0001|not_found|', 'A -> B: adjust a B ingredient = unknown id');
select is(tests.oracle($q$select public.fn_list_stock_movements({id})$q$, tests.nv('adv_b')), 'ok:1', 'A -> B: movement log for a B ingredient is indistinguishable from an unknown id');
select is(jsonb_array_length(public.fn_list_stock_movements(tests.nv('adv_b'))), 0, '... and empty');
select is((select count(*)::int from jsonb_array_elements(public.fn_list_stock_movements(null, 200)) e where e ->> 'ingredient_id' = tests.nv('adv_b')::text), 0, 'the unfiltered log never contains a B ingredient');
select is((select count(*)::int from public.ingredients where id = tests.nv('adv_b')), 0, 'direct SELECT cannot see a B ingredient');
select is((select count(*)::int from public.stock_movements where restaurant_id = (select b from _f)), 0, 'direct SELECT cannot see B ledger rows');
select is(tests.run(format($q$update public.ingredients set name = 'pwned' where id = %L$q$, tests.nv('adv_b'))), '42501|permission denied for table ingredients|', 'direct UPDATE of a B ingredient: no client UPDATE privilege at all');
select is(tests.run(format($q$delete from public.ingredients where id = %L$q$, tests.nv('adv_b'))), '42501|permission denied for table ingredients|', 'direct DELETE of a B ingredient: no client DELETE privilege');
select is(tests.run(format($q$update public.menu_items set price = 1 where id = %L$q$, tests.nv('b_menu'))), '42501|permission denied for table menu_items|', 'direct UPDATE of a B menu item: no client UPDATE privilege');
select is(tests.run(format($q$delete from public.menu_items where id = %L$q$, tests.nv('b_menu'))), '42501|permission denied for table menu_items|', 'direct DELETE of a B menu item: no client DELETE privilege');
select is(tests.run(format($q$insert into public.ingredients (restaurant_id, name, station_id, unit) values (%L, 'Adv Planted', %L, 'kg')$q$, (select b from _f), tests.nv('b_kit'))),
          '42501|permission denied for table ingredients|', 'direct INSERT of an ingredient into tenant B: no client INSERT privilege');
select is(tests.run(format($q$insert into public.recipe_lines (restaurant_id, menu_item_id, ingredient_id, qty_per_serving) values (%L, %L, %L, 1)$q$, (select b from _f), tests.nv('b_menu'), tests.nv('adv_b'))),
          '42501|permission denied for table recipe_lines|', 'direct INSERT of a recipe line into tenant B: no client INSERT privilege');
select is(tests.run(format($q$update public.ingredients set restaurant_id = %L where id = %L$q$, (select b from _f), tests.nv('adv_k'))),
          '42501|permission denied for table ingredients|', 'restaurant_id of an ingredient is not client-updatable');
select tests.clear_auth();
-- DB backstops behind the RPCs, probed as the owner (no client can issue these statements any more)
select matches(tests.run(format($q$insert into public.recipe_lines (restaurant_id, menu_item_id, ingredient_id, qty_per_serving) values (%L, %L, %L, 1)$q$, (select a from _f), tests.nv('a_menu'), tests.nv('adv_b'))),
               '^23503\|', 'owner: recipe line (A menu item + B ingredient): composite FK refuses the cross-tenant link');
select matches(tests.run(format($q$insert into public.menu_items (restaurant_id, name, category_id, station_id, price) values (%L, 'Adv X', %L, %L, 1)$q$, (select a from _f), tests.nv('b_cat'), tests.nv('a_kit'))),
               '^23503\|', 'owner: menu item with a B category: composite FK refuses it');
select matches(tests.run(format($q$update public.ingredients set station_id = %L where id = %L$q$, tests.nv('b_kit'), tests.nv('adv_k'))),
               '^23503\|', 'owner: move of an A ingredient onto a B station: composite FK refuses it');
select is(tests.snapshot((select b from _f)), (select b from _snap), 'tenant B data byte-for-byte unchanged after every A attack');

-- replay of another tenant's idempotency key
select tests.authenticate_as((select a_admin from _f));
select public.fn_receive_stock(tests.nv('adv_k'), 1, 'adv-key-shared-01');
select tests.clear_auth();
select tests.authenticate_as((select b_admin from _f));
select is(tests.oracle($q$select public.fn_receive_stock({id}, 1, 'adv-key-shared-01')$q$, tests.nv('adv_k')), 'P0001|not_found|', 'B replaying A''s key text against the A ingredient: not_found, never A''s stored result');
select is((public.fn_receive_stock(tests.nv('adv_b'), 2, 'adv-key-shared-01') ->> 'ingredient_id') || '|' || (public.fn_receive_stock(tests.nv('adv_b'), 2, 'adv-key-shared-01') ->> 'stock'),
          tests.nv('adv_b')::text || '|12.000', 'same key text in tenant B is a fresh execution on B''s own ingredient (and replays B''s own result)');
select tests.clear_auth();
select is(tests.stock_of(tests.nv('adv_k')), 11.000, 'A ingredient holds exactly A''s single receive');

-- ═════════ direct DML against the ledger and the stock columns (authenticated A admin) ═════════
select tests.authenticate_as((select a_admin from _f));
select is(tests.run(format($q$update public.ingredients set stock = 9999 where id = %L$q$, tests.nv('adv_k'))), '42501|permission denied for table ingredients|', 'UPDATE ingredients.stock refused');
select is(tests.run(format($q$update public.ingredients set received_today = 9999 where id = %L$q$, tests.nv('adv_k'))), '42501|permission denied for table ingredients|', 'UPDATE ingredients.received_today refused');
select is(tests.run(format($q$update public.ingredients set consumed_today = 0 where id = %L$q$, tests.nv('adv_k'))), '42501|permission denied for table ingredients|', 'UPDATE ingredients.consumed_today refused');
select is(tests.run(format($q$update public.ingredients set opening_stock = 9999 where id = %L$q$, tests.nv('adv_k'))), '42501|permission denied for table ingredients|', 'UPDATE ingredients.opening_stock refused');
select is(tests.run(format($q$insert into public.ingredients (restaurant_id, name, station_id, unit, stock) values (%L, 'Adv Rich', %L, 'kg', 999)$q$, (select a from _f), tests.nv('a_kit'))),
          '42501|permission denied for table ingredients|', 'INSERT ingredient with a preset on-hand refused (column grant)');
select is(tests.run(format($q$insert into public.ingredients (id, restaurant_id, name, station_id, unit) values (gen_random_uuid(), %L, 'Adv Id', %L, 'kg')$q$, (select a from _f), tests.nv('a_kit'))),
          '42501|permission denied for table ingredients|', 'INSERT ingredient with a client-chosen id refused (no id oracle)');
select is(tests.run(format($q$insert into public.stock_movements (restaurant_id, ingredient_id, station_id, qty_delta, reason, day_session_id) values (%L, %L, %L, 500, 'received', %L)$q$,
                           (select a from _f), tests.nv('adv_k'), tests.nv('a_kit'), tests.nv('a_day'))), '42501|permission denied for table stock_movements|', 'INSERT into the ledger refused');
select is(tests.run(format($q$update public.stock_movements set qty_delta = 1 where id = %L$q$, tests.nv('a_kmov'))), '42501|permission denied for table stock_movements|', 'UPDATE of a ledger row refused');
select is(tests.run(format($q$delete from public.stock_movements where id = %L$q$, tests.nv('a_kmov'))), '42501|permission denied for table stock_movements|', 'DELETE of a ledger row refused');
select is(tests.run($q$truncate public.stock_movements$q$), '42501|permission denied for table stock_movements|', 'TRUNCATE of the ledger refused');
select is(tests.run(format($q$delete from public.ingredients where id = %L$q$, tests.nv('adv_k'))), '42501|permission denied for table ingredients|', 'DELETE of an ingredient (with ledger rows): no client DELETE privilege, row kept');
select is(tests.ledger_gap((select a from _f)), 0::bigint, 'LEDGER INVARIANT intact (on-hand = sum of movements) after the direct-DML attempts');
select tests.clear_auth();

-- ═════════ station-scoped inventory visibility (direct SELECT and RPC) ═════════
-- fixtures: Kitchen: Adv Kitchen (opening + receive = 2 rows) and Adv Costly (1); Pastry: Adv Pastry (1)
select tests.authenticate_as((select a_kitchen from _f));
select is((select count(*)::int from public.ingredients where name like 'Adv %'), 2, 'kitchen: direct SELECT sees only the 2 Kitchen-station ingredients');
select is((select count(*)::int from public.stock_movements where ingredient_id in (tests.nv('adv_k'), tests.nv('adv_p'), tests.nv('adv_c'))), 3, 'kitchen: direct SELECT sees the 3 Kitchen ledger rows, none of Pastry');
select is((select count(*)::int from public.stock_movements where ingredient_id = tests.nv('adv_p')), 0, 'kitchen: a Pastry ingredient''s ledger is invisible');
select is(jsonb_array_length(public.fn_list_stock_movements(tests.nv('adv_p'))), 0, 'kitchen: the RPC agrees with the policy for a Pastry ingredient');
select is(tests.run(format($q$update public.ingredients set min_level = 99 where id = %L$q$, tests.nv('adv_k'))), '42501|permission denied for table ingredients|', 'kitchen: direct UPDATE refused (no client write privilege)');
select is(tests.run(format($q$delete from public.ingredients where id = %L$q$, tests.nv('adv_c'))), '42501|permission denied for table ingredients|', 'kitchen: direct DELETE refused');
select is(tests.run(format($q$insert into public.ingredients (restaurant_id, name, station_id, unit) values (%L, 'Adv Kit Made', %L, 'kg')$q$, (select a from _f), tests.nv('a_kit'))),
          '42501|permission denied for table ingredients|', 'kitchen: direct INSERT of an ingredient refused');
select is(tests.run(format($q$update public.menu_items set price = 1 where id = %L$q$, tests.nv('a_menu'))), '42501|permission denied for table menu_items|', 'kitchen: direct menu UPDATE refused');
select tests.clear_auth();
select tests.authenticate_as((select a_pastry from _f));
select is((select count(*)::int from public.ingredients where name like 'Adv %'), 1, 'pastry: direct SELECT sees only the Pastry ingredient');
select is((select count(*)::int from public.stock_movements where ingredient_id in (tests.nv('adv_k'), tests.nv('adv_p'), tests.nv('adv_c'))), 1, 'pastry: direct SELECT sees only the Pastry ledger row');
select tests.clear_auth();
select tests.authenticate_as((select a_waiter from _f));
select is((select count(*)::int from public.ingredients where name like 'Adv %') + (select count(*)::int from public.stock_movements where ingredient_id in (tests.nv('adv_k'), tests.nv('adv_p'), tests.nv('adv_c'))), 0, 'waiter (no inventory.view): sees no ingredient and no ledger row');
select tests.clear_auth();
select tests.authenticate_as((select a_admin from _f));
select is((select count(*)::int from public.ingredients where name like 'Adv %'), 3, 'admin (inventory.adjust): all 3 own ingredients, never the B one');
select tests.clear_auth();

-- ═════════ role escalation with only inventory.receive ═════════
insert into public.role_permissions (role_id, permission_id, restaurant_id)
select (select a_kitchen_role from _f), pm.id, (select a from _f) from public.permissions pm where pm.key = 'inventory.receive';
select tests.authenticate_as((select a_kitchen from _f));
select is(tests.run(format($q$select public.fn_adjust_stock(%L, -1, 'receive-only try', 'key-adv-esc-0001')$q$, tests.nv('adv_k'))), 'P0001|permission_denied|', 'receive-only: adjust denied');
select is(tests.run(format($q$select public.fn_reverse_stock_movement(%L, 'receive-only try', 'key-adv-esc-0002')$q$, tests.nv('a_kmov'))), 'P0001|permission_denied|', 'receive-only: reversal denied');
select is(tests.run(format($q$select public.fn_create_ingredient('Adv Esc', %L, 'kg')$q$, tests.nv('a_kit'))), 'P0001|permission_denied|', 'receive-only: create ingredient denied');
select is(tests.run(format($q$select public.fn_update_ingredient(%L, '{"cost_per_unit": 0}')$q$, tests.nv('adv_k'))), 'P0001|permission_denied|', 'receive-only: cannot edit cost (which drives the step-up threshold)');
select matches(tests.run(format($q$insert into public.role_permissions (role_id, permission_id, restaurant_id) select %L, pm.id, %L from public.permissions pm where pm.key = 'inventory.adjust'$q$,
                                (select a_kitchen_role from _f), (select a from _f))), '^42501\|', 'receive-only: cannot grant itself inventory.adjust through role_permissions');
select tests.clear_auth();

-- ═════════ concurrent-adjust race: deterministic substitutes (pgTAP is one session; see the report for a dblink / pgbench recipe) ═════════
select tests.authenticate_as((select a_admin from _f));
select is((public.fn_adjust_stock(tests.nv('adv_p'), -7, 'first spend', 'key-adv-race-0001') ->> 'stock'), '3.000', 'adjust -7 of 10: on-hand 3');
select is(tests.run(format($q$select public.fn_adjust_stock(%L, -7, 'second spend', 'key-adv-race-0002')$q$, tests.nv('adv_p'))), 'P0001|insufficient_stock|Adv Pastry', 'the second -7 cannot overdraw: insufficient_stock');
select is(tests.stock_of(tests.nv('adv_p')), 3.000, 'on-hand stayed 3');
insert into _n select 'adv_m7', (select id::text from public.stock_movements where ingredient_id = tests.nv('adv_p') and qty_delta = -7);
select is((public.fn_reverse_stock_movement(tests.nv('adv_m7'), 'undo first spend', 'key-adv-race-0003') ->> 'stock'), '10.000', 'reversal restores 10');
select is(tests.run(format($q$select public.fn_reverse_stock_movement(%L, 'undo again please', 'key-adv-race-0004')$q$, tests.nv('adv_m7'))), 'P0001|invalid_state|already_reversed', 'a second reversal with a NEW key: already_reversed');
select tests.clear_auth();
select matches(tests.run(format($q$insert into public.stock_movements (restaurant_id, ingredient_id, station_id, qty_delta, reason, reverses_movement_id, day_session_id) values (%L, %L, %L, 7, 'reversal', %L, %L)$q$,
                                (select a from _f), tests.nv('adv_p'), tests.nv('a_pas'), tests.nv('adv_m7'), tests.nv('a_day'))), '^23505\|',
               'DB backstop for a lost reversal race: even the owner cannot write a second reversal row (unique index)');
select matches(tests.run(format($q$update public.ingredients set stock = -1 where id = %L$q$, tests.nv('adv_p'))), '^23514\|', 'DB backstop for a lost overdraw race: stock >= 0 check constraint');
select is((select count(*)::int from pg_proc p where p.pronamespace = 'public'::regnamespace
           and p.proname in ('fn_post_stock_movement', 'fn_adjust_stock', 'fn_receive_stock', 'fn_reverse_stock_movement') and pg_get_functiondef(p.oid) ~* 'for update'), 4,
          'every ledger path takes the ingredient row lock (FOR UPDATE) before reading on-hand');
select is(tests.ledger_gap((select a from _f)), 0::bigint, 'LEDGER INVARIANT after the race substitutes');

-- ═════════ KNOWN-GAP probe 1: step-up evasion (expected to FAIL on 0029) ═════════
select set_config('app.tenant_admin_mfa_required', 'on', true);
select tests.authenticate_as((select a_admin from _f));
select is(tests.run(format($q$select public.fn_adjust_stock(%L, 100, 'control recount', 'key-adv-mfa-0001')$q$, tests.nv('adv_k'))), 'P0001|mfa_required|', 'control: 100 x 1000 ETB adjust without aal2 needs step-up');
select is(tests.run(format($q$select public.fn_receive_stock(%L, 1000, 'key-adv-mfa-0002')$q$, tests.nv('adv_k'))), 'P0001|mfa_required|', 'PROBE receive: a 1,000,000 ETB receive needs step-up like an adjustment');
select is(tests.run(format($q$select public.fn_update_ingredient(%L, '{"cost_per_unit": 0}')$q$, tests.nv('adv_k'))), 'P0001|mfa_required|', 'PROBE cost edit via RPC: zeroing cost_per_unit of an ingredient with movements needs step-up');
select is(tests.run(format($q$select public.fn_adjust_stock(%L, 100, 'after cost edit', 'key-adv-mfa-0003')$q$, tests.nv('adv_k'))), 'P0001|mfa_required|', 'PROBE cost edit via RPC: zeroing cost_per_unit (no step-up) then adjusting evades the value threshold');
select is(tests.run(format($q$update public.ingredients set cost_per_unit = 0 where id = %L$q$, tests.nv('adv_c'))), '42501|permission denied for table ingredients|', 'PROBE cost edit via direct DML: no client UPDATE privilege');
select is(tests.run(format($q$select public.fn_adjust_stock(%L, 100, 'after dml cost edit', 'key-adv-mfa-0004')$q$, tests.nv('adv_c'))), 'P0001|mfa_required|', 'PROBE cost edit via direct DML: same evasion');
select tests.clear_auth();
select set_config('app.tenant_admin_mfa_required', 'off', true);

-- ═════════ KNOWN-GAP probe 2: direct DML skips RPC-only invariants (expected to FAIL on 0029) ═════════
select tests.authenticate_as((select a_admin from _f));
select is(tests.run(format($q$select public.fn_set_recipe(%L, '[{"ingredient_id": "%s", "qty_per_serving": 0.5}]')$q$, tests.nv('a_menu'), tests.nv('adv_k'))), 'ok:1', 'fixture: Adv Burger recipe uses Adv Kitchen');
select isnt(tests.run(format($q$update public.ingredients set is_active = false where id = %L$q$, tests.nv('adv_k'))), 'ok:1', 'PROBE: direct UPDATE can deactivate an ingredient used by an active recipe (RPC refuses with ingredient_in_active_recipe)');
select isnt(tests.run(format($q$update public.ingredients set unit = 'g' where id = %L$q$, tests.nv('adv_c'))), 'ok:1', 'PROBE: direct UPDATE can change the unit of an ingredient that has ledger rows (RPC refuses with unit_locked)');
select tests.clear_auth();
update public.plans set max_menu_items = (select count(*) from public.menu_items where restaurant_id = (select a from _f) and is_active)
 where id = (select plan_id from public.subscriptions where restaurant_id = (select a from _f));
select tests.authenticate_as((select a_admin from _f));
select isnt(tests.run(format($q$insert into public.menu_items (restaurant_id, name, category_id, station_id, price) values (%L, 'Adv Over Cap', %L, %L, 1)$q$, (select a from _f), tests.nv('a_cat'), tests.nv('a_kit'))),
            'ok:1', 'PROBE: direct INSERT of a menu item ignores plan max_menu_items (RPC refuses with plan_limit_reached)');
select tests.clear_auth();
update public.plans set max_menu_items = null where id = (select plan_id from public.subscriptions where restaurant_id = (select a from _f));
select tests.authenticate_as((select a_admin from _f));
select isnt(tests.run(format($q$insert into public.menu_items (restaurant_id, name, category_id, station_id, price, image_path) values (%L, 'Adv Ghost', %L, %L, 1, %L)$q$,
                             (select a from _f), tests.nv('a_cat'), tests.nv('a_kit'), 'restaurants/' || (select a from _f) || '/menu/ghost.png')),
            'ok:1', 'PROBE: direct INSERT accepts an image_path for an object that was never uploaded (RPC refuses)');
select is(tests.run(format($q$update storage.objects set name = 'restaurants/%s/menu/renamed.png' where bucket_id = 'menu-images' and name = 'restaurants/%s/menu/adv.png'$q$, (select a from _f), (select a from _f))), 'ok:0',
          'PROBE storage: rename of a referenced image touches 0 rows (update USING has the same not-referenced guard as delete)');
select is((select count(*)::int from storage.objects where bucket_id = 'menu-images' and name = 'restaurants/' || (select a from _f) || '/menu/adv.png'), 1,
          'PROBE storage: renaming (UPDATE) an image a menu item still points at must be refused like DELETE is (dangling image_path otherwise)');
select matches(tests.run(format($q$insert into storage.objects (bucket_id, name) values ('menu-images', 'RESTAURANTS/%s/MENU/upper.png')$q$, (select a from _f))), '^42501\|',
               'PROBE storage: case-variant path (policy uses ~*) must be refused; otherwise an object only the owner can ever read or delete is created');
select tests.clear_auth();

-- ═════════ storage: extra policy cases ═════════
select tests.authenticate_as((select a_admin from _f));
select matches(tests.run(format($q$insert into storage.objects (bucket_id, name) values ('menu-images', 'restaurants/%s/menu/sub/x.png')$q$, (select a from _f))), '^42501\|', 'storage: sub-folder under /menu/ refused');
select tests.clear_auth();
select tests.authenticate_as((select b_admin from _f));
select is(tests.run(format($q$update storage.objects set name = name || 'x' where name like 'restaurants/%s/%%'$q$, (select a from _f))), 'ok:0', 'storage: B cannot rename A objects (0 rows)');
select matches(tests.run(format($q$update storage.objects set name = 'restaurants/%s/menu/stolen.png' where name = 'restaurants/%s/menu/foreign.png'$q$, (select a from _f), (select b from _f))), '^42501\|',
               'storage: B cannot move its own object under the A prefix (WITH CHECK)');
select tests.clear_auth();
select tests.as_anon();
select ok(tests.adv_count($q$select count(*) from storage.objects where bucket_id = 'menu-images'$q$) <= 0, 'storage: anon reads no menu image (0 rows or denied)');
select matches(tests.run(format($q$insert into storage.objects (bucket_id, name) values ('menu-images', 'restaurants/%s/menu/anon.png')$q$, (select a from _f))), '^42501\|', 'storage: anon cannot upload');
select tests.clear_auth();
select tests.authenticate_as((select a_waiter from _f));
select is(tests.run(format($q$update storage.objects set name = name where name like 'restaurants/%s/%%'$q$, (select a from _f))), 'ok:0', 'storage: waiter (no menu.manage) cannot update objects');
select is(tests.run(format($q$delete from storage.objects where name like 'restaurants/%s/%%'$q$, (select a from _f))), 'ok:0', 'storage: waiter cannot delete objects');
select tests.clear_auth();

-- ═════════ tenant status: every RPC, storage, direct DML; the other tenant is unaffected ═════════
update public.restaurants set status = 'past_due' where id = (select a from _f);
select tests.authenticate_as((select a_admin from _f));
select is(tests.adv_matrix('P0001|tenant_read_only|', 'ok:1'), 'all as expected', 'past_due: all 10 writes tenant_read_only, the log stays readable');
select matches(tests.run(format($q$insert into storage.objects (bucket_id, name) values ('menu-images', 'restaurants/%s/menu/pd.png')$q$, (select a from _f))), '^42501\|', 'past_due: image upload refused');
select is(tests.run(format($q$update public.ingredients set min_level = 3 where id = %L$q$, tests.nv('adv_k'))), '42501|permission denied for table ingredients|', 'past_due: direct UPDATE of an ingredient refused (no client write privilege in any status)');
select tests.clear_auth();
update public.restaurants set status = 'suspended' where id = (select a from _f);
select tests.authenticate_as((select a_admin from _f));
select is(tests.adv_matrix('P0001|tenant_suspended|', 'P0001|tenant_suspended|'), 'all as expected', 'suspended: all 11 RPCs tenant_suspended (writes and the read)');
select matches(tests.run(format($q$insert into storage.objects (bucket_id, name) values ('menu-images', 'restaurants/%s/menu/susp.png')$q$, (select a from _f))), '^42501\|', 'suspended: image upload refused');
select tests.clear_auth();
select tests.authenticate_as((select b_admin from _f));
select is(tests.run(format($q$select public.fn_adjust_stock(%L, -1, 'b keeps working', 'key-adv-b-ok-0001')$q$, tests.nv('adv_b'))), 'ok:1', 'while A is suspended, tenant B still adjusts stock');
select is(tests.oracle($q$select public.fn_adjust_stock({id}, -1, 'cross status probe', 'key-adv-xs-0001')$q$, tests.nv('adv_k')), 'P0001|not_found|', 'B probing the suspended A ingredient gets not_found, not tenant_suspended (A''s status does not leak)');
select tests.clear_auth();
update public.restaurants set status = 'active' where id = (select a from _f);

select finish();
rollback;
