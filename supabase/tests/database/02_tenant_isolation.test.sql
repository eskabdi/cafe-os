-- Cross-tenant RLS, permission scoping, tenant suspension
begin;
select plan(46);

-- fixtures (superuser): one order per tenant + staff orders in tenant A
create temp table _f on commit drop as
select tests.tenant_id('central-cafe') a, tests.tenant_id('second-cafe') b;
grant all on _f to public;

insert into public.orders (restaurant_id, day_session_id, order_no, created_by, created_by_name_snapshot, subtotal, vat_rate_snapshot, vat_amount, total)
select f.a, d.id, 'ORD-0001', tests.user_id('yonas', 'central-cafe'), 'Yonas Tesfaye', 100, 15, 15, 115
from _f f join public.day_sessions d on d.restaurant_id = f.a and d.status = 'open';
insert into public.orders (restaurant_id, day_session_id, order_no, created_by, created_by_name_snapshot, subtotal, vat_rate_snapshot, vat_amount, total)
select f.a, d.id, 'ORD-0002', tests.user_id('meron', 'central-cafe'), 'Meron Alemu', 200, 15, 30, 230
from _f f join public.day_sessions d on d.restaurant_id = f.a and d.status = 'open';
insert into public.orders (restaurant_id, day_session_id, order_no, created_by, created_by_name_snapshot, subtotal, vat_rate_snapshot, vat_amount, total)
select f.b, d.id, 'ORD-0001', tests.user_id('waiter', 'second-cafe'), 'Tigist Bekele', 100, 15, 15, 115
from _f f join public.day_sessions d on d.restaurant_id = f.b and d.status = 'open';
-- ORD-0002 (meron) has one kitchen item and one bar item
insert into public.order_items (restaurant_id, order_id, menu_item_id, name_snapshot, price_snapshot, qty, station_id, station_name_snapshot)
select m.restaurant_id, o.id, m.id, m.name, m.price, 1, m.station_id, s.name
from public.orders o
join public.menu_items m on m.restaurant_id = o.restaurant_id and m.name in ('Doro Wat', 'Macchiato')
join public.stations s on s.id = m.station_id
where o.order_no = 'ORD-0002' and o.restaurant_id = (select a from _f);

-- ── tenant A admin ──
select tests.authenticate_as(tests.user_id('selam', 'central-cafe'));
select is((select public.current_restaurant_id()), (select a from _f), 'helper resolves tenant from profile');
select is((select count(*)::int from public.orders where restaurant_id = (select b from _f)), 0, 'A cannot read B orders');
select is((select count(*)::int from public.roles where restaurant_id = (select b from _f)), 0, 'A cannot read B roles');
select is((select count(*)::int from public.menu_items where restaurant_id = (select b from _f)), 0, 'A cannot read B menu');
select is((select count(*)::int from public.restaurants), 1, 'A sees only its own restaurant row');
select is((select count(*)::int from public.profiles where restaurant_id = (select b from _f)), 0, 'A cannot read B staff');
select is((select count(*)::int from public.orders), 2, 'A admin sees all A orders');
select throws_ok(format($q$insert into public.stations (restaurant_id, name) values (%L, 'Forged')$q$, (select b from _f)),
                 '42501', null, 'cannot create data in another tenant');
select throws_ok(format($q$update public.menu_items set price = 1 where restaurant_id = %L$q$, (select b from _f)),
                 '42501', null, 'menu_items has no client UPDATE at all since 0029 (RPCs only), so no cross-tenant update either');
select throws_ok(format($q$update public.stations set restaurant_id = %L$q$, (select b from _f)),
                 '42501', null, 'restaurant_id is not client-writable');
select throws_ok($q$select 1 from public.profile_secrets$q$, '42501', null, 'profile_secrets unreadable by tenant admin');
select throws_ok($q$select token_hash from public.qr_credentials$q$, '42501', null, 'qr token_hash column not readable');
select is((select count(*)::int from public.audit_logs where restaurant_id = (select b from _f)), 0, 'A cannot read B audit');
select lives_ok($q$insert into public.stations (restaurant_id, name, color, icon) values (public.current_restaurant_id(), 'Grill', '#ff0000', 'flame')$q$,
                'admin creates a new station as a row');
select tests.clear_auth();
select is((select price from public.menu_items where restaurant_id = (select b from _f) limit 1), 100.00::numeric, 'B menu price untouched');

-- ── waiter: only own orders ──
select tests.authenticate_as(tests.user_id('yonas', 'central-cafe'));
select is((select count(*)::int from public.orders), 1, 'waiter sees only own orders');
select throws_ok($q$insert into public.menu_items (restaurant_id, name, category_id, station_id, price)
                    select restaurant_id, 'X', category_id, station_id, 1 from public.menu_items limit 1$q$,
                 '42501', null, 'waiter cannot write menu');
select ok(public.has_permission('orders.create'), 'waiter has orders.create');
select ok(not public.has_permission('users.manage'), 'waiter lacks users.manage');
select tests.clear_auth();

-- ── kitchen operator: station-scoped visibility ──
select tests.authenticate_as(tests.user_id('abebe', 'central-cafe'));
select is((select count(*)::int from public.orders), 1, 'kitchen sees the order that has a kitchen item');
select is((select count(*)::int from public.order_items), 1, 'kitchen sees only its own station items');
select is((select count(*)::int from public.order_items where station_name_snapshot = 'Bar'), 0, 'kitchen cannot see bar items');
select ok(public.has_station_access((select id from public.stations where name = 'Kitchen' and restaurant_id = (select a from _f))), 'station access: kitchen role -> kitchen');
select ok(not public.has_station_access((select id from public.stations where name = 'Bar' and restaurant_id = (select a from _f))), 'station access: kitchen role -> bar denied');
select tests.clear_auth();

-- ── cashier ──
select tests.authenticate_as(tests.user_id('hanna', 'central-cafe'));
select is((select count(*)::int from public.orders), 2, 'cashier (orders.view_all) sees all A orders');
select tests.clear_auth();

-- ── tenant B isolation the other way ──
select tests.authenticate_as(tests.user_id('owner', 'second-cafe'));
select is((select count(*)::int from public.orders), 1, 'B sees only B orders');
select is((select count(*)::int from public.stations where name = 'Grill'), 0, 'B cannot see A station');
select tests.clear_auth();

-- ── anonymous ──
select tests.as_anon();
select throws_ok($q$select 1 from public.orders$q$, '42501', null, 'anon has no table access');
select is((select count(*)::int from public.plans), 3, 'anon can read plans');
select tests.clear_auth();

-- ── past_due = read only; suspended = no access ──
update public.restaurants set status = 'past_due' where id = (select b from _f);
select tests.authenticate_as(tests.user_id('owner', 'second-cafe'));
select is((select count(*)::int from public.stations), 3, 'past_due tenant can still read');
select throws_ok($q$insert into public.stations (restaurant_id, name) values (public.current_restaurant_id(), 'Late')$q$,
                 '42501', null, 'past_due tenant cannot write (policy)');
select throws_ok($q$select public.fn_update_role_permissions(gen_random_uuid(), '{}', '{}')$q$,
                 'P0001', 'tenant_read_only', 'past_due tenant blocked in RPC');
select tests.clear_auth();

select tests.authenticate_as(tests.user_id('selam', 'central-cafe'));
select throws_ok(format($q$select public.fn_suspend_tenant(%L, 'attempt by tenant')$q$, (select b from _f)),
                 'P0001', 'permission_denied', 'tenant admin cannot suspend a tenant');
select tests.clear_auth();

select tests.authenticate_as('00000000-0000-4000-8000-0000000000c1');
select is((select count(*)::int from public.restaurants), 2, 'platform admin lists every tenant');
select lives_ok(format($q$select public.fn_suspend_tenant(%L, 'ToS violation test')$q$, (select b from _f)), 'platform admin suspends');
select is((select count(*)::int from public.admin_audit_log where action = 'tenant.suspend'), 1, 'suspension written to admin_audit_log');
select tests.clear_auth();

select tests.authenticate_as(tests.user_id('owner', 'second-cafe'));
select is((select public.current_restaurant_id()), null::uuid, 'suspended tenant resolves to no tenant');
select is((select count(*)::int from public.stations), 0, 'suspended tenant has no read access');
select is((select count(*)::int from public.restaurants), 0, 'suspended tenant cannot even read its own row');
select throws_ok($q$select public.fn_update_role_permissions(gen_random_uuid(), '{}', '{}')$q$,
                 'P0001', 'tenant_suspended', 'suspended tenant blocked in RPC');
select tests.clear_auth();

select tests.as_anon();
select is((select public.fn_resolve_tenant_slug('second-cafe')), null::jsonb, 'suspended slug resolves like an unknown slug');
select is((select public.fn_resolve_tenant_slug('does-not-exist')), null::jsonb, 'unknown slug -> null');
select is((select public.fn_resolve_tenant_slug('central-cafe') ->> 'name'), 'Central Cafe', 'known slug resolves name');
select ok(not ((select public.fn_resolve_tenant_slug('central-cafe')) ?| array['status', 'id']), 'resolver leaks nothing beyond name/branding (no status, no tenant id)');
select tests.clear_auth();

select tests.authenticate_as('00000000-0000-4000-8000-0000000000c1');
select lives_ok(format($q$select public.fn_reactivate_tenant(%L, 'resolved test')$q$, (select b from _f)), 'platform admin reactivates');
select is((select status from public.restaurants where id = (select b from _f)), 'past_due', 'reactivation restores the pre-suspension status');
select tests.clear_auth();

select * from finish();
rollback;
