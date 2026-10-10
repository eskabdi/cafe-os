-- Phase 3B review fixes and owner decisions (migrations 0030 / 0031): plan downgrade refused, restore within the 1-year retention,
-- purge after it, public logo lookup, audited tenant detail reads, admin PIN reset signs out, users.view masking.
begin;
select plan(36);

create temp table _f on commit drop as
select tests.tenant_id('central-cafe') a, tests.tenant_id('second-cafe') b,
       '00000000-0000-4000-8000-0000000000c1'::uuid su,
       tests.user_id('selam', 'central-cafe') a_admin, tests.user_id('yonas', 'central-cafe') a_waiter,
       tests.user_id('meron', 'central-cafe') a_waiter2,
       (select id from public.plans where name = 'Growth') growth;
grant all on _f to public;
create temp table _c (k text primary key, v text);
grant all on _c to public;

-- ═════════ owner decision 2: a plan below current usage is refused ═════════
select tests.aal2((select su from _f));
insert into _c select 'tiny', public.fn_platform_create_plan('{"name": "Tiny", "price_etb_monthly": 100, "max_staff": 1, "max_menu_items": 1}') ->> 'id';
select is(tests.run(format($q$select public.fn_platform_change_plan(%L, %L, 'downgrade')$q$, (select a from _f), (select v from _c where k = 'tiny'))),
          'P0001|plan_limit_reached|menu_items,staff', 'downgrade below current usage: plan_limit_reached naming the metrics');
select is((select pl.name from public.subscriptions s join public.plans pl on pl.id = s.plan_id where s.restaurant_id = (select a from _f)), 'Growth', 'nothing changed');

-- ═════════ review 13: a tenant detail read is audited; lists are not ═════════
select lives_ok(format($q$select public.fn_platform_get_tenant(%L)$q$, (select b from _f)), 'read one tenant');
select is((select count(*)::int from public.admin_audit_log where action = 'tenant.viewed' and restaurant_id = (select b from _f) and platform_admin_id = (select su from _f)), 1, 'tenant.viewed audited');
select lives_ok('select public.fn_platform_list_tenants()', 'list tenants');
select is((select (public.fn_platform_system_health() -> 'tenants' ->> 'total')::int), (select count(*)::int from public.restaurants), 'health: tenant total counts tenants, not statuses');
select is((select count(*)::int from public.admin_audit_log where action = 'tenant.viewed'), 1, 'the list is not audited per tenant');

-- ═════════ owner decision 3: cancel -> restore within a year ═════════
select is((select public.fn_platform_cancel_tenant((select b from _f), 'customer left', 'second-cafe') ->> 'status'), 'cancelled', 'cancel');
select tests.clear_auth();
select ok((select cancelled_at is not null from public.restaurants where id = (select b from _f)), 'cancelled_at stamped');
select tests.aal2((select su from _f));
select is(tests.run(format($q$select public.fn_platform_restore_tenant(%L, 'came back', 'wrong-slug')$q$, (select b from _f))), 'P0001|invalid_input|confirm_slug', 'slug confirmation');
select is(tests.run(format($q$select public.fn_platform_restore_tenant(%L, 'came back', 'central-cafe')$q$, (select a from _f))), 'P0001|invalid_state|active', 'only a cancelled tenant can be restored');
select is((select public.fn_platform_restore_tenant((select b from _f), 'came back', 'second-cafe') ->> 'status'), 'active', 'restored within the window');
select tests.clear_auth();
select ok((select cancelled_at is null from public.restaurants where id = (select b from _f)), 'cancelled_at cleared');
select is((select count(*)::int from public.admin_audit_log where action = 'tenant.restore'), 1, 'admin_audit_log: tenant.restore');
select is((select count(*)::int from public.audit_logs where event = 'tenant.restored' and restaurant_id = (select b from _f)), 1, 'tenant trail: tenant.restored');

-- ═════════ after 1 year: no restore; ops purge ═════════
select tests.aal2((select su from _f));
insert into _c select 'gone', public.fn_platform_create_tenant('Gone Cafe', 'gone-cafe', (select growth from _f)) ->> 'restaurant_id';
select is((select public.fn_platform_cancel_tenant((select v::uuid from _c where k = 'gone'), 'closed', 'gone-cafe') ->> 'status'), 'cancelled', 'cancel a second tenant');
select tests.clear_auth();
update public.restaurants set cancelled_at = now() - interval '1 year 1 day' where id = (select v::uuid from _c where k = 'gone');
-- a staff profile of the gone tenant with a trusted device (and an attested session): the purge must remove both
select tests.create_auth_user('00000000-0000-4000-8000-0000000000e7', 'gone.admin@gone.example.com');
insert into public.profiles (id, restaurant_id, role_id, first_name, username, auth_method)
  select '00000000-0000-4000-8000-0000000000e7', r.restaurant_id, r.id, 'Gone', 'goneadmin', 'password'
  from public.roles r where r.restaurant_id = (select v::uuid from _c where k = 'gone') and r.system_key = 'tenant_admin';
insert into _c values ('gone_admin', '00000000-0000-4000-8000-0000000000e7');
insert into public.trusted_devices (user_id, scope, factor_id, token_hash, expires_at)
  select v::uuid, 'tenant', gen_random_uuid(), repeat('f', 64), now() + interval '30 days' from _c where k = 'gone_admin';
insert into public.session_device_attestations (session_id, user_id, device_id, expires_at)
  select gen_random_uuid(), d.user_id, d.id, d.expires_at from public.trusted_devices d where d.token_hash = repeat('f', 64);
select tests.aal2((select su from _f));
select is(tests.run(format($q$select public.fn_platform_restore_tenant(%L, 'too late', 'gone-cafe')$q$, (select v from _c where k = 'gone'))),
          'P0001|invalid_state|retention_expired', 'after 1 year: retention_expired');
select is(tests.run('select public.fn_ops_purge_expired_cancelled_tenants()'), '42501|permission denied for function fn_ops_purge_expired_cancelled_tenants|', 'purge is ops-only (no client EXECUTE)');
select tests.clear_auth();
select tests.authenticate_as_service_role();
insert into _c select 'purge', public.fn_ops_purge_expired_cancelled_tenants()::text;
select tests.clear_auth();
select is((select (v::jsonb -> 'purged' -> 0 ->> 'restaurant_id') from _c where k = 'purge'), (select v from _c where k = 'gone'), 'the expired tenant is purged');
select is((select jsonb_array_length(v::jsonb -> 'purged') from _c where k = 'purge'), 1, 'and only that one (second-cafe was restored, central-cafe is active)');
select is((select count(*)::int from public.profiles where restaurant_id = (select v::uuid from _c where k = 'gone'))
          + (select count(*)::int from public.roles where restaurant_id = (select v::uuid from _c where k = 'gone'))
          + (select count(*)::int from public.stations where restaurant_id = (select v::uuid from _c where k = 'gone')), 0, 'its tenant rows are gone');
select ok((select name = 'Purged tenant' and purged_at is not null and slug like 'purged-%' from public.restaurants where id = (select v::uuid from _c where k = 'gone')), 'the restaurant row is kept, anonymised');
select is((select count(*)::int from public.subscriptions where restaurant_id = (select v::uuid from _c where k = 'gone')), 1, 'billing records are kept');
select is((select count(*)::int from public.admin_audit_log where action = 'tenant.purged'), 1, 'admin_audit_log: tenant.purged');
select is((select count(*)::int from public.trusted_devices where token_hash = repeat('f', 64)) + (select count(*)::int from public.session_device_attestations s
          where s.user_id = (select v::uuid from _c where k = 'gone_admin')), 0, 'its users'' trusted devices and attestations are gone (the Auth users can be deleted)');

-- ═════════ owner decision 4: logo lookup for the public tenant-logo function ═════════
select tests.authenticate_as((select a_admin from _f));
select is(tests.run($q$select public.fn_tenant_logo_for_slug('central-cafe')$q$), '42501|permission denied for function fn_tenant_logo_for_slug|', 'clients cannot call the logo lookup');
select tests.clear_auth();
insert into storage.objects (bucket_id, name) select 'tenant-branding', 'restaurants/' || a || '/branding/logo.png' from _f;
update public.restaurants set branding = branding || jsonb_build_object('logo_path', 'restaurants/' || id || '/branding/logo.png') where id = (select a from _f);
select tests.authenticate_as_service_role();
select is((select public.fn_tenant_logo_for_slug(' Central-Cafe ') ->> 'logo_path'), 'restaurants/' || (select a from _f) || '/branding/logo.png', 'the current logo of an active tenant');
select is((select public.fn_tenant_logo_for_slug('no-such-cafe')), '{"logo_path": null}'::jsonb, 'unknown slug: the same null shape');
select is((select public.fn_tenant_logo_for_slug('gone-cafe')), '{"logo_path": null}'::jsonb, 'purged / cancelled tenant: the same null shape');
select tests.clear_auth();

-- ═════════ owner decision 5: admin PIN reset signs the person out and forces a new PIN ═════════
insert into auth.sessions (id, user_id, created_at, updated_at, aal) select gen_random_uuid(), a_waiter, now(), now(), 'aal1' from _f;
select tests.authenticate_as_service_role();
select is((select public.fn_admin_reset_user_pin((select a_waiter from _f), repeat('a', 64), 4) ->> 'must_change_pin'), 'true', 'reset by the admin');
select tests.clear_auth();
select is((select count(*)::int from auth.sessions where user_id = (select a_waiter from _f)), 0, 'every session of that person is deleted (signed out)');
select is((select must_change_reason from public.profile_secrets where profile_id = (select a_waiter from _f)), 'admin_reset', 'a new PIN is forced at the next sign-in');

-- ═════════ isolation review L1: a decoy becomes real once its address is free ═════════
select tests.aal2((select a_admin from _f));
insert into _c select 'inv_a', public.fn_prepare_tenant_admin_invitation(null, 'shared.coadmin@example.com', 'Shared', null, null, 'sharedco') ->> 'invitation_id';
select tests.clear_auth();
select tests.aal2(tests.user_id('owner', 'second-cafe'));
insert into _c select 'inv_b', public.fn_prepare_tenant_admin_invitation(null, 'shared.coadmin@example.com', 'Shared', null, null, 'sharedco') ->> 'invitation_id';
select tests.clear_auth();
select ok((select suppressed from public.tenant_admin_invitations where id = (select v::uuid from _c where k = 'inv_b')), 'B''s invitation to an address A already invited is a decoy');
select tests.aal2((select a_admin from _f));
select lives_ok($q$select public.fn_revoke_tenant_admin_invitation((select v::uuid from _c where k = 'inv_a'))$q$, 'A revokes its invitation');
select tests.clear_auth();
select tests.authenticate_as_service_role();
select is((select public.fn_plan_tenant_admin_invitation_delivery((select v::uuid from _c where k = 'inv_b')) ->> 'mode'), 'invite', 'B''s invitation is now delivered for real');
select tests.clear_auth();
select ok(not (select suppressed from public.tenant_admin_invitations where id = (select v::uuid from _c where k = 'inv_b')), 'and is no longer a decoy');

select * from finish();
rollback;
