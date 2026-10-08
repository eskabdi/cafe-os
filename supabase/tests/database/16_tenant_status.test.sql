-- Adversarial: tenant lifecycle states. trialing / active: full access. past_due: read-only (reads, session and
-- PIN login still work, every write and write-RPC is refused). suspended / cancelled: no access of any kind,
-- indistinguishable from "no such tenant" for the resolver and the PIN check. Other tenants are unaffected.
begin;
select plan(53);

create temp table _f on commit drop as
select tests.tenant_id('central-cafe') a, tests.tenant_id('second-cafe') b,
       tests.user_id('selam', 'central-cafe') a_admin, tests.user_id('owner', 'second-cafe') b_admin,
       tests.user_id('waiter', 'second-cafe') b_waiter,
       tests.role_id('Waiter', 'second-cafe') b_waiter_role,
       '00000000-0000-4000-8000-0000000000c1'::uuid platform;
grant all on _f to public;

-- rows visible to the caller across every tenant table plus the restaurants row
create function tests.visible_total() returns bigint language plpgsql as $$
declare t text; n bigint; total bigint := 0;
begin
  for t in select tests.tenant_tables() loop
    begin
      execute format('select count(*) from public.%I', t) into n;
      total := total + n;
    exception when insufficient_privilege then null;
    end;
  end loop;
  select count(*) into n from public.restaurants;
  return total + n;
end $$;

-- ═════════ trialing and active: normal operation ═════════
update public.restaurants set status = 'trialing' where id = (select b from _f);
grant execute on all functions in schema tests to public;  -- default privileges no longer grant PUBLIC execute
select tests.authenticate_as((select b_admin from _f));
select is(tests.run(format($q$insert into public.stations (restaurant_id, name) values (%L, 'Trial station')$q$, (select b from _f))), 'ok:1', 'trialing: writes allowed');
select is(tests.run(format($q$select public.fn_update_role_permissions(%L, array['orders.view'], '{}')$q$, (select b_waiter_role from _f))), 'ok:1', 'trialing: write RPCs allowed');
select is((select (public.fn_get_session_context() ->> 'tenant_writable')::boolean), true, 'trialing: session context says writable');
select tests.clear_auth();
update public.restaurants set status = 'active' where id = (select b from _f);
select tests.authenticate_as((select b_admin from _f));
select is(tests.run(format($q$insert into public.stations (restaurant_id, name) values (%L, 'Active station')$q$, (select b from _f))), 'ok:1', 'active: writes allowed');
select is((select (public.fn_get_session_context() ->> 'tenant_writable')::boolean), true, 'active: session context says writable');
select tests.clear_auth();

-- ═════════ past_due: read-only ═════════
update public.restaurants set status = 'past_due' where id = (select b from _f);
create temp table _snap on commit drop as select tests.snapshot((select b from _f)) b_snap;
grant all on _snap to public;
select tests.authenticate_as((select b_admin from _f));
select ok(tests.visible_total() > 50, 'past_due: reads still work');
select is((select public.current_restaurant_id()), (select b from _f), 'past_due: tenant identity still resolves');
select is((select (public.fn_get_session_context() ->> 'tenant_writable')::boolean), false, 'past_due: session context says NOT writable (UI can show the banner)');
select is((select public.fn_get_session_context() -> 'restaurant' ->> 'status'), 'past_due', 'past_due: status is shown to the tenant');
select is(tests.run(format($q$insert into public.stations (restaurant_id, name) values (%L, 'Late')$q$, (select b from _f))), '42501|new row violates row-level security policy for table "stations"|', 'past_due: INSERT refused by RLS');
select is(tests.run($q$update public.stations set name = 'Late'$q$), 'ok:0', 'past_due: UPDATE changes nothing');
select is(tests.run($q$delete from public.stations$q$), 'ok:0', 'past_due: DELETE changes nothing');
select is(tests.run($q$update public.restaurants set name = 'Late'$q$), 'ok:0', 'past_due: settings cannot be edited');
select is(tests.run($q$update public.profiles set first_name = 'Late'$q$), 'ok:0', 'past_due: staff cannot be edited');
select is(tests.run(format($q$select public.fn_update_role_permissions(%L, array['orders.view'], '{}')$q$, (select b_waiter_role from _f))), 'P0001|tenant_read_only|', 'past_due: fn_update_role_permissions refused');
select is(tests.run(format($q$select public.fn_change_user_role(%L, %L)$q$, (select b_waiter from _f), (select b_waiter_role from _f))), 'P0001|tenant_read_only|', 'past_due: fn_change_user_role refused');
select tests.clear_auth();
select is(tests.snapshot((select b from _f)), (select b_snap from _snap), 'past_due: nothing changed');
select tests.authenticate_as_service_role();
select is((select public.fn_verify_pin((select b_waiter from _f), tests.pin_digest('3972')) ->> 'status'), 'ok', 'past_due: PIN login still works (read-only mode)');
select tests.clear_auth();

-- ═════════ suspended: no access at all ═════════
select tests.authenticate_as((select b_admin from _f));
select is(tests.run(format($q$select public.fn_suspend_tenant(%L, 'self suspend attempt')$q$, (select b from _f))), 'P0001|permission_denied|', 'a tenant cannot suspend itself (or anyone)');
select tests.clear_auth();
select tests.authenticate_as((select platform from _f));
select lives_ok(format($q$select public.fn_suspend_tenant(%L, 'non-payment of the invoice')$q$, (select b from _f)), 'platform super admin suspends the past_due tenant');
select is((select count(*)::int from public.restaurants where id = (select b from _f) and status = 'suspended'), 1, 'platform admin still sees the suspended tenant');
select is((select count(*)::int from public.subscriptions where restaurant_id = (select b from _f) and status = 'suspended'), 1, 'subscription is suspended with it');
select tests.clear_auth();
select tests.authenticate_as((select b_admin from _f));
select is((select public.current_restaurant_id()), null::uuid, 'suspended: identity resolves to no tenant');
select is(tests.visible_total(), 0::bigint, 'suspended: the tenant admin can read NOTHING (every tenant table and its own restaurants row)');
select ok(not public.has_permission('settings.manage') and not public.has_permission('orders.view') and not public.is_tenant_admin(), 'suspended: permission helpers deny everything');
select ok(not public.current_tenant_writable(), 'suspended: not writable');
select is((select public.fn_get_session_context()), null::jsonb, 'suspended: no session context');
select is(tests.run(format($q$insert into public.stations (restaurant_id, name) values (%L, 'Ghost')$q$, (select b from _f))), '42501|new row violates row-level security policy for table "stations"|', 'suspended: INSERT refused');
select is(tests.run($q$update public.stations set name = 'Ghost'$q$), 'ok:0', 'suspended: UPDATE changes nothing');
select is(tests.run($q$update public.restaurants set name = 'Ghost'$q$), 'ok:0', 'suspended: restaurant settings cannot be edited');
select is(tests.run(format($q$select public.fn_update_role_permissions(%L, array['orders.view'], '{}')$q$, (select b_waiter_role from _f))), 'P0001|tenant_suspended|', 'suspended: write RPC refused with tenant_suspended');
select is(tests.run(format($q$select public.fn_change_user_role(%L, %L)$q$, (select b_waiter from _f), (select b_waiter_role from _f))), 'P0001|tenant_suspended|', 'suspended: fn_change_user_role refused');
select is(tests.run(format($q$select public.fn_reactivate_tenant(%L, 'let me back in')$q$, (select b from _f))), 'P0001|permission_denied|', 'a suspended tenant cannot reactivate itself');
select tests.clear_auth();
select tests.authenticate_as((select b_waiter from _f));
select is(tests.visible_total(), 0::bigint, 'suspended: staff can read nothing either');
select tests.clear_auth();
select tests.authenticate_as_service_role();
select is((select public.fn_verify_pin((select b_waiter from _f), tests.pin_digest('3972')) ->> 'status'), 'invalid', 'suspended: even the correct PIN is refused (bare invalid)');
select tests.clear_auth();
select tests.as_anon();
select is((select public.fn_resolve_tenant_slug('second-cafe')), null::jsonb, 'suspended: the slug resolver answers exactly like an unknown slug');
select tests.clear_auth();
select tests.authenticate_as((select a_admin from _f));
select ok(tests.visible_total() > 50, 'the other tenant is unaffected');
select is(tests.run(format($q$insert into public.stations (restaurant_id, name) values (%L, 'A still works')$q$, (select a from _f))), 'ok:1', 'the other tenant can still write');
select tests.clear_auth();
select tests.authenticate_as((select platform from _f));
select is(tests.run(format($q$select public.fn_suspend_tenant(%L, 'second suspension')$q$, (select b from _f))), 'ok:1', 'suspending twice is an idempotent no-op');
select lives_ok(format($q$select public.fn_reactivate_tenant(%L, 'invoice paid')$q$, (select b from _f)), 'platform super admin reactivates');
select is((select status from public.restaurants where id = (select b from _f)), 'past_due', 'reactivation restores the status held before suspension');
select is(tests.run(format($q$select public.fn_reactivate_tenant(%L, 'again')$q$, (select b from _f))), 'P0001|invalid_state|past_due', 'reactivating a tenant that is not suspended is refused');
select tests.clear_auth();
select tests.authenticate_as((select b_admin from _f));
select ok(tests.visible_total() > 50, 'after reactivation the tenant can read again');
select tests.clear_auth();

-- ═════════ cancelled: same wall as suspended, and not reactivatable through the RPC ═════════
update public.restaurants set status = 'cancelled' where id = (select b from _f);
select tests.authenticate_as((select b_admin from _f));
select is(tests.visible_total(), 0::bigint, 'cancelled: no readable rows');
select is((select public.fn_get_session_context()), null::jsonb, 'cancelled: no session context');
select is(tests.run(format($q$select public.fn_update_role_permissions(%L, array['orders.view'], '{}')$q$, (select b_waiter_role from _f))), 'P0001|tenant_suspended|', 'cancelled: write RPC refused');
select is(tests.run(format($q$insert into public.stations (restaurant_id, name) values (%L, 'Ghost')$q$, (select b from _f))), '42501|new row violates row-level security policy for table "stations"|', 'cancelled: INSERT refused');
select tests.clear_auth();
select tests.authenticate_as_service_role();
select is((select public.fn_verify_pin((select b_waiter from _f), tests.pin_digest('3972')) ->> 'status'), 'invalid', 'cancelled: PIN refused');
select tests.clear_auth();
select tests.as_anon();
select is((select public.fn_resolve_tenant_slug('second-cafe')), null::jsonb, 'cancelled: slug resolves like an unknown slug');
select tests.clear_auth();
select tests.authenticate_as((select platform from _f));
select is(tests.run(format($q$select public.fn_reactivate_tenant(%L, 'resurrect')$q$, (select b from _f))), 'P0001|invalid_state|cancelled', 'cancelled tenants are not reactivated through fn_reactivate_tenant');
select is(tests.run(format($q$select public.fn_suspend_tenant(%L, 'suspend a cancelled one')$q$, (select b from _f))), 'P0001|invalid_state|cancelled', 'cancelled tenants cannot be (re)suspended');
select is((select count(*)::int from public.restaurants where id = (select b from _f)), 1, 'platform admin still sees the cancelled tenant');
select tests.clear_auth();
select is((select count(*)::int from public.admin_audit_log where action in ('tenant.suspend', 'tenant.reactivate') and restaurant_id = (select b from _f)), 2, 'every successful status change is in admin_audit_log (the refused ones are not)');

select * from finish();
rollback;
