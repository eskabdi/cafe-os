-- H1: station-scoped RLS is resolved once per statement. 20k orders in one tenant; a kitchen-role user counting
-- them must finish well under a second (it took ~15 s with per-row has_station_access / order_has_station_access).
begin;
select plan(9);

create temp table _f on commit drop as
select tests.tenant_id('central-cafe') a,
       (select id from public.day_sessions where restaurant_id = tests.tenant_id('central-cafe') and status = 'open') day1,
       tests.user_id('yonas', 'central-cafe') waiter,
       tests.user_id('abebe', 'central-cafe') kitchen,
       tests.user_id('kalkidan', 'central-cafe') bar,
       tests.user_id('hanna', 'central-cafe') cashier,
       tests.user_id('selam', 'central-cafe') admin;
grant all on _f to public;

-- fixture (as the owner, RLS bypassed): 20 000 orders by the waiter, alternating Kitchen / Bar items
create temp table _m on commit drop as
select array_agg(id order by name) filter (where station_id = (select id from public.stations where restaurant_id = tests.tenant_id('central-cafe') and name = 'Kitchen')) k,
       array_agg(id order by name) filter (where station_id = (select id from public.stations where restaurant_id = tests.tenant_id('central-cafe') and name = 'Bar')) b
from public.menu_items where restaurant_id = tests.tenant_id('central-cafe');
insert into public.orders (restaurant_id, day_session_id, order_no, created_by, subtotal, vat_rate_snapshot, vat_amount, total)
select (select a from _f), (select day1 from _f), 'ORD-' || lpad(g::text, 6, '0'), (select waiter from _f), 100, 15, 15, 115
from generate_series(1, 20000) g;
insert into public.order_items (restaurant_id, order_id, menu_item_id, name_snapshot, price_snapshot, qty, station_id, station_name_snapshot)
select o.restaurant_id, o.id, mi.id, mi.name, mi.price, 1, mi.station_id, 'x'
from (select o.*, row_number() over (order by o.order_no) rn from public.orders o where o.restaurant_id = (select a from _f)) o
join lateral (select m.* from public.menu_items m
              where m.id = case when o.rn % 2 = 0 then (select k[1 + (o.rn % 10)::int] from _m) else (select b[1 + (o.rn % 5)::int] from _m) end) mi on true;
analyze public.orders; analyze public.order_items;

create function tests.timed_ms(p_sql text) returns numeric language plpgsql as $$
declare t0 timestamptz := clock_timestamp(); r bigint;
begin
  execute p_sql into r;
  return round(extract(epoch from clock_timestamp() - t0) * 1000, 1);
end $$;
create function tests.count_of(p_sql text) returns bigint language plpgsql as $$
declare r bigint; begin execute p_sql into r; return r; end $$;
grant execute on function tests.timed_ms(text), tests.count_of(text) to public;

select is((select count(*)::int from public.orders where station_ids <> '{}'), 20000, 'orders.station_ids is maintained by the order_items trigger');

select tests.authenticate_as((select kitchen from _f));
select ok(tests.timed_ms('select count(*) from public.orders') < 500, 'kitchen user: count(*) over 20k orders < 500 ms (' || tests.timed_ms('select count(*) from public.orders') || ' ms)');
select is(tests.count_of('select count(*) from public.orders'), 10000::bigint, 'kitchen user sees exactly the orders with a Kitchen item');
select ok(tests.timed_ms('select count(*) from public.order_items') < 500, 'kitchen user: order_items scan < 500 ms');
select is(tests.count_of('select count(*) from public.order_items'), 10000::bigint, 'kitchen user sees only Kitchen items');
select tests.clear_auth();

select tests.authenticate_as((select bar from _f));
select is(tests.count_of('select count(*) from public.orders'), 10000::bigint, 'bar user sees exactly the orders with a Bar item');
select tests.clear_auth();

select tests.authenticate_as((select waiter from _f));
select is(tests.count_of('select count(*) from public.orders'), 20000::bigint, 'waiter sees own orders (created_by) regardless of station');
select tests.clear_auth();

select tests.authenticate_as((select cashier from _f));
select ok(tests.timed_ms('select count(*) from public.orders') < 500, 'cashier (orders.view_all): count(*) < 500 ms');
select tests.clear_auth();

select * from finish();
rollback;
