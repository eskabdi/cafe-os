-- Phase 3B, Platform Admin Portal RPCs (migration 0030): functional + validation + audit + replay.
-- Actor: the demo super admin on aal2 with a verified factor (tests.aal2). Separation / aal1 / tenant callers: 34_portal_separation.
begin;
select plan(88);

create temp table _f on commit drop as
select tests.tenant_id('central-cafe') a, tests.tenant_id('second-cafe') b,
       '00000000-0000-4000-8000-0000000000c1'::uuid su,
       tests.user_id('selam', 'central-cafe') a_admin,
       (select id from public.plans where name = 'Starter') starter, (select id from public.plans where name = 'Growth') growth,
       (select id from public.plans where name = 'Pro') pro,
       (select count(*)::int from public.profiles where restaurant_id = tests.tenant_id('central-cafe') and is_active) a_staff,
       (select count(*)::int from public.menu_items where restaurant_id = tests.tenant_id('central-cafe') and is_active) a_items;
grant all on _f to public;
create temp table _c (k text primary key, v text) on commit drop;
grant all on _c to public;

select tests.aal2((select su from _f));

-- ═════════ tenant list / detail ═════════
select is((select (public.fn_platform_list_tenants() ->> 'total')::int), 2, 'list: every tenant');
select is((select jsonb_array_length(public.fn_platform_list_tenants() -> 'items')), 2, 'list: items');
select is((select public.fn_platform_list_tenants('SECOND') -> 'items' -> 0 ->> 'slug'), 'second-cafe', 'search is case-insensitive over name and slug');
select is((select (public.fn_platform_list_tenants('100%_') ->> 'total')::int), 0, 'search escapes LIKE wildcards');
select is((select (public.fn_platform_list_tenants(null, 'active', (select starter from _f)) ->> 'total')::int), 1, 'filter by status and plan');
select is((select (public.fn_platform_list_tenants(null, null, null, 1, 0) -> 'items' -> 0 ->> 'id') <> (public.fn_platform_list_tenants(null, null, null, 1, 1) -> 'items' -> 0 ->> 'id')),
          true, 'offset paging: page 2 is a different tenant (stable order created_at desc, id desc)');
select is((select public.fn_platform_list_tenants('second') -> 'items' -> 0 -> 'plan' ->> 'name'), 'Starter', 'items carry the plan');
select is(tests.run('select public.fn_platform_list_tenants(null, null, null, 0)'), 'P0001|invalid_input|limit', 'limit 1..100');
select is(tests.run($q$select public.fn_platform_list_tenants(null, 'deleted')$q$), 'P0001|invalid_input|status', 'status must be a real status');
select is(tests.run(format($q$select public.fn_platform_list_tenants(%L)$q$, repeat('x', 101))), 'P0001|invalid_input|search', 'search length is bounded');
select is(tests.run('select public.fn_platform_get_tenant(gen_random_uuid())'), 'P0001|not_found|', 'detail of an unknown tenant: not_found');
select is((select public.fn_platform_get_tenant((select a from _f)) -> 'limits' ->> 'max_staff'), '25', 'detail: plan limits');
select is((select (public.fn_platform_get_tenant((select a from _f)) -> 'usage' ->> 'active_staff')::int),
          (select a_staff from _f), 'detail: active staff counter');
select is((select (public.fn_platform_get_tenant((select a from _f)) -> 'usage' ->> 'menu_items')::int),
          (select a_items from _f), 'detail: menu item counter');
select is((select public.fn_platform_get_tenant((select a from _f)) -> 'subscription' -> 'plan' ->> 'name'), 'Growth', 'detail: subscription and plan');

-- ═════════ provisioning without an owner ═════════
select is(tests.run(format($q$select public.fn_platform_create_tenant('Admin Cafe', 'admin', %L)$q$, (select growth from _f))), 'P0001|invalid_slug|', 'reserved slug refused');
select is(tests.run(format($q$select public.fn_platform_create_tenant('Bad', 'Bad Slug', %L)$q$, (select growth from _f))), 'P0001|invalid_slug|', 'malformed slug refused');
select is(tests.run(format($q$select public.fn_platform_create_tenant('Dup', 'central-cafe', %L)$q$, (select growth from _f))), 'P0001|slug_taken|', 'taken slug refused');
select is(tests.run(format($q$select public.fn_platform_create_tenant('', 'blank-cafe', %L)$q$, (select growth from _f))), 'P0001|invalid_input|name', 'name required');
select is(tests.run('select public.fn_platform_create_tenant($$X$$, $$x-cafe$$, gen_random_uuid())'), 'P0001|invalid_plan|', 'unknown plan refused');
select is(tests.run(format($q$select public.fn_platform_create_tenant('X', 'x-cafe', %L, 14, 'Mars/Olympus')$q$, (select growth from _f))), 'P0001|invalid_timezone|', 'bogus timezone refused');
select is(tests.run(format($q$select public.fn_platform_create_tenant('X', 'x-cafe', %L, 91)$q$, (select growth from _f))), 'P0001|invalid_input|trial_days', 'trial 0..90 days');
insert into _c select 'new', public.fn_platform_create_tenant('Third Cafe', 'third-cafe', (select growth from _f)) ->> 'restaurant_id';
select tests.clear_auth();   -- the checks below read tenant rows (the super admin cannot: 34_portal_separation)
select is((select status from public.restaurants where id = (select v::uuid from _c where k = 'new')), 'trialing', 'new tenant is trialing');
select is((select status from public.subscriptions where restaurant_id = (select v::uuid from _c where k = 'new')), 'trialing', 'with a trialing subscription on the chosen plan');
select is((select count(*)::int from public.roles where restaurant_id = (select v::uuid from _c where k = 'new') and system_key = 'tenant_admin'), 1, 'default configuration seeded (tenant_admin role)');
select is((select count(*)::int from public.profiles where restaurant_id = (select v::uuid from _c where k = 'new')), 0, 'no profile: the first Tenant Admin is invited');
select is((select opened_by from public.day_sessions where restaurant_id = (select v::uuid from _c where k = 'new') and status = 'open'), null::uuid, 'day 1 is open (no opener yet)');
select tests.aal2((select su from _f));
select is(tests.run(format($q$select public.fn_platform_create_tenant('Third Cafe', 'third-cafe', %L)$q$, (select growth from _f))), 'P0001|slug_taken|', 'replay with the same slug creates nothing (slug_taken)');
select tests.clear_auth();
select is((select platform_admin_id from public.admin_audit_log where action = 'tenant.provision' and restaurant_id = (select v::uuid from _c where k = 'new')), (select su from _f), 'admin_audit_log: tenant.provision by the super admin');
select is((select actor_type from public.audit_logs where event = 'tenant.provisioned' and restaurant_id = (select v::uuid from _c where k = 'new')), 'platform_admin', 'tenant audit: provisioned by a platform admin');
select tests.aal2((select su from _f));

-- ═════════ plan change / billing status ═════════
select is(tests.run(format($q$select public.fn_platform_change_plan(%L, %L, 'x')$q$, (select a from _f), (select pro from _f))), 'P0001|invalid_input|reason', 'a reason (3..500) is mandatory');
select is((select public.fn_platform_change_plan((select a from _f), (select pro from _f), 'upgrade requested') ->> 'changed'), 'true', 'change plan');
select is((select plan_id from public.subscriptions where restaurant_id = (select a from _f)), (select pro from _f), 'the subscription follows');
select is((select public.fn_platform_change_plan((select a from _f), (select pro from _f), 'again') ->> 'changed'), 'false', 'same plan again: no-op');
select is((select public.fn_platform_change_plan((select a from _f), (select starter from _f), 'downgrade test') -> 'over_quota'), '[]'::jsonb,
          'downgrade reports the counters over the new quota (none here)');
select is((select count(*)::int from public.admin_audit_log where action = 'subscription.plan_changed' and restaurant_id = (select a from _f) and platform_admin_id = (select su from _f)), 2,
          'each real plan change is audited (the no-op is not)');
select is(tests.run(format($q$select public.fn_platform_change_plan(%L, gen_random_uuid(), 'bad plan')$q$, (select a from _f))), 'P0001|invalid_plan|', 'unknown plan refused');
select is(tests.run(format($q$select public.fn_platform_change_plan(gen_random_uuid(), %L, 'nobody')$q$, (select pro from _f))), 'P0001|not_found|', 'unknown tenant: not_found');
select is((select public.fn_platform_set_billing_status((select a from _f), 'past_due', 'invoice overdue') ->> 'status'), 'past_due', 'billing status past_due');
select is((select status from public.restaurants where id = (select a from _f)) || '/' || (select status from public.subscriptions where restaurant_id = (select a from _f)),
          'past_due/past_due', 'restaurant (access) and subscription (mirror) agree');
select is((select public.fn_platform_set_billing_status((select a from _f), 'past_due', 'again') ->> 'changed'), 'false', 'replay: no-op');
select is(tests.run(format($q$select public.fn_platform_set_billing_status(%L, 'suspended', 'wrong door')$q$, (select a from _f))), 'P0001|invalid_input|status', 'suspension is not a billing status (own RPC)');
select lives_ok(format($q$select public.fn_platform_set_billing_status(%L, 'active', 'invoice paid')$q$, (select a from _f)), 'back to active');

-- ═════════ cancellation (terminal) ═════════
select is(tests.run(format($q$select public.fn_platform_cancel_tenant(%L, 'closing down', 'wrong-slug')$q$, (select v from _c where k = 'new'))), 'P0001|invalid_input|confirm_slug', 'the slug must be confirmed');
select is((select public.fn_platform_cancel_tenant((select v::uuid from _c where k = 'new'), 'closing down', 'third-cafe') ->> 'status'), 'cancelled', 'cancel');
select is((select status from public.subscriptions where restaurant_id = (select v::uuid from _c where k = 'new')), 'cancelled', 'the subscription mirror follows');
select is((select public.fn_platform_cancel_tenant((select v::uuid from _c where k = 'new'), 'closing down', 'third-cafe') ->> 'changed'), 'false', 'replay: no-op');
select is(tests.run(format($q$select public.fn_reactivate_tenant(%L, 'resurrect')$q$, (select v from _c where k = 'new'))), 'P0001|invalid_state|cancelled', 'cancellation is terminal');
select is(tests.run(format($q$select public.fn_platform_change_plan(%L, %L, 'after cancel')$q$, (select v from _c where k = 'new'), (select pro from _f))), 'P0001|invalid_state|cancelled', 'no plan change after cancellation');
select is((select count(*)::int from public.restaurants where id = (select v::uuid from _c where k = 'new')), 1, 'nothing is deleted');

-- ═════════ plans catalogue ═════════
select is(tests.run($q$select public.fn_platform_create_plan('{"name": "Enterprise"}')$q$), 'P0001|invalid_input|price_etb_monthly', 'price required');
select is(tests.run($q$select public.fn_platform_create_plan('{"name": "Enterprise", "price_etb_monthly": 10.005}')$q$), 'P0001|invalid_input|price_etb_monthly', 'price has at most 2 decimals (never rounded silently)');
select is(tests.run($q$select public.fn_platform_create_plan('{"name": "Enterprise", "price_etb_monthly": 10, "max_staff": 0}')$q$), 'P0001|invalid_input|max_staff', 'limits are positive integers or null');
select is(tests.run($q$select public.fn_platform_create_plan('{"name": "Enterprise", "price_etb_monthly": 10, "features": {"Bad Key": true}}')$q$), 'P0001|invalid_input|features', 'feature keys are validated');
select is(tests.run($q$select public.fn_platform_create_plan('{"name": "Enterprise", "price_etb_monthly": 10, "id": "x"}')$q$), 'P0001|invalid_input|patch', 'closed key list');
select is(tests.run($q$select public.fn_platform_create_plan('{"name": "Growth", "price_etb_monthly": 10}')$q$), 'P0001|duplicate_name|Growth', 'duplicate name');
insert into _c select 'plan', public.fn_platform_create_plan('{"name": "Enterprise", "price_etb_monthly": 9990, "max_staff": 100, "max_kiosks": 10, "max_storage_bytes": 1073741824, "features": {"installments": true}}') ->> 'id';
select is((select max_kiosks from public.plans where id = (select v::uuid from _c where k = 'plan')), 10, 'plan created with the new quota columns');
select is((select public.fn_platform_update_plan((select v::uuid from _c where k = 'plan'), '{"max_kiosks": null, "description": "Large chains"}') ->> 'max_kiosks'), null, 'update: null = unlimited');
select is((select count(*)::int from public.admin_audit_log where action = 'plan.updated'), 1, 'semantic plan.updated audit');
select is((select public.fn_platform_update_plan((select v::uuid from _c where k = 'plan'), '{"description": "Large chains"}') ->> 'description'), 'Large chains', 'no-op update');
select is((select count(*)::int from public.admin_audit_log where action = 'plan.updated'), 1, 'a no-op update writes no semantic audit row');
select is((select public.fn_platform_set_plan_active((select v::uuid from _c where k = 'plan'), false) ->> 'is_active'), 'false', 'deactivate a plan');
select is(tests.run(format($q$select public.fn_platform_create_tenant('Fourth', 'fourth-cafe', %L)$q$, (select v from _c where k = 'plan'))), 'P0001|invalid_plan|', 'an inactive plan cannot be provisioned');
select is((select (p ->> 'subscriber_count')::int from jsonb_array_elements(public.fn_platform_list_plans()) p where p ->> 'name' = 'Starter'), 2,
          'list_plans carries subscriber counts');

-- ═════════ invoices ═════════
insert into _c select 'inv', public.fn_platform_create_invoice((select a from _f), 2490, current_date, current_date + 29) ->> 'id';
select is((select status from public.platform_invoices where id = (select v::uuid from _c where k = 'inv')), 'pending', 'invoice created pending');
select is(tests.run(format($q$select public.fn_platform_create_invoice(%L, 2490, current_date, current_date + 29)$q$, (select a from _f))), 'P0001|invalid_state|invoice_exists', 'replay of the same period bills nothing twice');
select is(tests.run(format($q$select public.fn_platform_create_invoice(%L, 1.234, current_date, current_date)$q$, (select b from _f))), 'P0001|invalid_input|amount', 'amount has at most 2 decimals');
select is(tests.run(format($q$select public.fn_platform_set_invoice_status(%L, 'paid')$q$, (select v from _c where k = 'inv'))), 'P0001|invalid_input|method', 'paid needs a method');
select is(tests.run(format($q$select public.fn_platform_set_invoice_status(%L, 'paid', 'bitcoin')$q$, (select v from _c where k = 'inv'))), 'P0001|invalid_input|method', 'unknown method refused');
select is((select public.fn_platform_set_invoice_status((select v::uuid from _c where k = 'inv'), 'paid', 'manual_bank_transfer', 'TRX-1') ->> 'status'), 'paid', 'mark paid');
select is(tests.run(format($q$select public.fn_platform_set_invoice_status(%L, 'void')$q$, (select v from _c where k = 'inv'))), 'P0001|invalid_state|paid', 'paid is final');
select is((select jsonb_array_length(public.fn_platform_list_invoices((select a from _f)))), 1, 'list invoices of a tenant');
select is(tests.run('select public.fn_platform_list_invoices(null, null, 50, null, gen_random_uuid())'), 'P0001|invalid_input|before', 'keyset needs both cursor parts');

-- ═════════ health + backups ═════════
select is((select public.fn_platform_system_health() -> 'database' ->> 'reachable'), 'true', 'health: database reachable');
select ok((select public.fn_platform_system_health() ?& array['checked_at', 'database', 'migrations', 'largest_tables', 'storage', 'tenants', 'counters', 'backups']), 'health: every section');
select is((select public.fn_platform_system_health() -> 'backups' ->> 'stale'), 'true', 'no successful backup yet: stale');
select tests.clear_auth();
select tests.authenticate_as_service_role();
select lives_ok($q$insert into public.platform_backup_runs (kind, status, finished_at, size_bytes, checksum_sha256) values ('supabase_daily', 'succeeded', now(), 123456, repeat('a', 64))$q$,
                'the ops job (service role) records a backup run');
select is(tests.run($q$update public.platform_backup_runs set note = 'edited'$q$), 'P0001|immutable_record|a finished backup run is immutable', 'a finished run is immutable');
select is(tests.run($q$delete from public.platform_backup_runs$q$), '42501|permission denied for table platform_backup_runs|', 'backup runs are never deleted');
select tests.clear_auth();
select tests.aal2((select su from _f));
select is((select public.fn_platform_system_health() -> 'backups' ->> 'stale'), 'false', 'fresh successful backup: not stale');
select is((select public.fn_platform_list_backup_runs() -> 0 ->> 'size_bytes'), '123456', 'list backup runs');

-- ═════════ platform audit log / accounts ═════════
select is((select public.fn_platform_list_audit_log(1) -> 0 ->> 'action'), (select action from public.admin_audit_log order by created_at desc, id desc limit 1), 'audit log newest first');
select is((select count(*)::int from jsonb_array_elements(public.fn_platform_list_audit_log(200, null, null, (select a from _f))) e where (e -> 'restaurant' ->> 'id')::uuid <> (select a from _f)), 0, 'filter by tenant');
select is(tests.run($q$select public.fn_platform_list_audit_log(50, null, null, null, 'DROP TABLE')$q$), 'P0001|invalid_input|action_prefix', 'action prefix is validated');
select is((select (e ->> 'mfa_enrolled')::boolean and (e ->> 'is_self')::boolean from jsonb_array_elements(public.fn_platform_list_admins()) e where (e ->> 'id')::uuid = (select su from _f)), true, 'admins list: MFA and self flags');
select is(tests.run(format($q$select public.fn_platform_set_admin_active(%L, false, 'oops')$q$, (select su from _f))), 'P0001|invalid_state|self', 'no self-deactivation');
select is(tests.run('select public.fn_platform_set_admin_active(gen_random_uuid(), false, $$offboarding$$)'), 'P0001|not_found|', 'unknown admin: not_found');
select is(tests.run(format($q$select public.fn_ops_register_platform_admin(%L, 'Me again')$q$, (select su from _f))), '42501|permission denied for function fn_ops_register_platform_admin|', 'registering a Super Admin is not a client operation');
select tests.clear_auth();

select * from finish();
rollback;
