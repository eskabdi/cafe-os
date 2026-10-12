-- Migration 0041 (orders_own_scope, docs/note.md task 1): orders scoped to the signed-in user, decided by PERMISSION.
--  * a waiter (orders.view without orders.view_all) reads only own orders and their lines
--  * a waiter cancels only own orders; another waiter's order is not_found with no existence oracle
--  * orders.view_all (cashier) and tenant_admin keep the full view; only orders.cancel_any cancels someone else's order
--  * a station reads the order header and ONLY its own routed lines
--  * cross-tenant denial; the Realtime-relevant select policies and publication
begin;
select plan(26);

create temp table _f on commit drop as
select tests.tenant_id('central-cafe') a, tests.tenant_id('second-cafe') b,
       tests.user_id('selam', 'central-cafe') a_admin, tests.user_id('yonas', 'central-cafe') a_waiter,
       tests.user_id('meron', 'central-cafe') a_waiter2, tests.user_id('hanna', 'central-cafe') a_cashier,
       tests.user_id('abebe', 'central-cafe') a_kitchen,
       tests.user_id('owner', 'second-cafe') b_admin, tests.user_id('waiter', 'second-cafe') b_waiter;
grant all on _f to public;
create temp table _n (k text primary key, v text);
grant all on _n to public;
create function tests.nv(p_k text) returns uuid language sql stable as $$ select v::uuid from _n where k = p_k $$;
create function tests.cart(p_slug text, p_spec text[]) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_agg(jsonb_build_object('menu_item_id', m.id, 'qty', split_part(s, ':', 2)::int) order by o)
  from unnest(p_spec) with ordinality u(s, o)
  join public.menu_items m on m.name = split_part(s, ':', 1) and m.restaurant_id = (select id from public.restaurants where slug = p_slug) $$;
create function tests.role_has(p_role uuid, p_key text) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.role_permissions rp join public.permissions pm on pm.id = rp.permission_id
                 where rp.role_id = p_role and pm.key = p_key) $$;
create function tests.grant_perm(p_role uuid, p_key text) returns void language sql security definer set search_path = '' as $$
  insert into public.role_permissions (role_id, permission_id, restaurant_id)
  select r.id, pm.id, r.restaurant_id from public.roles r, public.permissions pm where r.id = p_role and pm.key = p_key
  on conflict do nothing $$;
grant execute on all functions in schema tests to public;

insert into _n select 'a_kit', (select id::text from public.stations where restaurant_id = (select a from _f) and name = 'Kitchen');
insert into _n select 'kit_role', (select role_id::text from public.profiles where id = (select a_kitchen from _f));
insert into _n select 'wait_role', (select role_id::text from public.profiles where id = (select a_waiter from _f));
insert into _n select 'cash_role', (select role_id::text from public.profiles where id = (select a_cashier from _f));
insert into _n select 'admin_role', (select role_id::text from public.profiles where id = (select a_admin from _f));

-- fixtures through the real pipeline: each order has a Kitchen line and a Bar line
select tests.authenticate_as((select a_waiter from _f));
insert into _n select 'oy', public.fn_submit_order(tests.cart('central-cafe', array['Doro Wat:1', 'Macchiato:1']), 'own-scope-y-0001') ->> 'id';
insert into _n select 'oy2', public.fn_submit_order(tests.cart('central-cafe', array['Macchiato:1']), 'own-scope-y-0002') ->> 'id';
select tests.clear_auth();
select tests.authenticate_as((select a_waiter2 from _f));
insert into _n select 'om', public.fn_submit_order(tests.cart('central-cafe', array['Doro Wat:1', 'Macchiato:1']), 'own-scope-m-0001') ->> 'id';
insert into _n select 'om2', public.fn_submit_order(tests.cart('central-cafe', array['Macchiato:1']), 'own-scope-m-0002') ->> 'id';
select tests.clear_auth();

-- ═════════ catalogue and backfill (permission-keyed, no role name in the rule) ═════════
select ok(exists (select 1 from public.permissions where key = 'orders.cancel_any'), 'orders.cancel_any is in the permission catalogue');
select ok(tests.role_has(tests.nv('admin_role'), 'orders.cancel_any'), 'tenant_admin holds orders.cancel_any');
select ok(tests.role_has(tests.nv('wait_role'), 'orders.cancel') and not tests.role_has(tests.nv('wait_role'), 'orders.cancel_any')
          and not tests.role_has(tests.nv('wait_role'), 'orders.view_all'), 'the order-taking role is restricted (no view_all, no cancel_any)');
select ok(tests.role_has(tests.nv('cash_role'), 'orders.view_all'), 'the payment-taking role keeps orders.view_all');

-- ═════════ waiter: own orders and lines only ═════════
select tests.authenticate_as((select a_waiter from _f));
select is((select count(*)::int from public.orders where id in (tests.nv('oy'), tests.nv('oy2'), tests.nv('om'), tests.nv('om2'))), 2,
          'waiter sees only own orders');
select is((select count(*)::int from public.orders where id = tests.nv('om')), 0, 'waiter cannot read another waiter''s order');
select is((select count(*)::int from public.order_items where order_id = tests.nv('oy')), 2, 'waiter reads every line of own order');
select is((select count(*)::int from public.order_items where order_id = tests.nv('om')), 0, 'waiter reads no line of another waiter''s order');
select is(tests.oracle($q$select public.fn_cancel_order({id})$q$, tests.nv('om')), 'P0001|not_found|',
          'waiter cancelling another waiter''s order: not_found, indistinguishable from an unknown id');
select is((select status from public.orders where id = tests.nv('oy2')), 'submitted', 'premise: own order is open');
select is(public.fn_cancel_order(tests.nv('oy2')) ->> 'status', 'cancelled', 'waiter cancels own order');
select tests.clear_auth();
select is((select status from public.orders where id = tests.nv('om')), 'submitted', 'the other waiter''s order was not touched');

-- ═════════ cashier (orders.view_all) and admin: full view; cancel_any needed for others' orders ═════════
select tests.authenticate_as((select a_cashier from _f));
select is((select count(*)::int from public.orders where id in (tests.nv('oy'), tests.nv('om'))), 2, 'cashier (orders.view_all) sees every order');
select is((select count(*)::int from public.order_items where order_id in (tests.nv('oy'), tests.nv('om'))), 4, 'cashier reads every line');
select tests.clear_auth();
select tests.grant_perm(tests.nv('cash_role'), 'orders.cancel');
select tests.authenticate_as((select a_cashier from _f));
select is(tests.run(format($q$select public.fn_cancel_order(%L)$q$, tests.nv('om'))), 'P0001|permission_denied|',
          'orders.view_all + orders.cancel WITHOUT orders.cancel_any: a visible order of someone else is permission_denied');
select tests.clear_auth();
select tests.authenticate_as((select a_admin from _f));
select is((select count(*)::int from public.orders where id in (tests.nv('oy'), tests.nv('om'))), 2, 'tenant_admin sees every order');
select is(public.fn_cancel_order(tests.nv('om2')) ->> 'status', 'cancelled', 'tenant_admin (orders.cancel_any) cancels another user''s order');
select tests.clear_auth();

-- ═════════ station: header + own routed lines only ═════════
select tests.authenticate_as((select a_kitchen from _f));
select is((select count(*)::int from public.orders where id in (tests.nv('oy'), tests.nv('om'))), 2, 'station sees the header of orders routed to it');
select is((select count(*)::int from public.order_items where order_id in (tests.nv('oy'), tests.nv('om'))), 2, 'station reads only its routed lines');
select is((select count(*)::int from public.order_items where order_id in (tests.nv('oy'), tests.nv('om')) and station_id <> tests.nv('a_kit')), 0,
          'station reads no line of another station');
select tests.clear_auth();
select tests.grant_perm(tests.nv('kit_role'), 'orders.cancel');
select tests.authenticate_as((select a_kitchen from _f));
select is(tests.run(format($q$select public.fn_cancel_order(%L)$q$, tests.nv('om'))), 'P0001|permission_denied|',
          'station operator with orders.cancel but no orders.cancel_any cannot cancel a waiter''s order at its station');
select tests.clear_auth();

-- ═════════ cross-tenant ═════════
select tests.authenticate_as((select b_admin from _f));
select is((select count(*)::int from public.orders where id in (tests.nv('oy'), tests.nv('om'))), 0, 'B tenant_admin reads no A order');
select is(tests.oracle($q$select public.fn_cancel_order({id})$q$, tests.nv('om')), 'P0001|not_found|',
          'B tenant_admin (orders.cancel_any) cancelling an A order: not_found, no oracle');
select tests.clear_auth();

-- ═════════ Realtime: the select policies Realtime applies, and the publication ═════════
select is((select string_agg(tablename || ':' || cmd || ':' || array_to_string(roles, '+'), ',' order by tablename)
           from pg_policies where schemaname = 'public' and policyname in ('orders_select', 'order_items_select')),
          'order_items:SELECT:authenticated,orders:SELECT:authenticated', 'orders / order_items are read through one authenticated SELECT policy each');
select ok((select bool_and(qual like '%orders.view_all%' and qual like '%current_station_ids%')
           from pg_policies where schemaname = 'public' and policyname in ('orders_select', 'order_items_select')),
          'both select policies scope by orders.view_all / own / station (the predicate Realtime enforces per subscriber)');
select is((select string_agg(tablename, ',' order by tablename) from pg_publication_tables
           where pubname = 'supabase_realtime' and tablename in ('orders', 'order_items')), 'order_items,orders',
          'orders and order_items are streamed by supabase_realtime (RLS-filtered)');

select * from finish();
rollback;
