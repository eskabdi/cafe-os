-- Staff provisioning RPCs, Auth password-verification hook, provisioning flags.
begin;
select plan(38);

create temp table _f on commit drop as
select tests.tenant_id('central-cafe') a, tests.tenant_id('second-cafe') b,
       tests.user_id('selam', 'central-cafe') admin, tests.user_id('yonas', 'central-cafe') waiter,
       tests.user_id('hanna', 'central-cafe') cashier,
       tests.user_id('owner', 'second-cafe') b_admin,
       tests.role_id('Waiter', 'central-cafe') r_waiter, tests.role_id('Waiter', 'second-cafe') b_r_waiter,
       tests.admin_role_id('central-cafe') r_admin,
       '00000000-0000-4000-8000-0000000000c1'::uuid platform;
grant all on _f to public;
grant execute on all functions in schema tests to public;

-- the Edge Function would create these with the service role (synthetic email, app_metadata.staff = true)
do $$ begin
  perform tests.create_auth_user('00000000-0000-4000-8000-000000000101', 'newbie@central-cafe.staff.cafeos.invalid');
  perform tests.create_auth_user('00000000-0000-4000-8000-000000000102', 'noflag@central-cafe.staff.cafeos.invalid');
  perform tests.create_auth_user('00000000-0000-4000-8000-000000000103', 'foreign@second-cafe.staff.cafeos.invalid');
  perform tests.create_auth_user('00000000-0000-4000-8000-000000000104', 'someone@real-person.example.com');
  perform tests.create_auth_user('00000000-0000-4000-8000-000000000105', 'dup@central-cafe.staff.cafeos.invalid');
  update auth.users set raw_app_meta_data = '{"provider":"email","staff":true}'
    where id in ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000103',
                 '00000000-0000-4000-8000-000000000104', '00000000-0000-4000-8000-000000000105');
end $$;

-- ═════════ fn_prepare_staff_creation ═════════
select tests.authenticate_as((select admin from _f));
select is(public.fn_prepare_staff_creation(' NewBie ', (select r_waiter from _f))::text, '{"slug": "central-cafe", "username": "newbie", "role_name": "Waiter"}', 'prepare: normalises the username, returns the tenant slug and the role NAME looked up server-side (for the PIN length rule)');
select is(tests.run(format($q$select public.fn_prepare_staff_creation('x1', %L)$q$, (select r_admin from _f))), 'P0001|invalid_role|', 'prepare: the tenant_admin role cannot be assigned to staff');
select is(tests.run(format($q$select public.fn_prepare_staff_creation('x1', %L)$q$, (select b_r_waiter from _f))), 'P0001|invalid_role|', 'prepare: another tenant''s role is just invalid_role');
select is(tests.run($q$select public.fn_prepare_staff_creation('x1', gen_random_uuid())$q$), 'P0001|invalid_role|', 'prepare: unknown role: same answer');
select is(tests.run(format($q$select public.fn_prepare_staff_creation('hanna', %L)$q$, (select r_waiter from _f))), 'P0001|username_taken|', 'prepare: username unique per tenant');
select is(tests.run(format($q$select public.fn_prepare_staff_creation('Bad Name!', %L)$q$, (select r_waiter from _f))), 'P0001|invalid_input|username', 'prepare: username format');
select tests.clear_auth();
select tests.authenticate_as((select waiter from _f));
select is(tests.run(format($q$select public.fn_prepare_staff_creation('newbie', %L)$q$, (select r_waiter from _f))), 'P0001|permission_denied|', 'prepare: needs users.manage');
select tests.clear_auth();
select tests.as_anon();
select is(tests.run(format($q$select public.fn_prepare_staff_creation('newbie', %L)$q$, (select r_waiter from _f))), '42501|permission denied for function fn_prepare_staff_creation|', 'prepare: not for anon');
select tests.clear_auth();

-- ═════════ fn_create_staff_profile ═════════
select tests.authenticate_as((select admin from _f));
select is(tests.run(format($q$select public.fn_create_staff_profile('00000000-0000-4000-8000-000000000102', 'No', null, null, 'noflag', %L)$q$, (select r_waiter from _f))), 'P0001|invalid_auth_user|', 'create: the auth user must carry app_metadata.staff = true');
select is(tests.run(format($q$select public.fn_create_staff_profile('00000000-0000-4000-8000-000000000103', 'F', null, null, 'foreign', %L)$q$, (select r_waiter from _f))), 'P0001|invalid_auth_user|', 'create: another tenant''s synthetic identity can never match');
select is(tests.run(format($q$select public.fn_create_staff_profile('00000000-0000-4000-8000-000000000104', 'R', null, null, 'someone', %L)$q$, (select r_waiter from _f))), 'P0001|invalid_auth_user|', 'create: a real-email identity is refused');
select is(tests.run(format($q$select public.fn_create_staff_profile(gen_random_uuid(), 'U', null, null, 'newbie', %L)$q$, (select r_waiter from _f))), 'P0001|invalid_auth_user|', 'create: unknown auth user: same answer');
select is(tests.run(format($q$select public.fn_create_staff_profile('00000000-0000-4000-8000-000000000101', '  ', null, null, 'newbie', %L)$q$, (select r_waiter from _f))), 'P0001|invalid_input|name', 'create: first name required');
select is(tests.run(format($q$select public.fn_create_staff_profile('00000000-0000-4000-8000-000000000101', 'New', 'Bie', 'Tadesse', 'newbie', %L)$q$, (select r_admin from _f))), 'P0001|invalid_role|', 'create: cannot create a tenant_admin through the staff path');
select is(public.fn_create_staff_profile('00000000-0000-4000-8000-000000000101', 'New', 'Bie', 'Tadesse', 'newbie', (select r_waiter from _f))::text,
          '{"profile_id": "00000000-0000-4000-8000-000000000101"}', 'create: returns only the profile id');
select is(tests.run(format($q$select public.fn_create_staff_profile('00000000-0000-4000-8000-000000000101', 'Again', null, null, 'newbie', %L)$q$, (select r_waiter from _f))), 'P0001|username_taken|', 'create: replay with the same username is username_taken');
select is(tests.run(format($q$select public.fn_create_staff_profile('00000000-0000-4000-8000-000000000105', 'Dup', null, null, 'dup', %L)$q$, (select r_waiter from _f))), 'ok:1', 'create: a second staff member works');
select tests.clear_auth();
select is((select auth_method from public.profiles where id = '00000000-0000-4000-8000-000000000101'), 'pin', 'created profile uses PIN auth');
select is((select count(*)::int from public.profile_secrets where profile_id = '00000000-0000-4000-8000-000000000101'), 0, 'and has no PIN until the service path sets one');
select is((select short_name from public.profiles where id = '00000000-0000-4000-8000-000000000101'), 'New Bie', 'Ethiopian name parts stored');
select is((select count(*)::int from public.audit_logs where event = 'user.created' and actor_id = (select admin from _f)), 2, 'creation audited with the caller as actor');
select tests.authenticate_as((select waiter from _f));
select is(tests.run(format($q$select public.fn_create_staff_profile('00000000-0000-4000-8000-000000000101', 'X', null, null, 'newbie', %L)$q$, (select r_waiter from _f))), 'P0001|permission_denied|', 'create: needs users.manage');
select tests.clear_auth();
select tests.authenticate_as_service_role();
select lives_ok($q$select public.fn_set_user_pin('00000000-0000-4000-8000-000000000101', tests.pin_digest('846201'))$q$, 'PIN is set separately through the service path');
select is((select public.fn_verify_pin('00000000-0000-4000-8000-000000000101', tests.pin_digest('846201')) ->> 'status'), 'ok', 'and the new member can verify');
select tests.clear_auth();
-- plan limit
update public.plans set max_staff = 1 where id = (select plan_id from public.subscriptions where restaurant_id = (select a from _f));
select tests.authenticate_as((select admin from _f));
select is(tests.run(format($q$select public.fn_prepare_staff_creation('another', %L)$q$, (select r_waiter from _f))), 'P0001|staff_limit_reached|', 'the plan''s max_staff is enforced');
select tests.clear_auth();

-- ═════════ Auth password-verification hook ═════════
select is(public.fn_auth_password_verification_hook(jsonb_build_object('user_id', (select cashier from _f), 'valid', true))::text, '{"message": "Invalid login credentials", "decision": "reject"}', 'hook rejects password sign-in for a PIN staff account (even with the right password)');
select is(public.fn_auth_password_verification_hook(jsonb_build_object('user_id', (select cashier from _f), 'valid', false)), public.fn_auth_password_verification_hook(jsonb_build_object('user_id', (select cashier from _f), 'valid', true)), 'same answer for a wrong password');
select is(public.fn_auth_password_verification_hook(jsonb_build_object('user_id', (select admin from _f), 'valid', true))::text, '{"decision": "continue"}', 'hook lets a tenant_admin through');
select is(public.fn_auth_password_verification_hook(jsonb_build_object('user_id', (select platform from _f), 'valid', true))::text, '{"decision": "continue"}', 'hook lets a platform admin through');
select is(public.fn_auth_password_verification_hook(jsonb_build_object('user_id', gen_random_uuid(), 'valid', true))::text, '{"decision": "continue"}', 'hook: an identity with no profile is not its concern');
select is(public.fn_auth_password_verification_hook('{}'::jsonb) ->> 'decision', 'reject', 'hook fails closed on a missing user_id');
select is(public.fn_auth_password_verification_hook('{"user_id": "not-a-uuid"}'::jsonb) ->> 'decision', 'reject', 'hook fails closed on a malformed user_id');
select is((select string_agg(r.rolname, ',' order by r.rolname) from pg_roles r where has_function_privilege(r.oid, 'public.fn_auth_password_verification_hook(jsonb)', 'execute') and r.rolname in ('anon', 'authenticated', 'service_role', 'supabase_auth_admin')),
          'supabase_auth_admin', 'only supabase_auth_admin may execute the hook');
select ok(not has_function_privilege('public', 'public.fn_auth_password_verification_hook(jsonb)', 'execute'), 'and not PUBLIC');
select ok(has_schema_privilege('supabase_auth_admin', 'public', 'usage'), 'supabase_auth_admin has USAGE on schema public (hooks cannot run without it)');
select ok(not has_table_privilege('supabase_auth_admin', 'public.profiles', 'select'), 'and no table privilege: the SECURITY DEFINER hook reads profiles itself');

-- ═════════ provisioning flags ═════════
insert into auth.users (id, email) values ('00000000-0000-4000-8000-000000000201', 'unconfirmed@demo-owner.example.com');
select tests.authenticate_as((select platform from _f));
select is(tests.run(format($q$select public.fn_provision_tenant('Demo', 'demo-owner', '00000000-0000-4000-8000-000000000201', 'unconfirmed@demo-owner.example.com', 'Demo', null, null, %L, null, false)$q$, (select id from public.plans limit 1))),
          'P0001|permission_denied|', 'a platform admin cannot waive the email-confirmation check');
select tests.clear_auth();
select tests.authenticate_as_service_role();
select is(tests.run(format($q$select public.fn_provision_tenant('Demo', 'demo-owner', '00000000-0000-4000-8000-000000000201', 'unconfirmed@demo-owner.example.com', 'Demo', null, null, %L, null, false)$q$, (select id from public.plans limit 1))),
          'ok:1', 'service_role flows (seed / CI) may skip it explicitly');
select tests.clear_auth();

select * from finish();
rollback;
