-- Documented exception (user decision 2026-10-03): the 'Cashier' role uses a 6-digit PIN, all others exactly 4.
-- The DB never sees the PIN; it checks the Edge Function's length CLAIM against the role and keeps the stored length.
begin;
select plan(27);

create temp table _f on commit drop as
select tests.user_id('hanna', 'central-cafe') cashier, tests.user_id('yonas', 'central-cafe') waiter,
       tests.user_id('selam', 'central-cafe') admin, tests.tenant_id('central-cafe') a,
       tests.role_id('Cashier', 'central-cafe') r_cashier, tests.role_id('Waiter', 'central-cafe') r_waiter,
       tests.role_id('Kitchen', 'central-cafe') r_kitchen;
grant all on _f to public;
grant execute on all functions in schema tests to public;

select is(public.fn_pin_length_for_role_name('Cashier'), 6, 'Cashier => 6');
select is(public.fn_pin_length_for_role_name('  CASHIER '), 6, 'normalised like roles.normalized_name');
select is(public.fn_pin_length_for_role_name('Waiter'), 4, 'Waiter => 4');
select is(public.fn_pin_length_for_role_name('Cashiers'), 4, 'only the exact (normalised) name');
select is((select pin_length from public.profile_secrets where profile_id = (select cashier from _f)), 6::smallint, 'seed: the cashier has a 6-digit PIN on record');
select is((select pin_length from public.profile_secrets where profile_id = (select waiter from _f)), 4::smallint, 'seed: the waiter has a 4-digit PIN on record');

select tests.authenticate_as_service_role();
select throws_ok(format($q$select public.fn_set_user_pin(%L, tests.pin_digest('4829'), 4)$q$, (select cashier from _f)), 'P0001', 'pin_length_mismatch', 'a 4-digit claim for the Cashier role is refused');
select throws_ok(format($q$select public.fn_set_user_pin(%L, tests.pin_digest('480516'), 6)$q$, (select waiter from _f)), 'P0001', 'pin_length_mismatch', 'a 6-digit claim for a Waiter is refused');
select throws_ok(format($q$select public.fn_set_user_pin(%L, tests.pin_digest('4829'), 5)$q$, (select waiter from _f)), 'P0001', 'pin_length_mismatch', 'a 5-digit claim is refused');
select lives_ok(format($q$select public.fn_set_user_pin(%L, tests.pin_digest('916240'), 6)$q$, (select cashier from _f)), 'a 6-digit claim for the Cashier is accepted');
select lives_ok(format($q$select public.fn_set_user_pin(%L, tests.pin_digest('3158'), 4)$q$, (select waiter from _f)), 'a 4-digit claim for a Waiter is accepted');
select is((select public.fn_verify_pin((select cashier from _f), tests.pin_digest('916240')) ->> 'status'), 'ok', 'and verification only compares the digest (same answer shape for any length)');
select is((select public.fn_verify_pin((select cashier from _f), tests.pin_digest('4829'))::text), '{"status": "invalid"}', 'a wrong-length guess is just invalid: the server reveals nothing about the length');
select tests.clear_auth();

-- moving INTO the Cashier role with a 4-digit PIN destroys the secret
select tests.authenticate_as((select admin from _f));
select is((select public.fn_change_user_role((select waiter from _f), (select r_cashier from _f)) ->> 'pin_reset_required'), 'true', 'Waiter -> Cashier: pin_reset_required');
select tests.clear_auth();
select is((select count(*)::int from public.profile_secrets where profile_id = (select waiter from _f)), 0, 'the 4-digit secret is gone: no PIN login until a 6-digit PIN is issued');
select tests.authenticate_as_service_role();
select throws_ok(format($q$select public.fn_set_user_pin(%L, tests.pin_digest('3158'), 4)$q$, (select waiter from _f)), 'P0001', 'pin_length_mismatch', 'the new Cashier cannot be given a 4-digit PIN');
select tests.clear_auth();
-- and out of it
select tests.authenticate_as((select admin from _f));
select is((select public.fn_change_user_role((select cashier from _f), (select r_kitchen from _f)) ->> 'pin_reset_required'), 'true', 'Cashier -> Kitchen: the 6-digit secret is destroyed too (others stay exactly 4)');
select is((select public.fn_change_user_role((select cashier from _f), (select r_kitchen from _f)) ->> 'changed'), 'false', 'a no-op change changes (and resets) nothing');
select tests.clear_auth();

-- renaming a role into / out of Cashier (a rename must not be a way around the rule)
do $$ begin
  insert into public.roles (restaurant_id, name) values (tests.tenant_id('central-cafe'), 'Floor');
  update public.profiles set role_id = (select id from public.roles where name = 'Floor' and restaurant_id = tests.tenant_id('central-cafe'))
   where id = tests.user_id('meron', 'central-cafe');
end $$;
select tests.authenticate_as_service_role();
select lives_ok(format($q$select public.fn_set_user_pin(%L, tests.pin_digest('3158'), 4)$q$, tests.user_id('meron', 'central-cafe')), 'a 4-digit PIN for a user of the new role Floor');
select tests.clear_auth();
update public.roles set name = 'Teller' where id = (select r_cashier from _f);
select is((select count(*)::int from public.profile_secrets where profile_id = tests.user_id('meron', 'central-cafe')), 1, 'unrelated renames keep secrets');
update public.roles set name = 'Cashier' where name = 'Floor' and restaurant_id = (select a from _f);
select is((select count(*)::int from public.profile_secrets where profile_id = tests.user_id('meron', 'central-cafe')), 0, 'renaming a role INTO Cashier destroys its users'' 4-digit secrets');
select tests.authenticate_as_service_role();
select lives_ok(format($q$select public.fn_set_user_pin(%L, tests.pin_digest('916240'), 6)$q$, tests.user_id('meron', 'central-cafe')), 'they then get a 6-digit PIN');
select tests.clear_auth();
update public.roles set name = 'Floor' where name = 'Cashier' and restaurant_id = (select a from _f);
select is((select count(*)::int from public.profile_secrets where profile_id = tests.user_id('meron', 'central-cafe')), 0, 'renaming a role OUT of Cashier destroys the 6-digit secrets');
select is((select string_agg(distinct pg_get_function_identity_arguments(p.oid), ' | ') from pg_proc p where p.proname = 'fn_set_user_pin' and p.pronamespace = 'public'::regnamespace), 'p_profile_id uuid, p_pin_digest text, p_pin_length integer', 'single fn_set_user_pin overload');

select * from finish();
rollback;
