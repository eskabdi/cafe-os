-- Immutability, system role, platform boundary, RPC authorization
begin;
select * from no_plan();

create temp table _f on commit drop as
select tests.tenant_id('central-cafe') a, tests.tenant_id('second-cafe') b,
  (select r.id from public.roles r where r.name = 'Waiter' and r.restaurant_id = tests.tenant_id('second-cafe')) bw;
grant all on _f to public;

-- ── system role ──
select throws_ok(format($q$delete from public.roles where restaurant_id = %L and system_key = 'tenant_admin'$q$, (select a from _f)),
                 'P0001', 'system_role_protected', 'tenant_admin role cannot be deleted (even by owner/superuser)');
select throws_ok(format($q$update public.roles set is_active = false where restaurant_id = %L and system_key = 'tenant_admin'$q$, (select a from _f)),
                 'P0001', 'system_role_protected', 'tenant_admin role cannot be deactivated');
select throws_ok(format($q$update public.roles set system_key = null, is_system = false where restaurant_id = %L and system_key = 'tenant_admin'$q$, (select a from _f)),
                 'P0001', 'system_role_protected', 'tenant_admin system_key is immutable');
select throws_ok(format($q$delete from public.role_permissions where role_id = (select id from public.roles where restaurant_id = %L and system_key = 'tenant_admin') and permission_id = (select id from public.permissions limit 1)$q$, (select a from _f)),
                 'P0001', 'system_role_protected', 'tenant_admin permissions cannot be removed');
select throws_ok(format($q$insert into public.roles (restaurant_id, name, is_system, system_key) values (%L, 'Admin2', true, 'tenant_admin')$q$, (select a from _f)),
                 '23505', null, 'only one tenant_admin per tenant');
select throws_ok(format($q$delete from public.roles where id = (select role_id from public.profiles where username = 'hanna' and restaurant_id = %L)$q$, (select a from _f)),
                 '23503', null, 'role with users cannot be deleted (RESTRICT)');
select throws_ok(format($q$delete from public.stations where restaurant_id = %L and name = 'Kitchen'$q$, (select a from _f)),
                 '23503', null, 'station referenced by menu items cannot be deleted');
select throws_ok(format($q$insert into public.qr_credentials (restaurant_id, table_id, token_hash) select restaurant_id, table_id, repeat('a', 64) from public.qr_credentials where restaurant_id = %L limit 1$q$, (select a from _f)),
                 '23505', null, 'at most one active QR credential per table');
select throws_ok(format($q$update public.restaurants set branding = '{"primary_color":"red","accent_color":"#000000"}' where id = %L$q$, (select a from _f)),
                 '23514', null, 'branding colours validated by CHECK');

-- ── payments immutable ──
insert into public.orders (restaurant_id, day_session_id, order_no, created_by, subtotal, vat_rate_snapshot, vat_amount, total)
select (select a from _f), d.id, 'ORD-0100', tests.user_id('yonas', 'central-cafe'), 100, 15, 15, 115
from public.day_sessions d where d.restaurant_id = (select a from _f) and d.status = 'open';
insert into public.payments (restaurant_id, day_session_id, order_id, kind, amount, payment_method_id, method_name_snapshot, method_affects_drawer_snapshot, receipt_no)
select o.restaurant_id, o.day_session_id, o.id, 'order_payment', 115, pm.id, pm.name, pm.affects_cash_drawer, 'RCT-0001'
from public.orders o join public.payment_methods pm on pm.restaurant_id = o.restaurant_id and pm.affects_cash_drawer
where o.order_no = 'ORD-0100' and o.restaurant_id = (select a from _f);
select throws_ok(format($q$delete from public.payment_methods where restaurant_id = %L$q$, (select a from _f)),
                 '23503', null, 'payment methods referenced elsewhere cannot be deleted');
select throws_ok($q$update public.payments set amount = 1$q$, 'P0001', 'immutable_record', 'payments cannot be updated (owner)');
select throws_ok($q$delete from public.payments$q$, 'P0001', 'immutable_record', 'payments cannot be deleted (owner)');
select tests.authenticate_as_service_role();
select throws_ok($q$update public.payments set amount = 1$q$, 'P0001', 'immutable_record', 'payments cannot be updated (service_role)');
select throws_ok($q$delete from public.payments$q$, 'P0001', 'immutable_record', 'payments cannot be deleted (service_role)');
select tests.clear_auth();
select tests.authenticate_as(tests.user_id('hanna', 'central-cafe'));
select is((select count(*)::int from public.payments), 1, 'cashier reads payments');
select throws_ok($q$insert into public.payments (restaurant_id, day_session_id, kind, amount, payment_method_id, method_name_snapshot, method_affects_drawer_snapshot, receipt_no) values (gen_random_uuid(), gen_random_uuid(), 'order_payment', 1, gen_random_uuid(), 'x', true, 'RCT-9999')$q$,
                 '42501', null, 'clients cannot insert payments directly');
select tests.clear_auth();

-- ── audit immutability & integrity ──
select ok((select count(*) from public.audit_logs) > 0, 'audit rows exist (config/provisioning triggers)');
select throws_ok($q$update public.audit_logs set event = 'tampered'$q$, 'P0001', 'immutable_record', 'audit_logs cannot be updated (owner)');
select throws_ok($q$delete from public.audit_logs$q$, 'P0001', 'immutable_record', 'audit_logs cannot be deleted (owner)');
select throws_ok($q$truncate public.audit_logs$q$, 'P0001', 'immutable_record', 'audit_logs cannot be truncated');
select tests.authenticate_as_service_role();
select throws_ok($q$delete from public.audit_logs$q$, 'P0001', 'immutable_record', 'audit_logs cannot be deleted (service_role)');
select tests.clear_auth();
select tests.authenticate_as(tests.user_id('selam', 'central-cafe'));
select throws_ok(format($q$insert into public.audit_logs (restaurant_id, actor_id, actor_type, event, action) values (%L, %L, 'user', 'forged', 'event')$q$,
                        (select a from _f), tests.user_id('dawit', 'central-cafe')),
                 '42501', null, 'tenant admin cannot forge audit rows');
select throws_ok($q$update public.audit_logs set event = 'x'$q$, '42501', null, 'tenant admin cannot edit audit rows');
select ok((select count(*) from public.audit_logs) > 0, 'tenant admin (audit.view) reads audit');
select tests.clear_auth();
select tests.authenticate_as(tests.user_id('yonas', 'central-cafe'));
select is((select count(*)::int from public.audit_logs), 0, 'waiter without audit.view reads no audit');
select tests.clear_auth();

-- ── platform boundary ──
select tests.authenticate_as(tests.user_id('selam', 'central-cafe'));
select is((select count(*)::int from public.platform_admins), 0, 'tenant admin cannot read platform_admins');
select is((select count(*)::int from public.admin_audit_log), 0, 'tenant admin cannot read admin_audit_log');
select throws_ok($q$insert into public.plans (name, price_etb_monthly) values ('Free forever', 0)$q$, '42501', null, 'tenant admin cannot write plans');
select throws_ok(format($q$insert into public.platform_admins (id, full_name, role) values (%L, 'Self promote', 'platform_super_admin')$q$, tests.user_id('selam', 'central-cafe')),
                 '42501', null, 'tenant admin cannot make themselves a platform admin');
select ok(not public.is_platform_super_admin(), 'tenant admin is not platform super admin');
select throws_ok($q$select public.fn_provision_tenant('X Cafe', 'x-cafe', gen_random_uuid(), 'a@b.co', 'A', null, null, gen_random_uuid(), null)$q$,
                 'P0001', 'permission_denied', 'tenant admin cannot provision tenants');
select throws_ok($q$update public.restaurants set status = 'active', slug = 'hijack'$q$, '42501', null, 'status/slug are not tenant-writable columns');
select is((select count(*)::int from public.subscriptions), 1, 'tenant sees only its subscription');
select tests.clear_auth();
select tests.authenticate_as('00000000-0000-4000-8000-0000000000c1');
select ok(public.is_platform_super_admin(), 'platform admin recognised via platform_admins');
select is((select public.current_restaurant_id()), null::uuid, 'platform admin has no tenant identity');
select tests.clear_auth();

-- ── permission matrix RPCs ──
select tests.authenticate_as(tests.user_id('yonas', 'central-cafe'));
select throws_ok(format($q$select public.fn_update_role_permissions(%L, '{}', '{}')$q$, (select role_id from public.profiles where username = 'yonas' and restaurant_id = (select a from _f))),
                 'P0001', 'permission_denied', 'waiter cannot edit the matrix');
select throws_ok(format($q$select public.fn_change_user_role(%L, %L)$q$, tests.user_id('yonas', 'central-cafe'),
                        (select id from public.roles where system_key = 'tenant_admin' and restaurant_id = (select a from _f))),
                 'P0001', 'permission_denied', 'waiter cannot self-promote to tenant_admin');
select tests.clear_auth();

select tests.authenticate_as(tests.user_id('selam', 'central-cafe'));
select lives_ok(format($q$select public.fn_update_role_permissions(%L, array['orders.view','orders.create','expenses.view'], '{}')$q$,
                       (select id from public.roles where name = 'Waiter' and restaurant_id = (select a from _f))), 'admin edits waiter matrix');
select is((select count(*)::int from public.role_permissions rp join public.roles r on r.id = rp.role_id where r.name = 'Waiter' and r.restaurant_id = (select a from _f)),
          3, 'matrix replaced with requested set');
select is((select count(*)::int from public.audit_logs where event = 'role.permissions_updated'), 1, 'matrix change audited');
select throws_ok(format($q$select public.fn_update_role_permissions(%L, '{}', '{}')$q$,
                        (select id from public.roles where system_key = 'tenant_admin' and restaurant_id = (select a from _f))),
                 'P0001', 'system_role_protected', 'tenant_admin matrix immutable');
select throws_ok(format($q$select public.fn_update_role_permissions(%L, '{}', '{}')$q$,
                        (select bw from _f)),
                 'P0001', 'not_found', 'cross-tenant role id is indistinguishable from unknown');
select throws_ok(format($q$select public.fn_update_role_permissions(%L, array['platform.root'], '{}')$q$,
                        (select id from public.roles where name = 'Waiter' and restaurant_id = (select a from _f))),
                 'P0001', 'invalid_permission', 'unknown permission key rejected');
select throws_ok(format($q$select public.fn_update_role_permissions(%L, '{}', array[%L]::uuid[])$q$,
                        (select id from public.roles where name = 'Waiter' and restaurant_id = (select a from _f)),
                        (select id from public.stations where restaurant_id = (select b from _f) limit 1)),
                 'P0001', 'invalid_station', 'cross-tenant station id rejected');
select throws_ok(format($q$select public.fn_change_user_role(%L, %L)$q$, tests.user_id('waiter', 'second-cafe'),
                        (select id from public.roles where name = 'Waiter' and restaurant_id = (select a from _f))),
                 'P0001', 'not_found', 'cross-tenant profile id is not found');
-- last tenant_admin guard: demote dawit (ok), then selam is the last one
select lives_ok(format($q$select public.fn_change_user_role(%L, %L)$q$, tests.user_id('dawit', 'central-cafe'),
                       (select id from public.roles where name = 'Cashier' and restaurant_id = (select a from _f))), 'one of two admins can be demoted');
select throws_ok(format($q$select public.fn_change_user_role(%L, %L)$q$, tests.user_id('selam', 'central-cafe'),
                        (select id from public.roles where name = 'Cashier' and restaurant_id = (select a from _f))),
                 'P0001', 'last_tenant_admin', 'last tenant_admin cannot be demoted');
select throws_ok(format($q$update public.profiles set is_active = false where id = %L$q$, tests.user_id('selam', 'central-cafe')),
                 'P0001', 'last_tenant_admin', 'last tenant_admin cannot be deactivated');
select tests.clear_auth();

-- ── closed business day is frozen ──
update public.day_sessions set status = 'closed', closed_at = now(), closed_by = tests.user_id('selam', 'central-cafe'),
  order_count = 0, gross_collected = 0, cash_collected = 0, cash_expenses = 0, expenses_total = 0,
  expected_cash = 2500, counted_cash = 2500, cash_variance = 0, net_profit = 0,
  station_snapshot = '{}', expense_snapshot = '{}'
 where restaurant_id = (select a from _f) and status = 'open';
select throws_ok(format($q$update public.day_sessions set counted_cash = 1 where restaurant_id = %L$q$, (select a from _f)),
                 'P0001', 'closed_day_immutable', 'closed day cannot be edited');
select throws_ok(format($q$delete from public.day_sessions where restaurant_id = %L$q$, (select a from _f)),
                 'P0001', 'closed_day_immutable', 'days cannot be deleted');

select * from finish();
rollback;
