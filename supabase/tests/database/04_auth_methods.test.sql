-- PIN login is for staff only; tenant_admin and platform admins use Supabase Auth email + password
begin;
select plan(42);

create temp table _f on commit drop as
select tests.tenant_id('central-cafe') a, tests.tenant_id('second-cafe') b;
grant all on _f to public;

select tests.authenticate_as_service_role();
-- staff PIN flow
select is((select public.fn_verify_pin(tests.user_id('hanna', 'central-cafe'), '3456') ->> 'status'), 'ok', 'staff PIN verifies');
select ok(not ((select public.fn_verify_pin(tests.user_id('hanna', 'central-cafe'), '3456'))::text like '%pin_hash%'), 'pin_hash never returned');
select is((select public.fn_verify_pin(tests.user_id('hanna', 'central-cafe'), '0000') ->> 'attempts_left'), '4', 'wrong PIN counts down');
select public.fn_verify_pin(tests.user_id('hanna', 'central-cafe'), '0000');
select public.fn_verify_pin(tests.user_id('hanna', 'central-cafe'), '0000');
select public.fn_verify_pin(tests.user_id('hanna', 'central-cafe'), '0000');
select is((select public.fn_verify_pin(tests.user_id('hanna', 'central-cafe'), '0000') ->> 'status'), 'locked', '5th failure locks the account');
select is((select public.fn_verify_pin(tests.user_id('hanna', 'central-cafe'), '3456') ->> 'status'), 'locked', 'correct PIN refused while locked');
select tests.clear_auth();
select ok((select locked_until > now() + interval '14 minutes' from public.profile_secrets where profile_id = tests.user_id('hanna', 'central-cafe')),
          'lock lasts ~15 minutes');
update public.profile_secrets set locked_until = now() - interval '1 second' where profile_id = tests.user_id('hanna', 'central-cafe');
select tests.authenticate_as_service_role();
select is((select public.fn_verify_pin(tests.user_id('hanna', 'central-cafe'), '3456') ->> 'status'), 'ok', 'lock expires and resets');

-- admins never use PINs: identical to a bad PIN / unknown account
select is((select public.fn_verify_pin(tests.user_id('selam', 'central-cafe'), '1234')),
          (select public.fn_verify_pin(gen_random_uuid(), '1234')), 'tenant_admin PIN verify fails exactly like an unknown account');
select is((select public.fn_verify_pin('00000000-0000-4000-8000-0000000000c1', '1234') ->> 'status'), 'invalid', 'platform admin PIN verify fails');
select is((select public.fn_register_pin_failure(tests.user_id('selam', 'central-cafe'))),
          (select public.fn_register_pin_failure(gen_random_uuid())), 'failure registration for admin is a no-op indistinguishable from unknown');
select throws_ok(format($q$select public.fn_set_user_pin(%L, '1234')$q$, tests.user_id('selam', 'central-cafe')),
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
select tests.authenticate_as_service_role();
select is((select public.fn_verify_pin(tests.user_id('hanna', 'central-cafe'), '3456') ->> 'status'), 'invalid', 'old PIN does not survive demotion; a new PIN must be set');
select lives_ok(format($q$select public.fn_set_user_pin(%L, '4321')$q$, tests.user_id('hanna', 'central-cafe')), 'new PIN can be set');
select is((select public.fn_verify_pin(tests.user_id('hanna', 'central-cafe'), '4321') ->> 'status'), 'ok', 'new PIN verifies');
select is((select public.fn_user_auth_method(tests.user_id('selam', 'central-cafe'))), 'password', 'auth hook helper: admin => password');
select is((select public.fn_user_auth_method(tests.user_id('yonas', 'central-cafe'))), 'pin', 'auth hook helper: staff => pin');
select tests.clear_auth();

-- provisioning: owner = real email identity, no PIN secret, password auth
insert into auth.users (id, email) values ('00000000-0000-4000-8000-0000000000e1', 'founder@newcafe.example.com'),
                                         ('00000000-0000-4000-8000-0000000000e2', 'founder2@new-cafe.staff.cafeos.invalid');
select tests.authenticate_as_service_role();
select throws_ok($q$select public.fn_provision_tenant('New Cafe', 'new-cafe', '00000000-0000-4000-8000-0000000000e2', 'founder2@new-cafe.staff.cafeos.invalid', 'Fikru', null, null, (select id from public.plans limit 1), null)$q$,
                 'P0001', 'owner_email_mismatch', 'synthetic owner email rejected');
select throws_ok($q$select public.fn_provision_tenant('New Cafe', 'new-cafe', '00000000-0000-4000-8000-0000000000e1', 'someone-else@newcafe.example.com', 'Fikru', null, null, (select id from public.plans limit 1), null)$q$,
                 'P0001', 'owner_email_mismatch', 'owner email must match the auth identity');
select throws_ok($q$select public.fn_provision_tenant('New Cafe', 'central-cafe', '00000000-0000-4000-8000-0000000000e1', 'founder@newcafe.example.com', 'Fikru', null, null, (select id from public.plans limit 1), null)$q$,
                 'P0001', 'slug_taken', 'duplicate slug rejected');
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
