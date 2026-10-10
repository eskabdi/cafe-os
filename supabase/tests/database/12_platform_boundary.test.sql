-- Adversarial: the platform / tenant boundary. Tenant staff (admin and waiter) and anon versus the platform
-- surface, platform_support (read-only) and platform_super_admin versus tenant data.
begin;
select plan(71);

create temp table _f on commit drop as
select tests.tenant_id('central-cafe') a, tests.tenant_id('second-cafe') b,
       tests.user_id('selam', 'central-cafe') a_admin, tests.user_id('yonas', 'central-cafe') a_waiter,
       '00000000-0000-4000-8000-0000000000c1'::uuid super_admin,
       '00000000-0000-4000-8000-0000000000c2'::uuid support_admin,
       (select id from public.plans where name = 'Growth') plan_id,
       (select id from public.subscriptions where restaurant_id = tests.tenant_id('central-cafe')) a_sub;
grant all on _f to public;

do $$ begin perform tests.create_auth_user('00000000-0000-4000-8000-0000000000c2', 'support@cafeos.example.com'); end $$;
insert into public.platform_admins (id, full_name, role) select support_admin, 'Support Agent', 'platform_support' from _f;
create temp table _snap on commit drop as
select (select count(*) from public.plans) plans, tests.snapshot((select a from _f)) a, tests.snapshot((select b from _f)) b,
       (select count(*) from public.platform_admins) admins, (select count(*) from public.admin_audit_log) admin_audit;
grant all on _snap to public;

-- ═════════ tenant admin ═════════
select tests.authenticate_as((select a_admin from _f));
select is((select count(*)::int from public.platform_admins), 0, 'tenant admin reads no platform_admins row (not even its own absence)');
select is((select count(*)::int from public.admin_audit_log), 0, 'tenant admin reads no admin_audit_log row');
select is((select count(*)::int from public.restaurants), 1, 'tenant admin reads only its own restaurants row');
select is((select count(*)::int from public.subscriptions), 1, 'tenant admin reads only its own subscription');
select is(tests.run($q$insert into public.plans (name, price_etb_monthly) values ('Free forever', 0)$q$),
          '42501|permission denied for table plans|', 'tenant admin cannot create a plan');
select is(tests.run($q$update public.plans set price_etb_monthly = 0$q$), '42501|permission denied for table plans|', 'tenant admin cannot change any plan (no client UPDATE since 0030)');
select is(tests.run($q$delete from public.plans$q$), '42501|permission denied for table plans|', 'tenant admin cannot delete any plan');
select is(tests.run(format($q$update public.subscriptions set plan_id = (select id from public.plans where name = 'Pro'), status = 'active' where id = %L$q$, (select a_sub from _f))),
          '42501|permission denied for table subscriptions|', 'tenant admin cannot upgrade its own subscription');
select is(tests.run(format($q$insert into public.subscriptions (restaurant_id, plan_id, status, current_period_end) values (%L, %L, 'active', now() + interval '1 year')$q$, (select b from _f), (select plan_id from _f))),
          '42501|permission denied for table subscriptions|', 'tenant admin cannot insert subscriptions');
select is(tests.run(format($q$insert into public.platform_invoices (restaurant_id, subscription_id, amount, period_start, period_end, status) values (%L, %L, 1, current_date, current_date, 'paid')$q$, (select a from _f), (select a_sub from _f))),
          '42501|permission denied for table platform_invoices|'::text, 'tenant admin cannot insert invoices');
select is(tests.run($q$update public.platform_invoices set status = 'paid'$q$), '42501|permission denied for table platform_invoices|', 'tenant admin cannot mark invoices paid');
select is(tests.run(format($q$insert into public.platform_admins (id, full_name, role) values (%L, 'Self promote', 'platform_super_admin')$q$, (select a_admin from _f))),
          '42501|permission denied for table platform_admins|', 'tenant admin cannot make itself a platform admin');
select is(tests.run($q$update public.platform_admins set role = 'platform_super_admin', is_active = true$q$), '42501|permission denied for table platform_admins|', 'tenant admin cannot modify platform admins');
select is(tests.run($q$insert into public.admin_audit_log (action) values ('forged')$q$),
          '42501|permission denied for table admin_audit_log|', 'tenant admin cannot write admin_audit_log');
select is(tests.run($q$update public.restaurants set status = 'active', slug = 'hijack', custom_domain = 'evil.example.com'$q$),
          '42501|permission denied for table restaurants|', 'status / slug / custom_domain are not tenant-writable');
select is(tests.run($q$update public.restaurants set suspended_at = null, suspension_reason = null$q$),
          '42501|permission denied for table restaurants|', 'a tenant cannot clear its own suspension fields');
select is(tests.run(format($q$select public.fn_suspend_tenant(%L, 'self-service')$q$, (select a from _f))), 'P0001|permission_denied|', 'tenant admin cannot suspend (own tenant)');
select is(tests.run(format($q$select public.fn_suspend_tenant(%L, 'self-service')$q$, (select b from _f))), 'P0001|permission_denied|', 'tenant admin cannot suspend (other tenant)');
select is(tests.run(format($q$select public.fn_reactivate_tenant(%L, 'self-service')$q$, (select a from _f))), 'P0001|permission_denied|', 'tenant admin cannot reactivate');
select is(tests.run(format($q$select public.fn_provision_tenant('Evil', 'evil-cafe', gen_random_uuid(), 'e@e.example.com', 'E', null, null, %L, null)$q$, (select plan_id from _f))),
          'P0001|permission_denied|', 'tenant admin cannot provision a tenant');
select is(tests.run($q$select public.fn_verify_pin(gen_random_uuid(), '1234')$q$), '42501|permission denied for function fn_verify_pin|', 'tenant admin cannot call fn_verify_pin');
select is(tests.run($q$select public.fn_set_user_pin(gen_random_uuid(), '1234')$q$), '42501|permission denied for function fn_set_user_pin|', 'tenant admin cannot call fn_set_user_pin');
select is(tests.run($q$select public.fn_register_pin_failure(gen_random_uuid())$q$), '42501|permission denied for function fn_register_pin_failure|', 'tenant admin cannot call fn_register_pin_failure');
select ok(not public.is_platform_admin() and not public.is_platform_super_admin(), 'tenant admin is no kind of platform admin');
select tests.clear_auth();

-- ═════════ tenant waiter ═════════
select tests.authenticate_as((select a_waiter from _f));
select is(tests.run(format($q$select public.fn_suspend_tenant(%L, 'waiter says no')$q$, (select a from _f))), 'P0001|permission_denied|', 'waiter cannot suspend');
select is(tests.run($q$insert into public.plans (name, price_etb_monthly) values ('x', 0)$q$),
          '42501|permission denied for table plans|', 'waiter cannot create plans');
select is((select count(*)::int from public.admin_audit_log) + (select count(*)::int from public.platform_admins), 0, 'waiter reads no platform tables');
select tests.clear_auth();

-- ═════════ anonymous ═════════
select tests.as_anon();
select is(tests.run('select 1 from public.platform_admins'), '42501|permission denied for table platform_admins|', 'anon: platform_admins');
select is(tests.run('select 1 from public.admin_audit_log'), '42501|permission denied for table admin_audit_log|', 'anon: admin_audit_log');
select is(tests.run('select 1 from public.subscriptions'), '42501|permission denied for table subscriptions|', 'anon: subscriptions');
select is(tests.run('select 1 from public.restaurants'), '42501|permission denied for table restaurants|', 'anon: restaurants');
select is(tests.run($q$insert into public.plans (name, price_etb_monthly) values ('x', 0)$q$), '42501|permission denied for table plans|', 'anon cannot write plans');
select is(tests.run(format($q$insert into public.platform_admins (id, full_name, role) values (gen_random_uuid(), 'x', 'platform_super_admin')$q$)), '42501|permission denied for table platform_admins|', 'anon cannot insert platform_admins');
select is(tests.run(format($q$select public.fn_suspend_tenant(%L, 'anon attack')$q$, (select a from _f))), '42501|permission denied for function fn_suspend_tenant|', 'anon cannot call fn_suspend_tenant');
select is(tests.run(format($q$select public.fn_reactivate_tenant(%L, 'anon attack')$q$, (select a from _f))), '42501|permission denied for function fn_reactivate_tenant|', 'anon cannot call fn_reactivate_tenant');
select is(tests.run($q$select public.fn_provision_tenant('E', 'evil-cafe', gen_random_uuid(), 'e@e.example.com', 'E', null, null, gen_random_uuid(), null)$q$),
          '42501|permission denied for function fn_provision_tenant|', 'anon cannot call fn_provision_tenant');
select is(tests.run($q$select public.fn_verify_pin(gen_random_uuid(), '1234')$q$), '42501|permission denied for function fn_verify_pin|', 'anon cannot call fn_verify_pin');
select is(tests.run($q$select public.fn_set_user_pin(gen_random_uuid(), '1234')$q$), '42501|permission denied for function fn_set_user_pin|', 'anon cannot call fn_set_user_pin');
select is(tests.run($q$select public.fn_register_pin_failure(gen_random_uuid())$q$), '42501|permission denied for function fn_register_pin_failure|', 'anon cannot call fn_register_pin_failure');
select is(tests.run($q$select public.fn_user_auth_method(gen_random_uuid())$q$), '42501|permission denied for function fn_user_auth_method|', 'anon cannot call fn_user_auth_method');
select is(tests.run($q$select public.fn_get_session_context()$q$), '42501|permission denied for function fn_get_session_context|', 'anon cannot call fn_get_session_context');
select tests.clear_auth();

-- ═════════ platform_support: read-only staff ═════════
select tests.aal2((select support_admin from _f));
select ok(public.is_platform_admin() and not public.is_platform_super_admin(), 'support is a platform admin but not a super admin');
select is((select count(*)::int from public.restaurants), 2, 'support lists every tenant');
select is((select count(*)::int from public.platform_admins), 2, 'support sees the platform admin roster');
select is((select public.current_restaurant_id()), null::uuid, 'support has no tenant identity');
select is(tests.run(format($q$select public.fn_suspend_tenant(%L, 'support cannot suspend')$q$, (select a from _f))), 'P0001|permission_denied|', 'support cannot suspend tenants');
select is(tests.run($q$insert into public.plans (name, price_etb_monthly) values ('x', 0)$q$),
          '42501|permission denied for table plans|', 'support cannot write plans');
select is(tests.run(format($q$insert into public.platform_admins (id, full_name, role) values (%L, 'x', 'platform_super_admin')$q$, (select a_admin from _f))),
          '42501|permission denied for table platform_admins|', 'support cannot add platform admins');
select is(tests.run(format($q$update public.platform_admins set role = 'platform_super_admin' where id = %L$q$, (select support_admin from _f))), '42501|permission denied for table platform_admins|', 'support cannot promote itself');
select is(tests.run(format($q$select public.fn_provision_tenant('Evil', 'evil-cafe', gen_random_uuid(), 'e@e.example.com', 'E', null, null, %L, null)$q$, (select plan_id from _f))),
          'P0001|permission_denied|', 'support cannot provision tenants');
select tests.clear_auth();

-- ═════════ platform_super_admin: platform power, but no tenant business data ═════════
select tests.aal2((select super_admin from _f));
select ok(public.is_platform_super_admin(), 'super admin recognised via platform_admins only');
select is((select public.current_restaurant_id()), null::uuid, 'super admin has no tenant identity');
select is((select count(*)::int from public.restaurants), 2, 'super admin lists every tenant');
select ok(not public.has_permission('orders.view') and not public.has_permission('users.manage') and not public.is_tenant_admin(),
          'super admin holds no tenant permission through the tenant helpers');
select is(tests.run($q$select count(*) from public.profiles$q$), 'ok:1', 'profiles query runs');
select is((select count(*)::int from public.profiles) + (select count(*)::int from public.roles) + (select count(*)::int from public.menu_items)
          + (select count(*)::int from public.audit_logs) + (select count(*)::int from public.stations), 0, 'super admin reads no tenant business rows');
select is(tests.run(format($q$insert into public.stations (restaurant_id, name) values (%L, 'Platform-made')$q$, (select a from _f))),
          '42501|new row violates row-level security policy for table "stations"|', 'super admin cannot write tenant config directly');
select is(tests.run('select 1 from public.profile_secrets'), '42501|permission denied for table profile_secrets|', 'super admin cannot read PIN secrets');
select is(tests.run($q$update public.restaurants set status = 'active'$q$), '42501|permission denied for table restaurants|', 'super admin cannot rewrite status outside fn_suspend/fn_reactivate (column grants)');
select is(tests.run($q$insert into public.admin_audit_log (action) values ('forged')$q$), '42501|permission denied for table admin_audit_log|', 'super admin cannot forge admin_audit_log rows');
select is(tests.run($q$update public.admin_audit_log set action = 'x'$q$), '42501|permission denied for table admin_audit_log|', 'super admin cannot edit admin_audit_log rows');
select is(tests.run(format($q$insert into public.platform_admins (id, full_name, role) values (%L, 'Dual Identity', 'platform_support')$q$, (select a_waiter from _f))),
          '42501|permission denied for table platform_admins|', 'no client INSERT on platform_admins at all (0030; ops registers super admins)');
select tests.clear_auth();
select is(tests.run(format($q$insert into public.platform_admins (id, full_name, role) values (%L, 'Dual Identity', 'platform_support')$q$, (select a_waiter from _f))),
          'P0001|auth_method_mismatch|tenant staff cannot become platform admins', 'a tenant staff account cannot also be made a platform admin, on any path (identities stay disjoint)');
select tests.aal2((select super_admin from _f));
select lives_ok(format($q$select public.fn_suspend_tenant(%L, 'boundary test suspension')$q$, (select b from _f)), 'super admin suspends a tenant');
select tests.clear_auth();
select is((select platform_admin_id from public.admin_audit_log where action = 'tenant.suspend' and restaurant_id = (select b from _f)),
          (select super_admin from _f), 'admin_audit_log records the real platform admin as actor');
select is((select actor_type from public.audit_logs where event = 'tenant.suspended' and restaurant_id = (select b from _f)), 'platform_admin', 'tenant audit row marks the actor as platform_admin');
select is((select actor_id from public.audit_logs where event = 'tenant.suspended' and restaurant_id = (select b from _f)), (select super_admin from _f), 'tenant audit row carries the real actor id');
select is((select count(*)::int from public.admin_audit_log), (select admin_audit::int from _snap) + 2, 'the suspension added exactly two admin audit rows: the semantic tenant.suspend row and the subscriptions.status mirror row');

-- ═════════ untouched ═════════
select is((select count(*)::int from public.plans), (select plans::int from _snap), 'no plan was created or removed');
select is((select count(*)::int from public.platform_admins), (select admins::int from _snap), 'platform_admins roster unchanged by every attack');
select is(tests.snapshot((select a from _f)), (select a from _snap), 'tenant A unchanged by every attack');

select * from finish();
rollback;
