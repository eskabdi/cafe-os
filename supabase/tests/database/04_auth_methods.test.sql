-- PIN login is for staff only; tenant_admin and platform admins use Supabase Auth email + password
begin;
select plan(55);

create temp table _f on commit drop as
select tests.tenant_id('central-cafe') a, tests.tenant_id('second-cafe') b;
grant all on _f to public;

select tests.authenticate_as_service_role();
-- staff PIN flow (the DB only ever sees the peppered digest)
select is((select public.fn_verify_pin(tests.user_id('hanna', 'central-cafe'), tests.pin_digest('4805')) ->> 'status'), 'ok', 'staff PIN (peppered digest) verifies');
select ok(not ((select public.fn_verify_pin(tests.user_id('hanna', 'central-cafe'), tests.pin_digest('4805')))::text like '%pin_hash%'), 'pin_hash never returned');
select is((select public.fn_verify_pin(tests.user_id('hanna', 'central-cafe'), tests.pin_digest('000000')))::text, '{"status": "invalid"}', 'wrong PIN: bare invalid (no attempts_left oracle)');
select public.fn_verify_pin(tests.user_id('hanna', 'central-cafe'), tests.pin_digest('000000'));
select is((select public.fn_verify_pin(tests.user_id('hanna', 'central-cafe'), tests.pin_digest('000000')))::text, '{"status": "invalid"}', '3rd failure: still the same bare answer');
select is((select public.fn_verify_pin(tests.user_id('hanna', 'central-cafe'), tests.pin_digest('4805')) ->> 'status'), 'invalid', 'correct PIN refused while locked, answer identical to a wrong PIN (no state oracle)');
select is(public.fn_verify_pin(tests.user_id('hanna', 'central-cafe'), '4805') ->> 'status', 'invalid', 'a raw PIN (not a 64-hex digest) is never accepted');
select tests.clear_auth();
select ok((select locked_until > now() + interval '14 minutes' from public.profile_secrets where profile_id = tests.user_id('hanna', 'central-cafe')),
          'lock lasts ~15 minutes');
select is((select failed_attempts from public.profile_secrets where profile_id = tests.user_id('hanna', 'central-cafe')), 3, 'exactly three failures counted (the locked attempt was not evaluated)');
update public.profile_secrets set locked_until = now() - interval '1 second' where profile_id = tests.user_id('hanna', 'central-cafe');
select tests.authenticate_as_service_role();
select is((select public.fn_verify_pin(tests.user_id('hanna', 'central-cafe'), tests.pin_digest('000000')) ->> 'status'), 'invalid', 'after lock expiry a wrong PIN counts on top of the old counter');
select tests.clear_auth();
select is((select failed_attempts from public.profile_secrets where profile_id = tests.user_id('hanna', 'central-cafe')), 4, 'lock expiry does NOT reset the counter');
select ok((select locked_until > now() + interval '14 minutes' from public.profile_secrets where profile_id = tests.user_id('hanna', 'central-cafe')), 'from the 3rd failure on every further failure re-locks');
update public.profile_secrets set locked_until = now() - interval '1 second' where profile_id = tests.user_id('hanna', 'central-cafe');
select tests.authenticate_as_service_role();
select is((select public.fn_verify_pin(tests.user_id('hanna', 'central-cafe'), tests.pin_digest('4805')) ->> 'status'), 'ok', 'after expiry the right PIN works');
select tests.clear_auth();
select is((select failed_attempts from public.profile_secrets where profile_id = tests.user_id('hanna', 'central-cafe')), 0, 'only a successful verify resets the counter');

-- admins never use PINs: identical to a bad PIN / unknown account
select tests.authenticate_as_service_role();
select is((select public.fn_verify_pin(tests.user_id('selam', 'central-cafe'), tests.pin_digest('123456'))),
          (select public.fn_verify_pin(gen_random_uuid(), tests.pin_digest('123456'))), 'tenant_admin PIN verify fails exactly like an unknown account');
select is((select public.fn_verify_pin('00000000-0000-4000-8000-0000000000c1', tests.pin_digest('123456')) ->> 'status'), 'invalid', 'platform admin PIN verify fails');
select is((select public.fn_register_pin_failure(tests.user_id('selam', 'central-cafe'))),
          (select public.fn_register_pin_failure(gen_random_uuid())), 'failure registration for admin is a no-op indistinguishable from unknown');
select throws_ok(format($q$select public.fn_set_user_pin(%L, tests.pin_digest('123456'))$q$, tests.user_id('selam', 'central-cafe')),
                 'P0001', 'pin_not_allowed', 'cannot set a PIN for tenant_admin');
select tests.clear_auth();

select throws_ok(format($q$insert into public.profile_secrets (profile_id, restaurant_id, pin_hash) values (%L, %L, 'x')$q$,
                        tests.user_id('selam', 'central-cafe'), (select a from _f)),
                 'P0001', 'pin_not_allowed', 'profile_secrets row for tenant_admin rejected by trigger');

-- PIN RPCs are not reachable by end users
select tests.authenticate_as(tests.user_id('selam', 'central-cafe'));
select throws_ok(format($q$select public.fn_verify_pin(%L, '1234')$q$, tests.user_id('hanna', 'central-cafe')), '42501', null, 'fn_verify_pin not executable by authenticated');
select throws_ok(format($q$select public.fn_set_user_pin(%L, '1234')$q$, tests.user_id('hanna', 'central-cafe')), '42501', null, 'fn_set_user_pin not executable by authenticated');
select tests.clear_auth();
select tests.as_anon();
select throws_ok($q$select public.fn_verify_pin(gen_random_uuid(), '1234')$q$, '42501', null, 'fn_verify_pin not executable by anon');
select tests.clear_auth();

-- auth_method / role consistency
select throws_ok(format($q$update public.profiles set auth_method = 'pin' where id = %L$q$, tests.user_id('selam', 'central-cafe')),
                 'P0001', 'auth_method_mismatch', 'tenant_admin must use password auth');
select throws_ok(format($q$update public.profiles set auth_method = 'password' where id = %L$q$, tests.user_id('hanna', 'central-cafe')),
                 'P0001', 'auth_method_mismatch', 'staff must use pin auth');
select throws_ok(format($q$update public.profiles set role_id = (select id from public.roles where system_key = 'tenant_admin' and restaurant_id = %L) where id = %L$q$,
                        (select a from _f), tests.user_id('hanna', 'central-cafe')),
                 'P0001', 'auth_method_mismatch', 'role cannot change without the matching auth method');
select throws_ok(format($q$insert into auth.users (id, email) values ('00000000-0000-4000-8000-0000000000d1', 'real@person.example.com')$q$) || '; ' ||
                 format($q$insert into public.profiles (id, restaurant_id, first_name, username, role_id, auth_method) select '00000000-0000-4000-8000-0000000000d1', %L, 'Real', 'realperson', id, 'pin' from public.roles where name = 'Waiter' and restaurant_id = %L$q$, (select a from _f), (select a from _f)),
                 'P0001', 'auth_method_mismatch', 'PIN staff must use a synthetic non-routable email');

-- promotion / demotion through fn_change_user_role
select tests.authenticate_as(tests.user_id('selam', 'central-cafe'));
select throws_ok(format($q$select public.fn_change_user_role(%L, %L)$q$, tests.user_id('hanna', 'central-cafe'),
                        (select id from public.roles where system_key = 'tenant_admin' and restaurant_id = (select a from _f))),
                 'P0001', 'admin_requires_email_identity', 'cannot promote a synthetic-email PIN account to tenant_admin');
select tests.clear_auth();
update auth.users set email = 'hanna@centralcafe.example.com' where id = tests.user_id('hanna', 'central-cafe');
select tests.authenticate_as(tests.user_id('selam', 'central-cafe'));
select lives_ok(format($q$select public.fn_change_user_role(%L, %L)$q$, tests.user_id('hanna', 'central-cafe'),
                       (select id from public.roles where system_key = 'tenant_admin' and restaurant_id = (select a from _f))), 'promotion with a real email works');
select tests.clear_auth();
select is((select auth_method from public.profiles where id = tests.user_id('hanna', 'central-cafe')), 'password', 'promotion switches to password auth');
select is((select count(*)::int from public.profile_secrets where profile_id = tests.user_id('hanna', 'central-cafe')), 0, 'promotion deletes the PIN secret');
select tests.authenticate_as(tests.user_id('selam', 'central-cafe'));
select lives_ok(format($q$select public.fn_change_user_role(%L, %L)$q$, tests.user_id('hanna', 'central-cafe'),
                       (select id from public.roles where name = 'Cashier' and restaurant_id = (select a from _f))), 'demotion works');
select tests.clear_auth();
select is((select auth_method from public.profiles where id = tests.user_id('hanna', 'central-cafe')), 'pin', 'demotion switches to pin auth');
select ok((select identity_rotation_pending from public.profiles where id = tests.user_id('hanna', 'central-cafe')), 'demotion of an account with a real email marks identity_rotation_pending');
select tests.authenticate_as_service_role();
select is((select public.fn_verify_pin(tests.user_id('hanna', 'central-cafe'), tests.pin_digest('4805')) ->> 'status'), 'invalid', 'old PIN does not survive demotion');
select throws_ok(format($q$select public.fn_set_user_pin(%L, tests.pin_digest('654123'))$q$, tests.user_id('hanna', 'central-cafe')), 'P0001', 'pin_not_allowed', 'no PIN can be set while the identity rotation is pending');
select throws_ok(format($q$select public.fn_complete_identity_rotation(%L)$q$, tests.user_id('hanna', 'central-cafe')), 'P0001', 'identity_not_rotated', 'rotation cannot be completed while the auth identity still has the real email');
select tests.clear_auth();
update auth.users set email = 'hanna@central-cafe.staff.cafeos.invalid', raw_app_meta_data = '{"staff": true}' where id = tests.user_id('hanna', 'central-cafe');
select tests.authenticate_as_service_role();
select lives_ok(format($q$select public.fn_complete_identity_rotation(%L)$q$, tests.user_id('hanna', 'central-cafe')), 'rotation completes once the identity is the synthetic staff email');
select tests.clear_auth();
select ok(not (select identity_rotation_pending from public.profiles where id = tests.user_id('hanna', 'central-cafe')), 'pending flag cleared');
select tests.authenticate_as_service_role();
select lives_ok(format($q$select public.fn_set_user_pin(%L, tests.pin_digest('654123'))$q$, tests.user_id('hanna', 'central-cafe')), 'new PIN can be set after rotation');
select is((select public.fn_verify_pin(tests.user_id('hanna', 'central-cafe'), tests.pin_digest('654123')) ->> 'status'), 'ok', 'new PIN verifies');
select is((select public.fn_user_auth_method(tests.user_id('selam', 'central-cafe'))), 'password', 'auth hook helper: admin => password');
select is((select public.fn_user_auth_method(tests.user_id('yonas', 'central-cafe'))), 'pin', 'auth hook helper: staff => pin');
select tests.clear_auth();

-- provisioning: owner = real email identity, no PIN secret, password auth
insert into auth.users (id, email, email_confirmed_at) values ('00000000-0000-4000-8000-0000000000e1', 'founder@newcafe.example.com', now()),
                                         ('00000000-0000-4000-8000-0000000000e2', 'founder2@new-cafe.staff.cafeos.invalid', now()),
                                         ('00000000-0000-4000-8000-0000000000e3', 'unconfirmed@newcafe.example.com', null);
select tests.authenticate_as_service_role();
select throws_ok($q$select public.fn_provision_tenant('New Cafe', 'new-cafe', '00000000-0000-4000-8000-0000000000e2', 'founder2@new-cafe.staff.cafeos.invalid', 'Fikru', null, null, (select id from public.plans limit 1), null)$q$,
                 'P0001', 'owner_email_mismatch', 'synthetic owner email rejected');
select throws_ok($q$select public.fn_provision_tenant('New Cafe', 'new-cafe', '00000000-0000-4000-8000-0000000000e1', 'someone-else@newcafe.example.com', 'Fikru', null, null, (select id from public.plans limit 1), null)$q$,
                 'P0001', 'owner_email_mismatch', 'owner email must match the auth identity');
select throws_ok($q$select public.fn_provision_tenant('New Cafe', 'central-cafe', '00000000-0000-4000-8000-0000000000e1', 'founder@newcafe.example.com', 'Fikru', null, null, (select id from public.plans limit 1), null)$q$,
                 'P0001', 'slug_taken', 'duplicate slug rejected');
select throws_ok($q$select public.fn_provision_tenant('New Cafe', 'unconfirmed-cafe', '00000000-0000-4000-8000-0000000000e3', 'unconfirmed@newcafe.example.com', 'Fikru', null, null, (select id from public.plans limit 1), null)$q$,
                 'P0001', 'owner_email_unconfirmed', 'an owner whose email is not confirmed cannot be provisioned');
select throws_ok($q$select public.fn_provision_tenant('New Cafe', 'admin', '00000000-0000-4000-8000-0000000000e1', 'founder@newcafe.example.com', 'Fikru', null, null, (select id from public.plans limit 1), null)$q$,
                 'P0001', 'invalid_slug', 'a reserved slug raises invalid_slug (not a raw CHECK violation)');
select lives_ok($q$select public.fn_provision_tenant('New Cafe', 'new-cafe', '00000000-0000-4000-8000-0000000000e1', 'founder@newcafe.example.com', 'Fikru', 'Lemma', 'Bekele', (select id from public.plans where name = 'Starter'), null)$q$,
                'service_role provisions a tenant');
select tests.clear_auth();
select is((select status from public.restaurants where slug = 'new-cafe'), 'trialing', 'new tenant is trialing');
select is((select count(*)::int from public.day_sessions d join public.restaurants r on r.id = d.restaurant_id where r.slug = 'new-cafe' and d.day_no = 1 and d.status = 'open'), 1, 'initial day_session day_no=1 open');
select is((select (current_period_end - current_period_start)::text from public.subscriptions s join public.restaurants r on r.id = s.restaurant_id where r.slug = 'new-cafe'), '14 days', '14-day trial subscription');
select is((select count(*)::int from public.roles r join public.restaurants x on x.id = r.restaurant_id where x.slug = 'new-cafe'), 6, 'default roles seeded as rows');
select is((select auth_method from public.profiles where id = '00000000-0000-4000-8000-0000000000e1'), 'password', 'owner uses password auth');
select is((select count(*)::int from public.profile_secrets where profile_id = '00000000-0000-4000-8000-0000000000e1'), 0, 'owner has no profile_secrets row');
select is((select short_name from public.profiles where id = '00000000-0000-4000-8000-0000000000e1'), 'Fikru Lemma', 'short name = first + middle');
select ok((select count(*) from public.audit_logs a join public.restaurants r on r.id = a.restaurant_id where r.slug = 'new-cafe' and a.event = 'tenant.provisioned') = 1, 'provisioning audited');

select * from finish();
rollback;
