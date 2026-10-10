-- Phase 4 (migration 0030): the order pipeline and the order lifecycle commands.
-- fn_submit_order (server pricing / VAT / totals / snapshots / per-line station routing / idempotency / open day / plan limit / recipe
-- consumption / table state / audit), fn_cancel_order (rules, compensating reversal, replay), fn_set_station_items_status (KDS start /
-- ready, station authorisation, rollup), fn_serve_order, station-scoped reads, and the Phase-4 gate: the order lands correctly in
-- Postgres and the stock transaction is correct. Adversarial cases (IDOR / oracle / escalation / tenant status / closed day) are in 33_*.
begin;
select plan(142);

create temp table _f on commit drop as
select tests.tenant_id('central-cafe') a, tests.tenant_id('second-cafe') b,
       tests.user_id('selam', 'central-cafe') a_admin, tests.user_id('yonas', 'central-cafe') a_waiter,
       tests.user_id('meron', 'central-cafe') a_waiter2, tests.user_id('hanna', 'central-cafe') a_cashier,
       tests.user_id('abebe', 'central-cafe') a_kitchen, tests.user_id('sara', 'central-cafe') a_pastry,
       tests.user_id('kalkidan', 'central-cafe') a_bar,
       tests.user_id('owner', 'second-cafe') b_admin, tests.user_id('waiter', 'second-cafe') b_waiter;
grant all on _f to public;
create temp table _n (k text primary key, v text);
grant all on _n to public;
create function tests.nv(p_k text) returns uuid language sql stable as $$ select v::uuid from _n where k = p_k $$;
create function tests.jv(p_k text) returns jsonb language sql stable as $$ select v::jsonb from _n where k = p_k $$;
create function tests.ev(p_rid uuid, p_event text) returns int language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.audit_logs a where a.restaurant_id = p_rid and a.event = p_event $$;
create function tests.ledger_gap(p_rid uuid) returns bigint language sql stable security definer set search_path = '' as $$
  select count(*) from public.ingredients i
  where i.restaurant_id = p_rid and i.stock <> coalesce((select sum(m.qty_delta) from public.stock_movements m where m.ingredient_id = i.id), 0) $$;
create function tests.n_orders(p_rid uuid) returns int language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.orders where restaurant_id = p_rid $$;
create function tests.n_movs(p_rid uuid) returns int language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.stock_movements where restaurant_id = p_rid $$;
create function tests.order_row(p_id uuid) returns public.orders language sql stable security definer set search_path = '' as $$
  select * from public.orders where id = p_id $$;
create function tests.stock_of(p_ing uuid) returns numeric language sql stable security definer set search_path = '' as $$
  select stock from public.ingredients where id = p_ing $$;
create function tests.lines(p_order uuid) returns text language sql stable security definer set search_path = '' as $$
  select string_agg(name_snapshot || ':' || item_status, ',' order by line_no) from public.order_items where order_id = p_order $$;
-- cart helper: [{menu_item_id, qty}] from "name:qty" pairs of tenant A
create function tests.cart(p_spec text[]) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_agg(jsonb_build_object('menu_item_id', m.id, 'qty', split_part(s, ':', 2)::int) order by o)
  from unnest(p_spec) with ordinality u(s, o)
  join public.menu_items m on m.name = split_part(s, ':', 1)
   and m.restaurant_id = (select id from public.restaurants where slug = 'central-cafe') $$;
grant execute on all functions in schema tests to public;

insert into _n select 'a_day', (select id::text from public.day_sessions where restaurant_id = (select a from _f) and status = 'open');
insert into _n select 'a_kit', (select id::text from public.stations where restaurant_id = (select a from _f) and name = 'Kitchen');
insert into _n select 'a_bar', (select id::text from public.stations where restaurant_id = (select a from _f) and name = 'Bar');
insert into _n select 'a_pas', (select id::text from public.stations where restaurant_id = (select a from _f) and name = 'Pastry');
insert into _n select 'b_kit', (select id::text from public.stations where restaurant_id = (select b from _f) and name = 'Kitchen');
insert into _n select 't01', (select id::text from public.tables where restaurant_id = (select a from _f) and label = 'T01');
insert into _n select 'b01', (select id::text from public.tables where restaurant_id = (select b from _f) and label = 'B01');
insert into _n select 'doro', (select id::text from public.menu_items where restaurant_id = (select a from _f) and name = 'Doro Wat');
insert into _n select 'b_menu', (select id::text from public.menu_items where restaurant_id = (select b from _f) limit 1);
create temp table _stock0 on commit drop as select id, stock from public.ingredients where restaurant_id = (select a from _f);
grant all on _stock0 to public;
-- ═════════ structure and privileges ═════════
select is((select count(*)::int from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosecdef and p.proconfig @> array['search_path=""']
           and p.proname in ('fn_order_json','fn_order_create','fn_order_visible','fn_submit_order','fn_cancel_order','fn_set_station_items_status','fn_serve_order')),
          7, 'all 7 new functions: security definer with a pinned empty search_path');
select is((select string_agg(p.proname, ',' order by p.proname) from pg_proc p where p.pronamespace = 'public'::regnamespace
           and p.proname in ('fn_order_json','fn_order_create','fn_order_visible','fn_submit_order','fn_cancel_order','fn_set_station_items_status','fn_serve_order')
           and has_function_privilege('authenticated', p.oid, 'execute')),
          'fn_cancel_order,fn_serve_order,fn_set_station_items_status,fn_submit_order', 'authenticated executes exactly the 4 commands');
select is((select string_agg(p.proname, ',' order by p.proname) from pg_proc p where p.pronamespace = 'public'::regnamespace
           and p.proname in ('fn_order_json','fn_order_create','fn_order_visible','fn_submit_order','fn_cancel_order','fn_set_station_items_status','fn_serve_order')
           and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('public', p.oid, 'execute')
                or (p.proname in ('fn_order_json','fn_order_create','fn_order_visible') and (has_function_privilege('authenticated', p.oid, 'execute')
                                                                                          or has_function_privilege('service_role', p.oid, 'execute'))))),
          null, 'anon / PUBLIC execute nothing; the pipeline core, json and visibility helpers have no client EXECUTE (QR will reach the core only through a definer entry point)');
select is((select string_agg(t || ':' || p, ',' order by t, p) from unnest(array['orders', 'order_items']) t, unnest(array['insert', 'update', 'delete']) p
           where case when p = 'delete' then has_table_privilege('authenticated', ('public.' || t)::regclass, p)
                      else has_any_column_privilege('authenticated', ('public.' || t)::regclass, p) end),
          null, 'orders / order_items: no client INSERT / UPDATE / DELETE; the RPCs are the only write path');
select is((select string_agg(tablename, ',' order by tablename) from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public'
           and tablename in ('orders', 'order_items')), 'order_items,orders', 'Realtime publishes orders and order_items (KDS / cashier / dashboard / order-fired sound)');
select ok(exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'order_items' and 'station_id' = any (attnames))
          and exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'orders' and 'status' = any (attnames)),
          'the station id of a line and the order status are in the stream (the receiving station is a UUID on the line)');

-- ═════════ submit: happy path ═════════
select tests.authenticate_as((select a_waiter from _f));
insert into _n select 'o1', public.fn_submit_order(tests.cart(array['Doro Wat:2', 'Macchiato:3', 'Cheesecake:1']),
                                                   'pos-key-0000-0001', 'dine-in', tests.nv('t01'), '  window seat  ')::text;
select tests.clear_auth();
insert into _n select 'o1_id', tests.jv('o1') ->> 'id';
select matches(tests.jv('o1') ->> 'order_no', '^ORD-[0-9]{4,}$', 'order number is server-generated (ORD-nnnn)');
select is(tests.jv('o1') ->> 'status', 'submitted', 'new order is submitted');
select is(tests.jv('o1') ->> 'payment_status', 'unpaid', 'and unpaid');
select is((tests.jv('o1') ->> 'subtotal')::numeric,
          (select sum(m.price * x.q) from (values ('Doro Wat', 2), ('Macchiato', 3), ('Cheesecake', 1)) x(n, q)
           join public.menu_items m on m.name = x.n and m.restaurant_id = (select a from _f)), 'subtotal = sum(menu price x qty) from menu_items (server-side)');
select is((tests.jv('o1') ->> 'vat_rate')::numeric, (select vat_rate from public.restaurants where id = (select a from _f)), 'VAT rate snapshot = restaurants.vat_rate');
select is((tests.jv('o1') ->> 'vat_amount')::numeric, round((tests.jv('o1') ->> 'subtotal')::numeric * 15 / 100, 2), 'VAT = round(subtotal x rate / 100, 2)');
select is((tests.jv('o1') ->> 'total')::numeric, (tests.jv('o1') ->> 'subtotal')::numeric + (tests.jv('o1') ->> 'vat_amount')::numeric, 'total = subtotal + VAT');
select is((select o.total from public.orders o where o.id = tests.nv('o1_id')), (tests.jv('o1') ->> 'total')::numeric, 'the stored order has the same total');
select is((select o.restaurant_id from public.orders o where o.id = tests.nv('o1_id')), (select a from _f), 'tenant comes from the identity');
select is((select o.created_by from public.orders o where o.id = tests.nv('o1_id')), (select a_waiter from _f), 'created_by = the caller');
select is((select o.created_by_name_snapshot from public.orders o where o.id = tests.nv('o1_id')), 'Yonas Tesfaye', 'creator name snapshot = short name (First + Middle)');
select is((select o.day_session_id from public.orders o where o.id = tests.nv('o1_id')), tests.nv('a_day'), 'order belongs to the open business day');
select is((select o.client_key from public.orders o where o.id = tests.nv('o1_id')), 'pos-key-0000-0001', 'the idempotency key is stored on the order (tenant-unique backstop)');
select is((select o.customer_note from public.orders o where o.id = tests.nv('o1_id')), 'window seat', 'customer note is trimmed');
select is((select o.table_label_snapshot || '|' || o.table_id from public.orders o where o.id = tests.nv('o1_id')), 'T01|' || tests.nv('t01'), 'table id + label snapshot');
select is((select status from public.tables where id = tests.nv('t01')), 'occupied', 'an available table becomes occupied');
select is((select count(*)::int from public.order_items where order_id = tests.nv('o1_id')), 3, 'three lines');
select is((select string_agg(name_snapshot || ':' || qty || ':' || line_no, ',' order by line_no) from public.order_items where order_id = tests.nv('o1_id')),
          'Doro Wat:2:1,Macchiato:3:2,Cheesecake:1:3', 'line order = cart order (line_no), name snapshot, qty');
select is((select count(*)::int from public.order_items oi join public.menu_items m on m.id = oi.menu_item_id
           where oi.order_id = tests.nv('o1_id') and oi.station_id = m.station_id and oi.price_snapshot = m.price), 3,
          'per-line station routing: each line goes to its menu item''s station; price snapshot = menu price');
select is((select string_agg(oi.station_name_snapshot, ',' order by line_no) from public.order_items oi where oi.order_id = tests.nv('o1_id')),
          'Kitchen,Bar,Pastry', 'station name snapshots come from the stations rows');
select is((select array_length(station_ids, 1) from public.orders where id = tests.nv('o1_id')), 3, 'orders.station_ids holds the 3 stations (RLS / KDS)');
select is((select count(*)::int from public.order_items where order_id = tests.nv('o1_id') and item_status = 'pending'), 3, 'all lines pending');
-- stock: one consumed row per (line, recipe line); every ingredient moved by exactly sum(qty_per_serving x qty)
select is((select count(*)::int from public.stock_movements where order_id = tests.nv('o1_id') and reason = 'consumed'),
          (select count(*)::int from public.order_items oi join public.recipe_lines rl on rl.menu_item_id = oi.menu_item_id where oi.order_id = tests.nv('o1_id')),
          'one consumed ledger row per recipe line of each order line');
select is((select count(*)::int from public.ingredients i join _stock0 s on s.id = i.id
           where i.stock <> s.stock - coalesce((select sum(rl.qty_per_serving * oi.qty) from public.order_items oi
                                                join public.recipe_lines rl on rl.menu_item_id = oi.menu_item_id and rl.ingredient_id = i.id
                                                where oi.order_id = tests.nv('o1_id')), 0)), 0,
          'every ingredient decreased by exactly sum(qty_per_serving x qty) (Phase-4 gate: stock transaction correct)');
select is(tests.ledger_gap((select a from _f)), 0::bigint, 'on-hand = sum(ledger) for every ingredient');
select is((select count(*)::int from public.stock_movements where order_id = tests.nv('o1_id') and (created_by is distinct from (select a_waiter from _f)
           or day_session_id is distinct from tests.nv('a_day'))), 0, 'ledger rows: actor = waiter, day = open day');
select is((select stock_consumed from public.orders where id = tests.nv('o1_id')), true, 'stock_consumed = true');
select is(tests.ev((select a from _f), 'order.submitted'), 1, 'audit event order.submitted');
select is((select (new_data ->> 'order_id') from public.audit_logs where restaurant_id = (select a from _f) and event = 'order.submitted'),
          tests.nv('o1_id')::text, 'audit names the order');
select is((select count(*)::int from public.idempotency_keys where restaurant_id = (select a from _f) and key = 'pos-key-0000-0001' and command = 'order.submit'),
          1, 'idempotency key recorded (tenant-scoped)');
select is(tests.jv('o1') ->> 'replayed', 'false', 'first execution: replayed = false');
select is(jsonb_array_length(tests.jv('o1') -> 'items'), 3, 'the result carries the lines');

-- ═════════ idempotency ═════════
create temp table _cnt on commit drop as select tests.n_orders((select a from _f)) o, tests.n_movs((select a from _f)) m, tests.ev((select a from _f), 'order.submitted') e;
grant all on _cnt to public;
select tests.authenticate_as((select a_waiter from _f));
insert into _n select 'o1r', public.fn_submit_order(tests.cart(array['Doro Wat:2', 'Macchiato:3', 'Cheesecake:1']), 'pos-key-0000-0001', 'dine-in', tests.nv('t01'), 'window seat')::text;
select is(tests.jv('o1r') ->> 'id', tests.nv('o1_id')::text, 'replay (same key, same payload): the SAME order');
select is(tests.jv('o1r') ->> 'replayed', 'true', 'replay is flagged');
select is(tests.n_orders((select a from _f)) || '|' || tests.n_movs((select a from _f)) || '|' || tests.ev((select a from _f), 'order.submitted'),
          (select o || '|' || m || '|' || e from _cnt), 'replay: no new order, no new stock movement, no new audit row');
select is(tests.run(format($q$select public.fn_submit_order(%L, 'pos-key-0000-0001', 'dine-in', %L, 'window seat')$q$, tests.cart(array['Doro Wat:3', 'Macchiato:3', 'Cheesecake:1']), tests.nv('t01'))),
          'P0001|idempotency_conflict|', 'same key, different payload (qty) -> idempotency_conflict');
select is(tests.run(format($q$select public.fn_submit_order(%L, 'pos-key-0000-0001', 'takeaway', %L, 'window seat')$q$, tests.cart(array['Doro Wat:2', 'Macchiato:3', 'Cheesecake:1']), tests.nv('t01'))),
          'P0001|idempotency_conflict|', 'same key, different order type -> idempotency_conflict');
select tests.clear_auth();
select tests.authenticate_as((select a_waiter2 from _f));
select is(tests.run(format($q$select public.fn_submit_order(%L, 'pos-key-0000-0001', 'dine-in', %L, 'window seat')$q$, tests.cart(array['Doro Wat:2', 'Macchiato:3', 'Cheesecake:1']), tests.nv('t01'))),
          'P0001|idempotency_conflict|', 'another waiter replaying the same key and payload -> conflict (never someone else''s order)');
select tests.clear_auth();
select tests.authenticate_as((select b_waiter from _f));
select is((public.fn_submit_order(jsonb_build_array(jsonb_build_object('menu_item_id', tests.nv('b_menu'), 'qty', 1)), 'pos-key-0000-0001') ->> 'replayed'), 'false',
          'the same key in ANOTHER tenant is independent (tenant-scoped uniqueness)');
select tests.clear_auth();
select is(tests.n_orders((select a from _f)), (select o from _cnt), 'tenant A still has the same number of orders');
create temp table _snap on commit drop as select tests.snapshot((select b from _f)) b;
grant all on _snap to public;

-- ═════════ submit: validation (no row is ever written by a refused call) ═════════
select tests.authenticate_as((select a_waiter from _f));
select is(tests.run($q$select public.fn_submit_order('[]', 'pos-key-val-0001')$q$), 'P0001|invalid_input|items', 'empty cart');
select is(tests.run($q$select public.fn_submit_order('{}', 'pos-key-val-0002')$q$), 'P0001|invalid_input|items', 'cart not an array');
select is(tests.run($q$select public.fn_submit_order(null, 'pos-key-val-0003')$q$), 'P0001|invalid_input|items', 'null cart');
select is(tests.run(format($q$select public.fn_submit_order((select jsonb_agg(x) from jsonb_array_elements(%L::jsonb) x, generate_series(1, 51)), 'pos-key-val-0004')$q$, tests.cart(array['Doro Wat:1']))),
          'P0001|invalid_input|items', 'more than 50 lines');
select is(tests.run(format($q$select public.fn_submit_order(%L, 'pos-key-val-0005')$q$, tests.cart(array['Doro Wat:0']))), 'P0001|invalid_input|qty', 'qty 0');
select is(tests.run(format($q$select public.fn_submit_order(%L, 'pos-key-val-0006')$q$, tests.cart(array['Doro Wat:100']))), 'P0001|invalid_input|qty', 'qty 100');
select is(tests.run(format($q$select public.fn_submit_order('[{"menu_item_id": "%s", "qty": 1.5}]', 'pos-key-val-0007')$q$, tests.nv('doro'))), 'P0001|invalid_input|qty', 'fractional qty');
select is(tests.run(format($q$select public.fn_submit_order('[{"menu_item_id": "%s", "qty": "2"}]', 'pos-key-val-0008')$q$, tests.nv('doro'))), 'P0001|invalid_input|qty', 'qty as a string');
select is(tests.run(format($q$select public.fn_submit_order('[{"menu_item_id": "%s", "qty": 1, "price": 0.01}]', 'pos-key-val-0009')$q$, tests.nv('doro'))),
          'P0001|invalid_input|items', 'a client price is refused (closed key list; the server prices)');
select is(tests.run(format($q$select public.fn_submit_order('[{"menu_item_id": "%s", "qty": 1, "restaurant_id": "%s"}]', 'pos-key-val-0010')$q$, tests.nv('doro'), (select b from _f))),
          'P0001|invalid_input|items', 'a client tenant id is refused');
select is(tests.run(format($q$select public.fn_submit_order('[{"menu_item_id": "%s", "qty": 1, "station_id": "%s"}]', 'pos-key-val-0011')$q$, tests.nv('doro'), tests.nv('a_bar'))),
          'P0001|invalid_input|items', 'a client station is refused (routing comes from the menu item)');
select is(tests.run($q$select public.fn_submit_order('[{"menu_item_id": "not-a-uuid", "qty": 1}]', 'pos-key-val-0012')$q$), 'P0001|invalid_input|menu_item_id', 'malformed menu item id');
select is(tests.run(format($q$select public.fn_submit_order('[{"menu_item_id": "%s", "qty": 1, "note": "%s"}]', 'pos-key-val-0013')$q$, tests.nv('doro'), repeat('n', 201))), 'P0001|invalid_input|note', 'note > 200 chars');
select is(tests.run(format($q$select public.fn_submit_order('[{"menu_item_id": "%s", "qty": 1, "note": 5}]', 'pos-key-val-0014')$q$, tests.nv('doro'))), 'P0001|invalid_input|note', 'note must be a string');
select is(tests.run(format($q$select public.fn_submit_order(%L, 'pos-key-val-0015', 'drive-thru')$q$, tests.cart(array['Doro Wat:1']))), 'P0001|invalid_input|order_type', 'unknown order type');
select is(tests.run(format($q$select public.fn_submit_order(%L, 'pos-key-val-0016', 'dine-in', null, %L)$q$, tests.cart(array['Doro Wat:1']), repeat('c', 301))), 'P0001|invalid_input|customer_note', 'customer note > 300');
select is(tests.run(format($q$select public.fn_submit_order(%L, 'short')$q$, tests.cart(array['Doro Wat:1']))), 'P0001|invalid_input|idempotency_key', 'idempotency key too short');
select is(tests.run(format($q$select public.fn_submit_order(%L, null)$q$, tests.cart(array['Doro Wat:1']))), 'P0001|invalid_input|idempotency_key', 'idempotency key missing');
select is(tests.run(format($q$select public.fn_submit_order('[{"menu_item_id": "%s", "qty": 1}]', 'pos-key-val-0017')$q$, gen_random_uuid())), 'P0001|invalid_input|menu_item_id', 'unknown menu item');
select is(tests.run(format($q$select public.fn_submit_order('[{"menu_item_id": "%s", "qty": 1}]', 'pos-key-val-0018')$q$, tests.nv('b_menu'))), 'P0001|invalid_input|menu_item_id', 'foreign-tenant menu item = same answer as unknown');
select is(tests.run(format($q$select public.fn_submit_order(%L, 'pos-key-val-0019', 'dine-in', %L)$q$, tests.cart(array['Doro Wat:1']), tests.nv('b01'))), 'P0001|invalid_input|table_id', 'foreign-tenant table refused');
select is(tests.run(format($q$select public.fn_submit_order(%L, 'pos-key-val-0020', 'dine-in', %L)$q$, tests.cart(array['Doro Wat:1']), gen_random_uuid())), 'P0001|invalid_input|table_id', 'unknown table = same answer');
select tests.clear_auth();
select is(tests.n_orders((select a from _f)) || '|' || tests.n_movs((select a from _f)), (select o || '|' || m from _cnt), 'refused submits wrote no order and no stock movement');
select is((select count(*)::int from public.idempotency_keys where restaurant_id = (select a from _f) and key like 'pos-key-val-%'), 0, '... and left no idempotency key behind (rolled back)');

-- unavailable items: inactive item / station / category (detail = the tenant's own item name)
update public.menu_items set is_active = false where id = tests.nv('doro');
select tests.authenticate_as((select a_waiter from _f));
select is(tests.run(format($q$select public.fn_submit_order(%L, 'pos-key-una-0001')$q$, tests.cart(array['Macchiato:1', 'Doro Wat:1']))), 'P0001|item_unavailable|Doro Wat', 'inactive menu item -> item_unavailable (own item name)');
select tests.clear_auth();
update public.menu_items set is_active = true where id = tests.nv('doro');
update public.stations set is_active = false where id = tests.nv('a_bar');
select tests.authenticate_as((select a_waiter from _f));
select is(tests.run(format($q$select public.fn_submit_order(%L, 'pos-key-una-0002')$q$, tests.cart(array['Macchiato:1']))), 'P0001|item_unavailable|Macchiato', 'item whose station is inactive -> item_unavailable');
select tests.clear_auth();
update public.stations set is_active = true where id = tests.nv('a_bar');
update public.categories set is_active = false where restaurant_id = (select a from _f) and name = 'Beverages';
select tests.authenticate_as((select a_waiter from _f));
select is(tests.run(format($q$select public.fn_submit_order(%L, 'pos-key-una-0003')$q$, tests.cart(array['Macchiato:1']))), 'P0001|item_unavailable|Macchiato', 'item whose category is inactive -> item_unavailable');
select tests.clear_auth();
update public.categories set is_active = true where restaurant_id = (select a from _f) and name = 'Beverages';
update public.tables set status = 'out_of_service' where restaurant_id = (select a from _f) and label = 'T02';
select tests.authenticate_as((select a_waiter from _f));
select is(tests.run(format($q$select public.fn_submit_order(%L, 'pos-key-una-0004', 'dine-in', (select id from public.tables where label = 'T02'))$q$, tests.cart(array['Macchiato:1']))),
          'P0001|invalid_state|table_unavailable', 'out-of-service table refused');
select tests.clear_auth();

-- ═════════ price snapshot survives a menu price change; takeaway without table ═════════
update public.menu_items set price = 999 where id = tests.nv('doro');
select is((select price_snapshot from public.order_items where order_id = tests.nv('o1_id') and menu_item_id = tests.nv('doro')), 420.00::numeric, 'price snapshot unchanged by a later price edit');
select tests.authenticate_as((select a_waiter from _f));
insert into _n select 'o2', public.fn_submit_order(tests.cart(array['Doro Wat:1']), 'pos-key-0000-0002', 'takeaway')::text;
select tests.clear_auth();
insert into _n select 'o2_id', tests.jv('o2') ->> 'id';
select is((tests.jv('o2') ->> 'subtotal')::numeric, 999.00::numeric, 'a new order uses the CURRENT menu price');
select is((tests.jv('o2') ->> 'vat_amount')::numeric, 149.85::numeric, 'VAT rounded to 2 decimals (999 x 15% = 149.85)');
select is((select table_id from public.orders where id = tests.nv('o2_id')), null, 'takeaway without a table');
select is((select order_type from public.orders where id = tests.nv('o2_id')), 'takeaway', 'order type stored');
select cmp_ok(substring(tests.jv('o2') ->> 'order_no' from 5)::int, '=', substring(tests.jv('o1') ->> 'order_no' from 5)::int + 1, 'order numbers are sequential per tenant (no gap after refused submits)');

-- ═════════ auto_consume_stock off: no ledger rows ═════════
update public.restaurants set auto_consume_stock = false where id = (select a from _f);
select tests.authenticate_as((select a_waiter from _f));
insert into _n select 'o3', public.fn_submit_order(tests.cart(array['Macchiato:1']), 'pos-key-0000-0003')::text;
select tests.clear_auth();
update public.restaurants set auto_consume_stock = true where id = (select a from _f);
select is((select count(*)::int from public.stock_movements where order_id = (tests.jv('o3') ->> 'id')::uuid), 0, 'auto_consume_stock = false: no consumption');
select is(tests.jv('o3') ->> 'stock_consumed', 'false', '... and stock_consumed = false');

-- ═════════ insufficient stock: atomic rollback ═════════
insert into public.ingredients (restaurant_id, name, station_id, unit, stock, opening_stock) select a, 'Scarce Saffron', tests.nv('a_kit'), 'g', 1, 1 from _f;
insert into _n select 'saffron', (select id::text from public.ingredients where name = 'Scarce Saffron');
insert into public.stock_movements (restaurant_id, ingredient_id, station_id, qty_delta, reason, day_session_id)
select a, tests.nv('saffron'), tests.nv('a_kit'), 1, 'opening', tests.nv('a_day') from _f;
insert into public.menu_items (restaurant_id, name, category_id, station_id, price)
select a, 'Saffron Rice', (select id from public.categories where restaurant_id = a and name = 'Lunch'), tests.nv('a_kit'), 300 from _f;
insert into public.recipe_lines (restaurant_id, menu_item_id, ingredient_id, qty_per_serving)
select a, (select id from public.menu_items where name = 'Saffron Rice'), tests.nv('saffron'), 1 from _f;
create temp table _cnt2 on commit drop as
select tests.n_orders((select a from _f)) o, tests.n_movs((select a from _f)) m,
       (select last_value from public.tenant_counters where restaurant_id = (select a from _f) and counter_key = 'order') c,
       (select stock from public.ingredients where restaurant_id = (select a from _f) and name = 'Onion') onion;
grant all on _cnt2 to public;
select tests.authenticate_as((select a_waiter from _f));
select is(tests.run(format($q$select public.fn_submit_order(%L, 'pos-key-ins-0001')$q$, tests.cart(array['Saffron Rice:2']))), 'P0001|insufficient_stock|Scarce Saffron',
          'one line needing more than on hand -> insufficient_stock (own ingredient name)');
select is(tests.run(format($q$select public.fn_submit_order(%L, 'pos-key-ins-0002')$q$, tests.cart(array['Doro Wat:1', 'Saffron Rice:1', 'Saffron Rice:1']))), 'P0001|insufficient_stock|Scarce Saffron',
          'demand summed over two lines of the same item exceeds stock -> insufficient_stock');
select tests.clear_auth();
select is(tests.n_orders((select a from _f)) || '|' || tests.n_movs((select a from _f)), (select o || '|' || m from _cnt2), 'atomic: no order, no ledger row (the Doro Wat line consumed nothing either)');
select is((select stock from public.ingredients where restaurant_id = (select a from _f) and name = 'Onion'), (select onion from _cnt2), 'atomic: the other line''s ingredients are unchanged');
select is((select last_value from public.tenant_counters where restaurant_id = (select a from _f) and counter_key = 'order'), (select c from _cnt2), 'atomic: the order counter did not move');
select is(tests.stock_of(tests.nv('saffron')), 1.000::numeric, 'scarce ingredient untouched');
select tests.authenticate_as((select a_waiter from _f));
select is((public.fn_submit_order(tests.cart(array['Saffron Rice:1']), 'pos-key-ins-0003') ->> 'status'), 'submitted', 'exactly the available stock: accepted');
select tests.clear_auth();
select is(tests.stock_of(tests.nv('saffron')), 0.000::numeric, 'stock reaches exactly zero, never below');
select is(tests.ledger_gap((select a from _f)), 0::bigint, 'ledger still consistent');

-- ═════════ permissions ═════════
select tests.authenticate_as((select a_kitchen from _f));
select is(tests.run(format($q$select public.fn_submit_order(%L, 'pos-key-prm-0001')$q$, tests.cart(array['Macchiato:1']))), 'P0001|permission_denied|', 'kitchen (no orders.create) cannot submit');
select tests.clear_auth();
select tests.authenticate_as((select a_cashier from _f));
select is(tests.run(format($q$select public.fn_submit_order(%L, 'pos-key-prm-0002')$q$, tests.cart(array['Macchiato:1']))), 'P0001|permission_denied|', 'cashier (no orders.create) cannot submit');
select tests.clear_auth();
select tests.authenticate_as((select a_admin from _f));
select is((public.fn_submit_order(tests.cart(array['Macchiato:1']), 'pos-key-adm-0001') ->> 'status'), 'submitted', 'tenant_admin can submit');
select tests.clear_auth();

-- ═════════ station workflow (KDS) ═════════
select tests.authenticate_as((select a_kitchen from _f));
select is(tests.run(format($q$select public.fn_set_station_items_status(%L, %L, 'preparing')$q$, tests.nv('o1_id'), tests.nv('a_bar'))), 'P0001|permission_denied|station',
          'Kitchen operator naming the Bar station -> permission_denied (no request-data escalation)');
select is(tests.run(format($q$select public.fn_set_station_items_status(%L, %L, 'preparing')$q$, tests.nv('o1_id'), tests.nv('b_kit'))), 'P0001|permission_denied|station',
          'a foreign-tenant station id -> permission_denied');
select is(tests.run(format($q$select public.fn_set_station_items_status(%L, %L, 'served')$q$, tests.nv('o1_id'), tests.nv('a_kit'))), 'P0001|invalid_input|status', 'only preparing / ready');
select is(tests.run(format($q$select public.fn_set_station_items_status(%L, %L, 'preparing')$q$, (tests.jv('o3') ->> 'id'), tests.nv('a_kit'))), 'P0001|not_found|',
          'an order with no line at the station -> not_found');
insert into _n select 'k1', public.fn_set_station_items_status(tests.nv('o1_id'), tests.nv('a_kit'), 'preparing')::text;
select is((select string_agg(x ->> 'name', ',') from jsonb_array_elements(tests.jv('k1') -> 'items') x), 'Doro Wat', 'start returns only the station''s own lines');
select is(tests.lines(tests.nv('o1_id')),
          'Doro Wat:preparing,Macchiato:pending,Cheesecake:pending', 'start: only the Kitchen lines move to preparing');
select is((select status from public.orders where id = tests.nv('o1_id')), 'preparing', 'start rolls the order up to preparing');
select isnt((select started_at from public.order_items where order_id = tests.nv('o1_id') and station_id = tests.nv('a_kit')), null, 'started_at stamped');
select is(tests.run(format($q$select public.fn_set_station_items_status(%L, %L, 'preparing')$q$, tests.nv('o1_id'), tests.nv('a_kit'))), 'P0001|invalid_state_transition|no_lines_to_preparing',
          'starting twice -> invalid_state_transition');
select is((public.fn_set_station_items_status(tests.nv('o1_id'), tests.nv('a_kit'), 'ready') -> 'items' -> 0 ->> 'item_status'), 'ready', 'Kitchen marks its lines ready');
select is((select status from public.orders where id = tests.nv('o1_id')), 'preparing', 'order stays preparing while other stations are pending');
select tests.clear_auth();
select tests.authenticate_as((select a_pastry from _f));
select is((public.fn_set_station_items_status(tests.nv('o1_id'), tests.nv('a_pas'), 'ready') -> 'items' -> 0 ->> 'item_status'), 'ready', 'Pastry: pending -> ready directly');
select tests.clear_auth();
select tests.authenticate_as((select a_waiter from _f));
select is(tests.run(format($q$select public.fn_serve_order(%L)$q$, tests.nv('o1_id'))), 'P0001|invalid_state_transition|order_preparing', 'serve before ready -> invalid_state_transition');
select is(tests.run(format($q$select public.fn_set_station_items_status(%L, %L, 'ready')$q$, tests.nv('o1_id'), tests.nv('a_bar'))), 'P0001|permission_denied|station',
          'a waiter (no station access) cannot drive the KDS');
select tests.clear_auth();
select tests.authenticate_as((select a_bar from _f));
select is((public.fn_set_station_items_status(tests.nv('o1_id'), tests.nv('a_bar'), 'ready') ->> 'status'), 'ready', 'last station ready -> the ORDER is ready');
select tests.clear_auth();
select isnt((select ready_at from public.orders where id = tests.nv('o1_id')), null, 'order ready_at stamped');
select is(tests.ev((select a from _f), 'order.station_status'), 4, 'audit event per station action');

-- ═════════ serve ═════════
select tests.authenticate_as((select a_waiter2 from _f));
select is(tests.run(format($q$select public.fn_serve_order(%L)$q$, tests.nv('o1_id'))), 'P0001|not_found|', 'another waiter cannot serve my order (not_found, no oracle)');
select tests.clear_auth();
select tests.authenticate_as((select a_kitchen from _f));
select is(tests.run(format($q$select public.fn_serve_order(%L)$q$, tests.nv('o1_id'))), 'P0001|permission_denied|', 'kitchen (no orders.create) cannot serve');
select tests.clear_auth();
select tests.authenticate_as((select a_waiter from _f));
select is((public.fn_serve_order(tests.nv('o1_id')) ->> 'status'), 'served', 'the waiter serves the ready order');
select is((select count(*)::int from public.order_items where order_id = tests.nv('o1_id') and item_status = 'served'), 3, 'all lines served');
select is(tests.run(format($q$select public.fn_serve_order(%L)$q$, tests.nv('o1_id'))), 'P0001|invalid_state_transition|order_served', 'serving twice -> invalid_state_transition');
select is(tests.run(format($q$select public.fn_set_station_items_status(%L, %L, 'ready')$q$, tests.nv('o1_id'), tests.nv('a_kit'))), 'P0001|permission_denied|station', '(waiter has no station anyway)');
select tests.clear_auth();
select tests.authenticate_as((select a_kitchen from _f));
select is(tests.run(format($q$select public.fn_set_station_items_status(%L, %L, 'ready')$q$, tests.nv('o1_id'), tests.nv('a_kit'))), 'P0001|invalid_state_transition|order_served', 'KDS cannot touch a served order');
select tests.clear_auth();
select is(tests.ev((select a from _f), 'order.served'), 1, 'audit event order.served');

-- ═════════ cancel ═════════
select tests.authenticate_as((select a_waiter from _f));
select is(tests.run(format($q$select public.fn_cancel_order(%L)$q$, tests.nv('o1_id'))), 'P0001|order_not_cancellable|in_preparation', 'a served order cannot be cancelled');
insert into _n select 'o4', public.fn_submit_order(tests.cart(array['Doro Wat:1', 'Cheesecake:2']), 'pos-key-0000-0004')::text;
insert into _n select 'o4_id', tests.jv('o4') ->> 'id';
select tests.clear_auth();
create temp table _st4 on commit drop as select id, stock from public.ingredients where restaurant_id = (select a from _f);
grant all on _st4 to public;
create temp table _cons4 on commit drop as select ingredient_id, sum(qty_delta) q from public.stock_movements where order_id = tests.nv('o4_id') group by 1;
grant all on _cons4 to public;
select tests.authenticate_as((select a_waiter from _f));
select is(tests.run(format($q$select public.fn_cancel_order(%L, %L)$q$, tests.nv('o4_id'), repeat('r', 301))), 'P0001|invalid_input|reason', 'reason > 300 chars');
insert into _n select 'c4', public.fn_cancel_order(tests.nv('o4_id'), '  guest left ')::text;
select tests.clear_auth();
select is(tests.jv('c4') ->> 'status', 'cancelled', 'the waiter cancels an untouched, unpaid order of their own');
select is((tests.jv('c4') ->> 'reversed_movements')::int, (select count(*)::int from public.stock_movements where order_id = tests.nv('o4_id') and reason = 'consumed'),
          'one compensating reversal per consumption row');
select is((select count(*)::int from public.stock_movements m where m.order_id = tests.nv('o4_id') and m.reason = 'consumed'
           and not exists (select 1 from public.stock_movements x where x.reverses_movement_id = m.id)), 0, 'every consumption row is reversed (never edited)');
select is((select count(*)::int from public.ingredients i join _st4 s on s.id = i.id left join _cons4 c on c.ingredient_id = i.id
           where i.stock <> s.stock - coalesce(c.q, 0)), 0, 'stock is back to exactly its pre-order level');
select is(tests.ledger_gap((select a from _f)), 0::bigint, 'ledger consistent after the reversal');
select is((select status || '|' || cancel_reason || '|' || cancelled_by || '|' || stock_consumed from public.orders where id = tests.nv('o4_id')),
          'cancelled|guest left|' || (select a_waiter from _f) || '|false', 'order: cancelled, reason trimmed, cancelled_by = caller, stock_consumed = false');
select is((select count(*)::int from public.order_items where order_id = tests.nv('o4_id') and item_status = 'cancelled'), 2, 'lines cancelled');
select is(tests.ev((select a from _f), 'order.cancelled'), 1, 'audit event order.cancelled');
create temp table _cnt3 on commit drop as select tests.n_movs((select a from _f)) m;
grant all on _cnt3 to public;
select tests.authenticate_as((select a_waiter from _f));
insert into _n select 'c4r', public.fn_cancel_order(tests.nv('o4_id'))::text;
select tests.clear_auth();
select is(tests.jv('c4r') ->> 'already_cancelled', 'true', 'replayed cancel: a no-op flagged already_cancelled');
select is(tests.n_movs((select a from _f)) || '|' || tests.ev((select a from _f), 'order.cancelled'), (select m from _cnt3) || '|1', 'replayed cancel: no second reversal, no second audit row');
select tests.authenticate_as((select a_kitchen from _f));
select is(tests.run(format($q$select public.fn_set_station_items_status(%L, %L, 'preparing')$q$, tests.nv('o4_id'), tests.nv('a_kit'))), 'P0001|invalid_state_transition|order_cancelled',
          'KDS cannot start a cancelled order');
select tests.clear_auth();

-- ═════════ station-scoped reads (RLS) ═════════
select tests.authenticate_as((select a_kitchen from _f));
select is((select count(*)::int from public.order_items where order_id = tests.nv('o1_id')), 1, 'kitchen reads only its own line of a multi-station order');
select is((select count(*)::int from public.orders where id = tests.nv('o1_id')), 1, '... and the order header');
select is((select count(*)::int from public.orders where id = (tests.jv('o3') ->> 'id')::uuid), 0, 'kitchen does not see a bar-only order');
select tests.clear_auth();
select tests.authenticate_as((select a_waiter2 from _f));
select is((select count(*)::int from public.orders where created_by = (select a_waiter from _f)), 0, 'a waiter does not read another waiter''s orders');
select tests.clear_auth();
select tests.authenticate_as((select b_admin from _f));
select is((select count(*)::int from public.orders where restaurant_id = (select a from _f)) + (select count(*)::int from public.order_items where restaurant_id = (select a from _f)), 0,
          'another tenant''s admin reads none of tenant A''s orders or lines');
select tests.clear_auth();

-- ═════════ generalization: a brand-new station / role works without code knowing its name ═════════
insert into public.stations (restaurant_id, name, color, icon) select a, 'Grill', '#b45309', 'flame' from _f;
insert into _n select 'grill', (select id::text from public.stations where restaurant_id = (select a from _f) and name = 'Grill');
insert into public.roles (restaurant_id, name) select a, 'Runner' from _f;
insert into public.role_permissions (role_id, permission_id, restaurant_id)
select (select id from public.roles where restaurant_id = (select a from _f) and name = 'Runner'), p.id, (select a from _f) from public.permissions p where p.key = 'orders.view';
insert into public.role_station_access (role_id, station_id, restaurant_id)
select (select id from public.roles where restaurant_id = (select a from _f) and name = 'Runner'), tests.nv('grill'), (select a from _f);
update public.profiles set role_id = (select id from public.roles where restaurant_id = (select a from _f) and name = 'Runner') where id = (select a_kitchen from _f);
insert into public.menu_items (restaurant_id, name, category_id, station_id, price)
select a, 'Grilled Fish', (select id from public.categories where restaurant_id = a and name = 'Lunch'), tests.nv('grill'), 350 from _f;
select tests.authenticate_as((select a_waiter from _f));
insert into _n select 'o5', public.fn_submit_order(tests.cart(array['Grilled Fish:1', 'Macchiato:1']), 'pos-key-0000-0005')::text;
select tests.clear_auth();
select is((select station_id from public.order_items where order_id = (tests.jv('o5') ->> 'id')::uuid and name_snapshot = 'Grilled Fish'), tests.nv('grill'), 'a line for the new station is routed to it');
select tests.authenticate_as((select a_kitchen from _f));
select is((public.fn_set_station_items_status((tests.jv('o5') ->> 'id')::uuid, tests.nv('grill'), 'ready') -> 'items' -> 0 ->> 'name'), 'Grilled Fish', 'the Runner drives its brand-new station');
select is(tests.run(format($q$select public.fn_set_station_items_status(%L, %L, 'ready')$q$, (tests.jv('o5') ->> 'id'), tests.nv('a_bar'))), 'P0001|permission_denied|station', '... and nothing else');
select tests.clear_auth();

select is(tests.snapshot((select b from _f)), (select b from _snap), 'nothing tenant A did (orders, KDS, cancel, stock) changed any row of tenant B');
select is((select count(*)::int from public.orders where restaurant_id = (select b from _f)), 1, 'tenant B has exactly its own one order');

select * from finish();
rollback;
