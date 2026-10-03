-- SM6: platform audit, last super admin, composite billing FK, status mirror, MFA (aal2) gate, tenant-admin step-up.
begin;
select plan(36);

create temp table _f on commit drop as
select tests.tenant_id('central-cafe') a, tests.tenant_id('second-cafe') b,
       '00000000-0000-4000-8000-0000000000c1'::uuid su1,
       '00000000-0000-4000-8000-0000000000c3'::uuid su2,
       tests.user_id('selam', 'central-cafe') a_admin, tests.user_id('yonas', 'central-cafe') a_waiter,
       (select id from public.subscriptions where restaurant_id = tests.tenant_id('central-cafe')) a_sub,
       (select id from public.subscriptions where restaurant_id = tests.tenant_id('second-cafe')) b_sub,
       (select id from public.plans where name = 'Growth') plan_id;
grant all on _f to public;
do $$ begin perform tests.create_auth_user('00000000-0000-4000-8000-0000000000c3', 'second.super@cafeos.example.com'); end $$;

-- ═════════ audit triggers ═════════
select tests.authenticate_as((select su1 from _f));
select lives_ok($q$insert into public.plans (name, price_etb_monthly) values ('Audit Plan', 10)$q$, 'super admin creates a plan');
select lives_ok($q$update public.plans set price_etb_monthly = 20 where name = 'Audit Plan'$q$, 'and changes its price');
select lives_ok(format($q$insert into public.platform_admins (id, full_name, role) values (%L, 'Second Super', 'platform_super_admin')$q$, (select su2 from _f)), 'and adds a second super admin');
select lives_ok(format($q$insert into public.platform_invoices (restaurant_id, subscription_id, amount, period_start, period_end, status) values (%L, %L, 99, current_date, current_date, 'pending')$q$, (select a from _f), (select a_sub from _f)), 'and issues an invoice');
select tests.clear_auth();
select is((select count(*)::int from public.admin_audit_log where action = 'plans.insert' and platform_admin_id = (select su1 from _f)), 1, 'plans.insert audited with the real actor');
select is((select detail -> 'new' ->> 'price_etb_monthly' from public.admin_audit_log where action = 'plans.update' and platform_admin_id = (select su1 from _f)), '20.00', 'plans.update carries only the changed column');
select is((select count(*)::int from public.admin_audit_log where action = 'platform_admins.insert' and platform_admin_id = (select su1 from _f)), 1, 'platform_admins.insert audited');
select is((select restaurant_id from public.admin_audit_log where action = 'platform_invoices.insert'), (select a from _f), 'platform_invoices.insert audited with its tenant');

-- ═════════ platform_admins columns / last super admin ═════════
select tests.authenticate_as((select su1 from _f));
select is(tests.run(format($q$update public.platform_admins set id = gen_random_uuid() where id = %L$q$, (select su2 from _f))), '42501|permission denied for table platform_admins|', 'platform_admins.id is not updatable');
select is(tests.run(format($q$update public.platform_admins set created_at = now() where id = %L$q$, (select su2 from _f))), '42501|permission denied for table platform_admins|', 'nor created_at');
select lives_ok(format($q$update public.platform_admins set is_active = false where id = %L$q$, (select su2 from _f)), 'one of two super admins can be deactivated');
select is(tests.run(format($q$update public.platform_admins set is_active = false where id = %L$q$, (select su1 from _f))), 'P0001|last_platform_super_admin|', 'the last active super admin cannot be deactivated');
select is(tests.run(format($q$update public.platform_admins set role = 'platform_support' where id = %L$q$, (select su1 from _f))), 'P0001|last_platform_super_admin|', 'nor demoted');
select tests.clear_auth();
select is(tests.run(format($q$delete from public.platform_admins where id = %L$q$, (select su1 from _f))), 'P0001|last_platform_super_admin|', 'nor deleted (even by the owner)');
update public.platform_admins set is_active = true where id = (select su2 from _f);
select is(tests.run(format($q$delete from public.platform_admins where id = %L$q$, (select su2 from _f))), 'ok:1', 'with two active, one can be removed');
insert into public.platform_admins (id, full_name, role) select su2, 'Second Super', 'platform_super_admin' from _f;

-- ═════════ composite billing FK ═════════
select tests.authenticate_as((select su1 from _f));
select matches(tests.run(format($q$insert into public.platform_invoices (restaurant_id, subscription_id, amount, period_start, period_end, status) values (%L, %L, 1, current_date, current_date, 'pending')$q$, (select a from _f), (select b_sub from _f))),
               '^23503\|', 'an invoice cannot reference another tenant''s subscription');
select tests.clear_auth();

-- ═════════ subscriptions <-> restaurants status mirror ═════════
select tests.authenticate_as((select su1 from _f));
select lives_ok(format($q$update public.subscriptions set status = 'past_due' where id = %L$q$, (select a_sub from _f)), 'billing marks the subscription past_due');
select tests.clear_auth();
select is((select status from public.restaurants where id = (select a from _f)), 'past_due', 'subscription -> restaurant: access status follows');
update public.restaurants set status = 'active' where id = (select a from _f);
select is((select status from public.subscriptions where id = (select a_sub from _f)), 'active', 'restaurant -> subscription: mirror follows');
select tests.authenticate_as((select su1 from _f));
select is(tests.run(format($q$update public.subscriptions set status = 'suspended' where id = %L$q$, (select a_sub from _f))), 'P0001|use_suspend_rpc|suspension changes go through fn_suspend_tenant / fn_reactivate_tenant', 'entering suspended is only possible through fn_suspend_tenant');
select lives_ok(format($q$select public.fn_suspend_tenant(%L, 'mirror test')$q$, (select a from _f)), 'fn_suspend_tenant');
select tests.clear_auth();
select is((select status from public.subscriptions where id = (select a_sub from _f)), 'suspended', 'suspension reaches the subscription');
select tests.authenticate_as((select su1 from _f));
select is(tests.run(format($q$update public.subscriptions set status = 'active' where id = %L$q$, (select a_sub from _f))), 'P0001|use_suspend_rpc|suspension changes go through fn_suspend_tenant / fn_reactivate_tenant', 'leaving suspended is only possible through fn_reactivate_tenant');
select lives_ok(format($q$select public.fn_reactivate_tenant(%L, 'mirror test')$q$, (select a from _f)), 'fn_reactivate_tenant');
select tests.clear_auth();
select is((select status from public.subscriptions where id = (select a_sub from _f)), (select status from public.restaurants where id = (select a from _f)), 'mirror consistent after reactivation');

-- ═════════ MFA gate for platform admins ═════════
create function tests.claims(p_uid uuid, p_aal text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated', 'aal', p_aal)::text, true);
  perform set_config('request.jwt.claim.sub', p_uid::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  execute 'set local role authenticated';
end $$;
grant execute on function tests.claims(uuid, text) to public;
select set_config('app.platform_mfa_required', 'on', true);
select tests.claims((select su1 from _f), 'aal1');
select ok(not public.is_platform_super_admin() and not public.is_platform_admin(), 'required + aal1: not a platform admin at all');
select is((select count(*)::int from public.restaurants), 0, 'required + aal1: no tenant visible');
select tests.clear_auth();
select tests.claims((select su1 from _f), 'aal2');
select ok(public.is_platform_super_admin(), 'required + aal2: super admin');
select is((select (public.fn_get_session_context() ->> 'platform_mfa')::boolean), true, 'session context reports platform_mfa');
select tests.clear_auth();
select set_config('app.platform_mfa_required', 'off', true);
select tests.claims((select su1 from _f), 'aal1');
select ok(public.is_platform_super_admin(), 'opted out (local/CI) + no verified factor: aal1 is enough');
select tests.clear_auth();
select tests.add_verified_factor(su1) from _f;
select tests.claims((select su1 from _f), 'aal1');
select ok(not public.is_platform_super_admin(), 'opted out but a verified factor exists: aal1 is refused (no downgrade)');
select tests.clear_auth();
select set_config('app.platform_mfa_required', '', true);
select tests.claims((select su2 from _f), 'aal1');
select ok(not public.is_platform_super_admin(), 'GUC unset = required (production default)');
select tests.clear_auth();
select set_config('app.platform_mfa_required', 'off', true);
delete from auth.mfa_factors;

-- ═════════ tenant-admin step-up ═════════
select tests.add_verified_factor(a_admin) from _f;
select tests.claims((select a_admin from _f), 'aal1');
select is(tests.run(format($q$select public.fn_change_user_role(%L, %L)$q$, (select a_waiter from _f), (select id from public.roles where restaurant_id = (select a from _f) and name = 'Cashier'))), 'P0001|mfa_required|', 'enrolled admin on aal1: fn_change_user_role needs step-up');
select is(tests.run(format($q$select public.fn_update_role_permissions(%L, array['orders.view'], array[]::uuid[])$q$, (select id from public.roles where restaurant_id = (select a from _f) and name = 'Cashier'))), 'P0001|mfa_required|', 'and fn_update_role_permissions');
select tests.clear_auth();
select tests.claims((select a_admin from _f), 'aal2');
select is(tests.run(format($q$select public.fn_change_user_role(%L, %L)$q$, (select a_waiter from _f), (select id from public.roles where restaurant_id = (select a from _f) and name = 'Cashier'))), 'ok:1', 'on aal2 the same call works');
select tests.clear_auth();
delete from auth.mfa_factors;
select set_config('app.tenant_admin_mfa_required', 'on', true);
select tests.claims((select a_admin from _f), 'aal1');
select is(tests.run(format($q$select public.fn_change_user_role(%L, %L)$q$, (select a_waiter from _f), (select id from public.roles where restaurant_id = (select a from _f) and name = 'Waiter'))), 'P0001|mfa_required|', 'app.tenant_admin_mfa_required = on forces step-up even without an enrolled factor');
select tests.clear_auth();

select * from finish();
rollback;
