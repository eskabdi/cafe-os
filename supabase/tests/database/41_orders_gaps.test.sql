-- Phase 4 (migration 0033, orders_pos) coverage gaps left by 39_orders_pos / 40_orders_adversarial:
--  * cross-tenant ids: a cart mixing an own and a foreign menu item, B -> A table, inactive own table (all = "unknown", no oracle)
--  * station access: inactive station (operator AND tenant_admin), revoked role_station_access, station access without orders.view,
--    line routing is a snapshot (moving a menu item to another station does not hand existing lines to the new station)
--  * permission edge cases on replay: orders.create WITHOUT orders.view gets only the minimal receipt; a caller who lost
--    orders.create gets nothing; cancel / serve without orders.view = not_found even for the creator
--  * a cancelled order: no "already_cancelled" oracle for another waiter or another tenant
--  * audit integrity: actor / tenant of every order event come from the identity; refused calls write no audit row;
--    order audit rows are readable only with audit.view inside the own tenant
begin;
select plan(29);

create temp table _f on commit drop as
select tests.tenant_id('central-cafe') a, tests.tenant_id('second-cafe') b,
       tests.user_id('selam', 'central-cafe') a_admin, tests.user_id('yonas', 'central-cafe') a_waiter,
       tests.user_id('meron', 'central-cafe') a_waiter2, tests.user_id('abebe', 'central-cafe') a_kitchen,
       tests.user_id('sara', 'central-cafe') a_pastry,
       tests.user_id('owner', 'second-cafe') b_admin, tests.user_id('waiter', 'second-cafe') b_waiter;
grant all on _f to public;
create temp table _n (k text primary key, v text);
grant all on _n to public;
create function tests.nv(p_k text) returns uuid language sql stable as $$ select v::uuid from _n where k = p_k $$;
create function tests.jv(p_k text) returns jsonb language sql stable as $$ select v::jsonb from _n where k = p_k $$;
create function tests.cart(p_slug text, p_spec text[]) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_agg(jsonb_build_object('menu_item_id', m.id, 'qty', split_part(s, ':', 2)::int) order by o)
  from unnest(p_spec) with ordinality u(s, o)
  join public.menu_items m on m.name = split_part(s, ':', 1) and m.restaurant_id = (select id from public.restaurants where slug = p_slug) $$;
create function tests.n_order_audit(p_rid uuid) returns int language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.audit_logs where restaurant_id = p_rid and event like 'order.%' $$;
create function tests.audit_of(p_rid uuid, p_event text, p_order uuid) returns text language sql stable security definer set search_path = '' as $$
  select string_agg(coalesce(actor_id::text, 'null') || '/' || actor_type, ',' order by created_at, id)
  from public.audit_logs where restaurant_id = p_rid and event = p_event and new_data ->> 'order_id' = p_order::text $$;
create function tests.keys_of(p_j jsonb) returns text language sql immutable as $$
  select string_agg(k, ',' order by k) from jsonb_object_keys(p_j) k $$;
grant execute on all functions in schema tests to public;

insert into _n select 'a_kit', (select id::text from public.stations where restaurant_id = (select a from _f) and name = 'Kitchen');
insert into _n select 'a_pas', (select id::text from public.stations where restaurant_id = (select a from _f) and name = 'Pastry');
insert into _n select 'doro', (select id::text from public.menu_items where restaurant_id = (select a from _f) and name = 'Doro Wat');
insert into _n select 'b_menu', (select id::text from public.menu_items where restaurant_id = (select b from _f) and name = 'Second Cafe Special');
insert into _n select 't01', (select id::text from public.tables where restaurant_id = (select a from _f) and label = 'T01');
insert into _n select 't03', (select id::text from public.tables where restaurant_id = (select a from _f) and label = 'T03');
insert into _n select 'kit_role', (select role_id::text from public.profiles where id = (select a_kitchen from _f));
insert into _n select 'wait_role', (select role_id::text from public.profiles where id = (select a_waiter from _f));

-- fixtures through the real pipeline
select tests.authenticate_as((select a_waiter from _f));
insert into _n select 'oa', public.fn_submit_order(tests.cart('central-cafe', array['Doro Wat:1', 'Macchiato:1']), 'gap-order-a-0001') ->> 'id';
insert into _n select 'ok', public.fn_submit_order(tests.cart('central-cafe', array['Doro Wat:1']), 'gap-order-k-0001') ->> 'id';
insert into _n select 'drain', public.fn_submit_order(tests.cart('central-cafe', array['Doro Wat:1']), 'gap-order-k-0002') ->> 'id';
insert into _n select 'oc', public.fn_submit_order(tests.cart('central-cafe', array['Shiro Wat:1']), 'gap-order-c-0001') ->> 'id';
select tests.clear_auth();
select tests.authenticate_as((select b_waiter from _f));
insert into _n select 'ob', public.fn_submit_order(tests.cart('second-cafe', array['Second Cafe Special:1']), 'gap-order-b-0001') ->> 'id';
select tests.clear_auth();
create temp table _aud on commit drop as select tests.n_order_audit((select a from _f)) a, tests.n_order_audit((select b from _f)) b;
grant all on _aud to public;

-- ═════════ cross-tenant ids in the cart / table (no existence oracle) ═════════
select tests.authenticate_as((select a_waiter from _f));
select is(tests.oracle(format($q$select public.fn_submit_order(jsonb_build_array(jsonb_build_object('menu_item_id', %L, 'qty', 1),
                                                                                 jsonb_build_object('menu_item_id', {id}, 'qty', 1)), 'gap-mix-0001')$q$, tests.nv('doro')),
                       tests.nv('b_menu')),
          'P0001|invalid_input|menu_item_id', 'a cart mixing an OWN item with a FOREIGN one is refused exactly like one with an unknown id');
select is(tests.oracle(format($q$select public.fn_submit_order(jsonb_build_array(jsonb_build_object('menu_item_id', %L, 'qty', 1),
                                                                                 jsonb_build_object('menu_item_id', %L, 'qty', 1),
                                                                                 jsonb_build_object('menu_item_id', {id}, 'qty', 1)), 'gap-mix-0002')$q$, tests.nv('doro'), tests.nv('doro')),
                       tests.nv('b_menu')),
          'P0001|invalid_input|menu_item_id', 'a repeated own item cannot mask a foreign one (distinct-id count)');
select tests.clear_auth();
update public.tables set is_active = false where id = tests.nv('t03');
select tests.authenticate_as((select a_waiter from _f));
select is(tests.run(format($q$select public.fn_submit_order(%L, 'gap-tbl-0001', 'dine-in', %L)$q$, tests.cart('central-cafe', array['Macchiato:1']), tests.nv('t03'))),
          'P0001|invalid_input|table_id', 'a deactivated own table is refused like an unknown one');
select tests.clear_auth();
update public.tables set is_active = true where id = tests.nv('t03');
select tests.authenticate_as((select b_waiter from _f));
select is(tests.oracle(format($q$select public.fn_submit_order(%L, 'gap-tbl-0002', 'dine-in', {id})$q$, tests.cart('second-cafe', array['Second Cafe Special:1'])),
                       tests.nv('t01')),
          'P0001|invalid_input|table_id', 'B waiter naming A''s table: same answer as an unknown table');
select is(tests.run(format($q$select public.fn_submit_order(%L, 'gap-order-a-0001')$q$, tests.cart('central-cafe', array['Doro Wat:1', 'Macchiato:1']))),
          'P0001|invalid_input|menu_item_id', 'B waiter replaying A''s key WITH A''s cart: refused as unknown items, never A''s order');
select tests.clear_auth();

-- ═════════ station access ═════════
update public.stations set is_active = false where id = tests.nv('a_kit');
select tests.authenticate_as((select a_kitchen from _f));
select is(tests.run(format($q$select public.fn_set_station_items_status(%L, %L, 'preparing')$q$, tests.nv('drain'), tests.nv('a_kit'))), 'ok:1',
          'a DEACTIVATED station still finishes the lines it already received (no order is stranded; it gets no new lines)');
select tests.clear_auth();
select tests.authenticate_as((select a_admin from _f));
select is(tests.run(format($q$select public.fn_set_station_items_status(%L, %L, 'preparing')$q$, tests.nv('drain'), tests.nv('a_kit'))), 'P0001|invalid_state_transition|no_lines_to_preparing',
          'and the started lines are not started twice');
select tests.clear_auth();
update public.stations set is_active = true where id = tests.nv('a_kit');
delete from public.role_station_access where role_id = tests.nv('kit_role') and station_id = tests.nv('a_kit');
select tests.authenticate_as((select a_kitchen from _f));
select is(tests.run(format($q$select public.fn_set_station_items_status(%L, %L, 'preparing')$q$, tests.nv('ok'), tests.nv('a_kit'))), 'P0001|permission_denied|station',
          'revoking the role''s station grant takes effect immediately');
select is((select count(*)::int from public.orders where id = tests.nv('ok')), 0, '... and the order is no longer readable by that operator');
select tests.clear_auth();
insert into public.role_station_access (role_id, station_id, restaurant_id) select tests.nv('kit_role'), tests.nv('a_kit'), a from _f;
delete from public.role_permissions where role_id = tests.nv('kit_role') and permission_id = (select id from public.permissions where key = 'orders.view');
select tests.authenticate_as((select a_kitchen from _f));
select is(tests.run(format($q$select public.fn_set_station_items_status(%L, %L, 'preparing')$q$, tests.nv('ok'), tests.nv('a_kit'))), 'P0001|permission_denied|',
          'station grant WITHOUT orders.view: permission_denied (the station is not a permission on its own)');
select tests.clear_auth();
insert into public.role_permissions (role_id, permission_id, restaurant_id)
select tests.nv('kit_role'), (select id from public.permissions where key = 'orders.view'), a from _f;
-- routing is a snapshot: moving Doro Wat to Pastry does not move the existing Kitchen line
update public.menu_items set station_id = tests.nv('a_pas') where id = tests.nv('doro');
select tests.authenticate_as((select a_pastry from _f));
select is(tests.oracle(format($q$select public.fn_set_station_items_status({id}, %L, 'preparing')$q$, tests.nv('a_pas')), tests.nv('ok')), 'P0001|not_found|',
          'menu item moved to Pastry: Pastry still has no line on the earlier order (no oracle)');
select tests.clear_auth();
select tests.authenticate_as((select a_kitchen from _f));
select is((public.fn_set_station_items_status(tests.nv('ok'), tests.nv('a_kit'), 'preparing') ->> 'status'), 'preparing',
          '... while Kitchen (restored grant + orders.view) still drives its snapshotted line');
select tests.clear_auth();
update public.menu_items set station_id = tests.nv('a_kit') where id = tests.nv('doro');

-- ═════════ permission edge cases on replay / own orders ═════════
delete from public.role_permissions where role_id = tests.nv('wait_role') and permission_id = (select id from public.permissions where key = 'orders.view');
select tests.authenticate_as((select a_waiter from _f));
insert into _n select 'nv1', public.fn_submit_order(tests.cart('central-cafe', array['Macchiato:1']), 'gap-noview-0001')::text;
insert into _n select 'nv1r', public.fn_submit_order(tests.cart('central-cafe', array['Macchiato:1']), 'gap-noview-0001')::text;
select is(tests.keys_of(tests.jv('nv1r')), 'id,order_no,replayed', 'orders.create WITHOUT orders.view: a replay returns only the minimal receipt (no lines, totals, notes)');
select is(tests.jv('nv1r') ->> 'id', tests.jv('nv1') ->> 'id', '... for the SAME order');
select is(tests.keys_of(public.fn_submit_order(tests.cart('central-cafe', array['Doro Wat:1', 'Macchiato:1']), 'gap-order-a-0001')), 'id,order_no,replayed',
          '... also for an order submitted while the caller still had orders.view');
select is(tests.oracle($q$select public.fn_cancel_order({id})$q$, tests.nv('oa')), 'P0001|not_found|', 'without orders.view the creator cannot cancel its own order (no oracle)');
select is(tests.oracle($q$select public.fn_serve_order({id})$q$, tests.nv('oa')), 'P0001|not_found|', 'without orders.view the creator cannot serve its own order (no oracle)');
select is((select count(*)::int from public.orders where id = tests.nv('oa')), 0, '... and RLS hides it as well (same predicate)');
select tests.clear_auth();
insert into public.role_permissions (role_id, permission_id, restaurant_id)
select tests.nv('wait_role'), (select id from public.permissions where key = 'orders.view'), a from _f;
delete from public.role_permissions where role_id = tests.nv('wait_role') and permission_id = (select id from public.permissions where key = 'orders.create');
select tests.authenticate_as((select a_waiter from _f));
select is(tests.run(format($q$select public.fn_submit_order(%L, 'gap-order-a-0001')$q$, tests.cart('central-cafe', array['Doro Wat:1', 'Macchiato:1']))), 'P0001|permission_denied|',
          'a caller who LOST orders.create cannot replay its earlier key (permission before idempotency)');
select tests.clear_auth();
insert into public.role_permissions (role_id, permission_id, restaurant_id)
select tests.nv('wait_role'), (select id from public.permissions where key = 'orders.create'), a from _f;
select tests.authenticate_as((select a_admin from _f));
select is(tests.run(format($q$select public.fn_submit_order(%L, 'gap-order-a-0001')$q$, tests.cart('central-cafe', array['Doro Wat:1', 'Macchiato:1']))), 'P0001|idempotency_conflict|',
          'tenant_admin (orders.view_all) replaying a waiter''s key + payload: conflict, never the waiter''s order');
select tests.clear_auth();

-- ═════════ a cancelled order leaks nothing ═════════
select tests.authenticate_as((select a_waiter from _f));
select is((public.fn_cancel_order(tests.nv('oc')) ->> 'status'), 'cancelled', 'fixture: the waiter cancels its own order');
select tests.clear_auth();
select tests.authenticate_as((select a_waiter2 from _f));
select is(tests.oracle($q$select public.fn_cancel_order({id})$q$, tests.nv('oc')), 'P0001|not_found|', 'another waiter: a CANCELLED order of someone else = unknown (no already_cancelled oracle)');
select tests.clear_auth();
select tests.authenticate_as((select b_admin from _f));
select is(tests.oracle($q$select public.fn_cancel_order({id})$q$, tests.nv('oc')), 'P0001|not_found|', 'another tenant: a CANCELLED order = unknown');
select tests.clear_auth();

-- ═════════ audit integrity ═════════
select is(tests.n_order_audit((select a from _f)) || '|' || tests.n_order_audit((select b from _f)),
          ((select a from _aud) + 4) || '|' || (select b from _aud),
          'refused calls wrote no audit row: A gained exactly its 4 accepted order events (2 Kitchen starts, no-view submit, cancel), B none');
select is(tests.audit_of((select a from _f), 'order.submitted', tests.nv('oa')) || ';' || tests.audit_of((select a from _f), 'order.cancelled', tests.nv('oc'))
          || ';' || tests.audit_of((select a from _f), 'order.station_status', tests.nv('ok')),
          (select a_waiter || '/user;' || a_waiter || '/user;' || a_kitchen || '/user' from _f),
          'actor of every order event = the authenticated caller (actor_type user), in the caller''s tenant');
select is(tests.audit_of((select b from _f), 'order.submitted', tests.nv('ob')) || '|' ||
          (select count(*)::int from public.audit_logs where restaurant_id = (select a from _f) and new_data ->> 'order_id' = tests.nv('ob')::text),
          (select b_waiter from _f) || '/user|0', 'B''s order is audited in B only, never in A');
select tests.authenticate_as((select a_waiter from _f));
select is((select count(*)::int from public.audit_logs where event like 'order.%'), 0, 'a waiter (no audit.view) reads no order audit row');
select tests.clear_auth();
select tests.authenticate_as((select b_admin from _f));
select is((select count(*)::int from public.audit_logs where restaurant_id = (select a from _f)), 0, 'B admin reads none of A''s audit rows');
select tests.clear_auth();
select tests.authenticate_as((select a_admin from _f));
select cmp_ok((select count(*)::int from public.audit_logs where event like 'order.%' and restaurant_id = (select a from _f)), '>=', 6,
              'positive control: A admin (audit.view) reads its own order audit trail');
select tests.clear_auth();

select * from finish();
rollback;
