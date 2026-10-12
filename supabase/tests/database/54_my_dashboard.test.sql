-- Migration 0042 (my_dashboard, docs/note.md task 2): fn_my_dashboard returns only the caller's own figures, and fn_dashboard's
-- orders_by_status is scoped like its 'recent' list.
--  * waiter A never sees waiter B's figures; the figures equal hand-calculated values
--  * a station user sees only the stations of their role_station_access
--  * the cashier / tenant_admin path (fn_dashboard) is unchanged; fn_my_dashboard gives them no foreign figures
--  * cross-tenant denial; permission and period validation
begin;
select plan(30);

create temp table _f on commit drop as
select tests.tenant_id('central-cafe') a, tests.tenant_id('second-cafe') b,
       tests.user_id('selam', 'central-cafe') a_admin, tests.user_id('yonas', 'central-cafe') a_waiter,
       tests.user_id('meron', 'central-cafe') a_waiter2, tests.user_id('hanna', 'central-cafe') a_cashier,
       tests.user_id('abebe', 'central-cafe') a_kitchen,
       tests.user_id('owner', 'second-cafe') b_admin, tests.user_id('waiter', 'second-cafe') b_waiter;
grant all on _f to public;
create temp table _n (k text primary key, v text);
grant all on _n to public;
create temp table _y (w jsonb);
create temp table _k (d jsonb);
grant all on _y, _k to public;
create function tests.nv(p_k text) returns uuid language sql stable as $$ select v::uuid from _n where k = p_k $$;
create function tests.nn(p_k text) returns numeric language sql stable as $$ select v::numeric from _n where k = p_k $$;
create function tests.cart(p_slug text, p_spec text[]) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_agg(jsonb_build_object('menu_item_id', m.id, 'qty', split_part(s, ':', 2)::int) order by o)
  from unnest(p_spec) with ordinality u(s, o)
  join public.menu_items m on m.name = split_part(s, ':', 1) and m.restaurant_id = (select id from public.restaurants where slug = p_slug) $$;
create function tests.grant_perm(p_role uuid, p_key text) returns void language sql security definer set search_path = '' as $$
  insert into public.role_permissions (role_id, permission_id, restaurant_id)
  select r.id, pm.id, r.restaurant_id from public.roles r, public.permissions pm where r.id = p_role and pm.key = p_key
  on conflict do nothing $$;
-- the caller's figures for the open day's local date
create function tests.mine() returns jsonb language sql as $$ select public.fn_my_dashboard(v::date, v::date) from _n where k = 'today' $$;
grant execute on all functions in schema tests to public;

insert into _n select 'a_kit', (select id::text from public.stations where restaurant_id = (select a from _f) and name = 'Kitchen');
insert into _n select 'a_bar', (select id::text from public.stations where restaurant_id = (select a from _f) and name = 'Bar');
insert into _n select 'kit_role', (select role_id::text from public.profiles where id = (select a_kitchen from _f));
insert into _n select 'today', (select (d.opened_at at time zone coalesce(r.timezone, 'Africa/Addis_Ababa'))::date::text
                                from public.day_sessions d join public.restaurants r on r.id = d.restaurant_id
                                where d.restaurant_id = (select a from _f) and d.status = 'open');

-- ═════════ fixtures through the real pipeline ═════════
-- yonas: oy1 (Kitchen + Bar), oy2 (Bar, served), oy3 (cancelled). meron: om1 (Kitchen x3, pending), om2 (Kitchen x2, ready)
select tests.authenticate_as((select a_waiter from _f));
insert into _n select 'oy1', public.fn_submit_order(tests.cart('central-cafe', array['Doro Wat:1', 'Macchiato:1']), 'my-dash-y-0001') ->> 'id';
insert into _n select 'oy2', public.fn_submit_order(tests.cart('central-cafe', array['Macchiato:2']), 'my-dash-y-0002') ->> 'id';
insert into _n select 'oy3', public.fn_submit_order(tests.cart('central-cafe', array['Macchiato:1']), 'my-dash-y-0003') ->> 'id';
insert into _n select 'fx1', public.fn_cancel_order(tests.nv('oy3'))::text;
select tests.clear_auth();
select tests.authenticate_as((select a_waiter2 from _f));
insert into _n select 'om1', public.fn_submit_order(tests.cart('central-cafe', array['Doro Wat:3']), 'my-dash-m-0001') ->> 'id';
insert into _n select 'om2', public.fn_submit_order(tests.cart('central-cafe', array['Doro Wat:2']), 'my-dash-m-0002') ->> 'id';
select tests.clear_auth();
select tests.authenticate_as((select a_admin from _f));
insert into _n select 'fx2', public.fn_set_station_items_status(tests.nv('oy2'), tests.nv('a_bar'), 'ready')::text;
select tests.clear_auth();
select tests.authenticate_as((select a_waiter from _f));
insert into _n select 'fx3', public.fn_serve_order(tests.nv('oy2'))::text;
select tests.clear_auth();
select tests.authenticate_as((select a_kitchen from _f));
insert into _n select 'fx4', public.fn_set_station_items_status(tests.nv('oy1'), tests.nv('a_kit'), 'preparing')::text;
insert into _n select 'fx5', public.fn_set_station_items_status(tests.nv('om2'), tests.nv('a_kit'), 'ready')::text;
select tests.clear_auth();
-- known prep timings for om2's Kitchen line: waited 2 min, prepared in 6 min (everything else in this transaction is at now())
update public.order_items set started_at = created_at + interval '2 minutes', ready_at = created_at + interval '8 minutes'
 where order_id = tests.nv('om2');
-- hand-calculated money: subtotal = price x qty, total = subtotal + VAT (rounded to cents), from the menu and the tenant VAT rate
insert into _n
select 'ty' || x.k, round(x.sub * (1 + r.vat_rate / 100), 2)::text
from (values ('1', array['Doro Wat:1', 'Macchiato:1']), ('2', array['Macchiato:2'])) v(k, spec)
cross join lateral (select v.k, sum(m.price * split_part(s, ':', 2)::int) sub from unnest(v.spec) s
                    join public.menu_items m on m.name = split_part(s, ':', 1) and m.restaurant_id = (select a from _f)) x
cross join public.restaurants r where r.id = (select a from _f);
insert into _n
select 'tm' || x.k, round(x.sub * (1 + r.vat_rate / 100), 2)::text
from (values ('1', 3), ('2', 2)) v(k, q)
cross join lateral (select v.k, m.price * v.q sub from public.menu_items m where m.name = 'Doro Wat' and m.restaurant_id = (select a from _f)) x
cross join public.restaurants r where r.id = (select a from _f);
select is((select total from public.orders where id = tests.nv('oy1')), tests.nn('ty1'), 'premise: hand-calculated total of oy1 matches the server');

-- ═════════ waiter A: own figures, equal to the hand calculation ═════════
select tests.authenticate_as((select a_waiter from _f));
insert into _y select tests.mine() -> 'own_orders';
select is((select (w ->> 'order_count')::int from _y), 2, 'waiter A: 2 orders (the cancelled one excluded)');
select is((select (w ->> 'sales_total')::numeric from _y), tests.nn('ty1') + tests.nn('ty2'), 'waiter A: sales = oy1 + oy2');
select is((select (w ->> 'avg_order_value')::numeric from _y), round((tests.nn('ty1') + tests.nn('ty2')) / 2, 2), 'waiter A: average order value');
select is((select (w ->> 'served_count')::int from _y), 1, 'waiter A: 1 served');
select is((select (w ->> 'cancelled_count')::int from _y), 1, 'waiter A: 1 cancelled');
select is((select (w ->> 'open_count')::int from _y), 1, 'waiter A: 1 open');
select is((select (w ->> 'served_rate')::numeric from _y), 33.3, 'waiter A: served rate 1 / 3 = 33.3 %');
select is((select (w ->> 'unpaid_total')::numeric from _y), tests.nn('ty1') + tests.nn('ty2'), 'waiter A: unpaid = both live orders');
select is((select sum((h ->> 'orders')::int) from _y, jsonb_array_elements(w -> 'by_hour') h)::int, 2, 'waiter A: by_hour counts own live orders');
select ok((select tests.mine() -> 'stations' = 'null'::jsonb), 'waiter A: no station section (no station access)');
select is((public.fn_my_dashboard('2000-01-01', '2000-01-02') -> 'own_orders' ->> 'order_count')::int, 0, 'a period without business days: 0');
select tests.clear_auth();

-- ═════════ waiter B: never A's figures ═════════
select tests.authenticate_as((select a_waiter2 from _f));
select is((tests.mine() -> 'own_orders' ->> 'order_count')::int, 2, 'waiter B: only own 2 orders');
select is((tests.mine() -> 'own_orders' ->> 'sales_total')::numeric, tests.nn('tm1') + tests.nn('tm2'), 'waiter B: sales = om1 + om2 only (no A figure)');
select is((tests.mine() -> 'own_orders' ->> 'cancelled_count')::int, 0, 'waiter B: A''s cancellation is not counted');
-- fix (a): fn_dashboard counts only visible orders for a waiter
select is((select sum(value::int) from jsonb_each_text(public.fn_dashboard() -> 'orders_by_status'))::int, 2,
          'fn_dashboard orders_by_status for waiter B: only own 2 orders, not the tenant''s 5');
select tests.clear_auth();

-- ═════════ station user: only the stations of the role ═════════
select tests.authenticate_as((select a_kitchen from _f));
select is(tests.run($q$select public.fn_my_dashboard(current_date, current_date)$q$), 'P0001|permission_denied|',
          'without dashboard.view: permission_denied');
select tests.clear_auth();
select tests.grant_perm(tests.nv('kit_role'), 'dashboard.view');
select tests.authenticate_as((select a_kitchen from _f));
insert into _k select tests.mine();
select is((select jsonb_array_length(d -> 'stations') from _k), 1, 'station user: exactly one station');
select is((select d -> 'stations' -> 0 ->> 'station_id' from _k)::uuid, tests.nv('a_kit'), 'station user: it is the role''s station');
select is((select (d -> 'stations' -> 0 ->> 'queue')::int || '/' || (d -> 'stations' -> 0 ->> 'in_progress') || '/' || (d -> 'stations' -> 0 ->> 'ready')
           || '/' || (d -> 'stations' -> 0 ->> 'completed') from _k), '3/1/2/2', 'station: queue 3, in progress 1, ready 2, completed 2');
select is((select (d -> 'stations' -> 0 ->> 'avg_prep_minutes')::numeric || '/' || (d -> 'stations' -> 0 ->> 'avg_wait_minutes')::numeric from _k),
          '6.0/1.0', 'station: average prep 6 min (one ready line), average wait (2 + 0) / 2 = 1 min');
select ok((select d -> 'own_orders' = 'null'::jsonb from _k), 'station user without orders.create: no waiter section');
select is(public.fn_dashboard() -> 'orders_by_status', '{"ready": 1, "preparing": 1, "submitted": 1}'::jsonb,
          'fn_dashboard orders_by_status for the station: only orders routed to it');
select tests.clear_auth();

-- ═════════ cashier / tenant_admin: main dashboard unchanged ═════════
select tests.authenticate_as((select a_cashier from _f));
select is(public.fn_dashboard() -> 'orders_by_status', '{"ready": 1, "served": 1, "preparing": 1, "submitted": 1, "cancelled": 1}'::jsonb,
          'cashier (orders.view_all): the whole floor, as before');
select ok(public.fn_dashboard() ? 'money', 'cashier keeps the money figures');
select ok((select d -> 'own_orders' = 'null'::jsonb and d -> 'stations' = 'null'::jsonb from (select tests.mine() d) x),
          'cashier: fn_my_dashboard has no personal section');
select tests.clear_auth();
select tests.authenticate_as((select a_admin from _f));
select ok((select (d -> 'own_orders' ->> 'order_count')::int = 0 and d -> 'stations' = 'null'::jsonb from (select tests.mine() d) x),
          'tenant_admin: own figures only (0 orders), no implicit all-stations section');
select tests.clear_auth();

-- ═════════ cross-tenant, period validation ═════════
select tests.authenticate_as((select b_admin from _f));
select is((tests.mine() -> 'own_orders' ->> 'sales_total')::numeric, 0::numeric, 'B tenant_admin: no A figure');
select tests.clear_auth();
select tests.authenticate_as((select b_waiter from _f));
select is((tests.mine() -> 'own_orders' ->> 'order_count')::int, 0, 'B waiter: no A order');
select is(tests.run($q$select public.fn_my_dashboard('2026-01-01', '2027-01-02')$q$), 'P0001|invalid_input|period',
          'more than 366 days: invalid_input|period');
select tests.clear_auth();

select * from finish();
rollback;
