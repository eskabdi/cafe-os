-- Migration 0036: plan features in the session context, explicit installments on plan create/update, Tenant Admins on the platform
-- tenant detail, and the two-step Super Admin MFA reset of a Tenant Admin (prepare AS THE CALLER, complete with the SERVICE ROLE).
-- Happy path, unauthorised (tenant admin / aal1 / stale TOTP / anon / authenticated on the service step), cross-tenant (not_found, no
-- oracle), validation, audit rows with the right actor, replay.
begin;
select plan(58);

create temp table _f on commit drop as
select tests.tenant_id('central-cafe') a, tests.tenant_id('second-cafe') b,
       '00000000-0000-4000-8000-0000000000c1'::uuid su,
       tests.user_id('selam', 'central-cafe') a_admin, tests.user_id('dawit', 'central-cafe') a_admin2,
       tests.user_id('yonas', 'central-cafe') a_waiter,
       tests.user_id('owner', 'second-cafe') b_admin, tests.user_id('waiter', 'second-cafe') b_waiter,
       (select id from public.plans where name = 'Growth') growth;
grant all on _f to public;
create temp table _c (k text primary key, v jsonb) on commit drop;
grant all on _c to public;

-- ═════════ A. plan_features in the session context ═════════
select tests.authenticate_as((select a_admin from _f));
select is(public.fn_get_session_context() -> 'plan_features', '{"installments": true, "multi_station": true}'::jsonb,
          'Growth tenant admin: plan_features = the Growth plan features');
select tests.authenticate_as((select b_waiter from _f));
select is(public.fn_get_session_context() -> 'plan_features', '{"installments": false, "multi_station": false}'::jsonb,
          'Starter staff member: plan_features = the Starter plan features (every tenant user, not only admins)');
select tests.aal2((select su from _f));
select ok(not (public.fn_get_session_context() ? 'plan_features'), 'platform admin: no plan_features key');
select ok(public.fn_get_session_context() ? 'platform_role', 'control: the platform context is still returned');

-- ═════════ A. explicit installments on plan create / update ═════════
select is(public.fn_platform_create_plan('{"name": "Bare Plan", "price_etb_monthly": 10}') -> 'features', '{"installments": false}'::jsonb,
          'create without features stores installments=false explicitly');
select is(public.fn_platform_create_plan('{"name": "Station Plan", "price_etb_monthly": 10, "features": {"multi_station": true}}') -> 'features',
          '{"installments": false, "multi_station": true}'::jsonb, 'create with features lacking installments adds installments=false');
select is(public.fn_platform_create_plan('{"name": "Credit Plan", "price_etb_monthly": 10, "features": {"installments": true}}') -> 'features',
          '{"installments": true}'::jsonb, 'an explicit installments=true is kept');
select is(tests.run($q$select public.fn_platform_create_plan('{"name": "Str Plan", "price_etb_monthly": 10, "features": {"installments": "yes"}}')$q$),
          'P0001|invalid_input|features', 'installments must be a boolean');
select is(public.fn_platform_update_plan((select growth from _f), '{"features": {"multi_station": true}}') -> 'features',
          '{"installments": false, "multi_station": true}'::jsonb, 'update with features lacking installments stores installments=false');
select is(public.fn_platform_update_plan((select growth from _f), '{"price_etb_monthly": 2500}') -> 'features',
          '{"installments": false, "multi_station": true}'::jsonb, 'an update that does not touch features leaves them as they are');
select tests.authenticate_as((select a_admin from _f));
select is(public.fn_get_session_context() -> 'plan_features' -> 'installments', 'false'::jsonb, 'the session context follows the plan at once');
select tests.clear_auth();
select is((select count(*)::int from public.plans where not (features ? 'installments')), 0, 'backfill: every plan states installments');

-- ═════════ B. tenant_admins on the platform tenant detail ═════════
select tests.add_factor((select a_admin from _f), 'totp', 'unverified');
select tests.add_verified_factor((select a_admin from _f));
insert into public.trusted_devices (user_id, scope, factor_id, token_hash, expires_at)
select f.a_admin, 'tenant', (select id from auth.mfa_factors where user_id = f.a_admin and status = 'verified'), h, now() + interval '20 days'
from _f f, (values (repeat('1', 64)), (repeat('2', 64)), (repeat('3', 64))) v(h);
update public.trusted_devices set revoked_at = now(), revoke_reason = 'user' where token_hash = repeat('3', 64);
insert into public.session_device_attestations (session_id, user_id, device_id, expires_at)
select gen_random_uuid(), user_id, id, now() + interval '1 day' from public.trusted_devices where token_hash = repeat('1', 64);
insert into auth.sessions (id, user_id, created_at, updated_at)
select gen_random_uuid(), u, now(), now() from _f, unnest(array[a_admin, a_admin, a_admin2]) u;

select tests.aal2((select su from _f));
insert into _c select 'detail', public.fn_platform_get_tenant((select a from _f)) -> 'tenant_admins';
select is((select string_agg(e ->> 'profile_id', ',' order by e ->> 'profile_id') from _c, jsonb_array_elements(v) e where k = 'detail'),
          (select a_admin::text || ',' || a_admin2::text from _f), 'tenant_admins: exactly the two tenant_admin profiles (no staff)');
select is((select string_agg(x, ',' order by x) from _c, jsonb_array_elements(v) e, jsonb_object_keys(e) x where k = 'detail' and e ->> 'profile_id' = (select a_admin::text from _f)),
          'email,first_name,is_active,last_name,mfa_enrolled,middle_name,profile_id,trusted_devices', 'tenant_admins: identity + authenticator state keys only');
select is((select e - 'profile_id' from _c, jsonb_array_elements(v) e where k = 'detail' and e ->> 'profile_id' = (select a_admin::text from _f)),
          '{"email": "selam@centralcafe.example.com", "first_name": "Selam", "middle_name": "Abate", "last_name": "Girma", "is_active": true, "mfa_enrolled": true, "trusted_devices": 2}'::jsonb,
          'selam: e-mail, names, enrolled, 2 live devices (the revoked one is not counted)');
select is((select (e ->> 'mfa_enrolled')::boolean from _c, jsonb_array_elements(v) e where k = 'detail' and e ->> 'profile_id' = (select a_admin2::text from _f)),
          false, 'dawit: not enrolled');
select is((select jsonb_array_length(public.fn_platform_get_tenant((select b from _f)) -> 'tenant_admins')), 1, 'second-cafe detail lists only its own admin');
select tests.authenticate_as((select a_admin from _f));
select is(tests.run(format('select public.fn_platform_get_tenant(%L)', (select a from _f))), 'P0001|permission_denied|', 'a tenant admin cannot read the platform detail');

-- ═════════ C1. prepare: guards ═════════
select tests.aal2((select a_admin from _f));
select is(tests.run(format($q$select public.fn_platform_prepare_mfa_reset(%L, %L, 'lost phone')$q$, (select a from _f), (select a_admin2 from _f))),
          'P0001|permission_denied|', 'a tenant admin (aal2) is refused');
select tests.authenticate_as((select su from _f));
select is(tests.run(format($q$select public.fn_platform_prepare_mfa_reset(%L, %L, 'lost phone')$q$, (select a from _f), (select a_admin from _f))),
          'P0001|mfa_required|', 'super admin on aal1: mfa_required');
-- aal2 session whose TOTP verification is 13 h old: the platform gate passes, the recent-TOTP step-up does not
do $$ begin
  perform set_config('request.jwt.claims', json_build_object('sub', (select su from _f), 'role', 'authenticated', 'aud', 'authenticated', 'aal', 'aal2',
                     'session_id', gen_random_uuid(),
                     'amr', json_build_array(json_build_object('method', 'totp', 'timestamp', extract(epoch from now() - interval '13 hours')::bigint)))::text, true);
end $$;
select is(tests.run(format($q$select public.fn_platform_prepare_mfa_reset(%L, %L, 'lost phone')$q$, (select a from _f), (select a_admin from _f))),
          'P0001|step_up_required|', 'super admin whose TOTP is older than 12 h: step_up_required');
select tests.as_anon();
select is(tests.run(format($q$select public.fn_platform_prepare_mfa_reset(%L, %L, 'lost phone')$q$, (select a from _f), (select a_admin from _f))),
          '42501|permission denied for function fn_platform_prepare_mfa_reset|', 'anon cannot execute prepare');
select tests.authenticate_as_service_role();
select is(tests.run(format($q$select public.fn_platform_prepare_mfa_reset(%L, %L, 'lost phone')$q$, (select a from _f), (select a_admin from _f))),
          '42501|permission denied for function fn_platform_prepare_mfa_reset|', 'service_role cannot execute prepare (it is the caller-scoped step)');

-- ═════════ C2. prepare: validation and target rules ═════════
select tests.aal2((select su from _f));
select is(tests.run(format($q$select public.fn_platform_prepare_mfa_reset(%L, %L, 'x')$q$, (select a from _f), (select a_admin from _f))),
          'P0001|invalid_input|reason', 'reason 3..500 chars');
select is(tests.run(format($q$select public.fn_platform_prepare_mfa_reset(%L, %L, %L)$q$, (select a from _f), (select a_admin from _f), repeat('r', 501))),
          'P0001|invalid_input|reason', 'reason longer than 500 refused');
select is(tests.run(format($q$select public.fn_platform_prepare_mfa_reset(%L, null, 'lost phone')$q$, (select a from _f))),
          'P0001|invalid_input|profile_id', 'profile_id required');
select is(tests.run(format($q$select public.fn_platform_prepare_mfa_reset(null, %L, 'lost phone')$q$, (select a_admin from _f))),
          'P0001|invalid_input|restaurant_id', 'restaurant_id required');
select is(tests.run(format($q$select public.fn_platform_prepare_mfa_reset(%L, %L, 'lost phone')$q$, (select a from _f), (select su from _f))),
          'P0001|permission_denied|', 'never the caller');
select is(tests.oracle(format($q$select public.fn_platform_prepare_mfa_reset(%L, {id}, 'lost phone')$q$, (select a from _f)), (select b_admin from _f)),
          'P0001|not_found|', 'another tenant''s admin under this restaurant id: not_found, same as unknown');
select is(tests.oracle(format($q$select public.fn_platform_prepare_mfa_reset({id}, %L, 'lost phone')$q$, (select a_admin from _f)), (select b from _f)),
          'P0001|not_found|', 'the right admin under another restaurant id: not_found, same as an unknown restaurant');
select is(tests.run(format($q$select public.fn_platform_prepare_mfa_reset(%L, %L, 'lost phone')$q$, (select a from _f), (select a_waiter from _f))),
          'P0001|not_found|', 'a staff (non tenant_admin) profile: not_found');
select is(tests.run(format($q$select public.fn_platform_prepare_mfa_reset(%L, %L, 'lost phone')$q$, (select a from _f), (select a_admin2 from _f))),
          'P0001|invalid_state|no_factor', 'an admin without a verified factor: invalid_state no_factor');
select tests.clear_auth();
update public.profiles set is_active = false where id = (select a_admin2 from _f);
select tests.add_verified_factor((select a_admin2 from _f));
select tests.aal2((select su from _f));
select is(tests.run(format($q$select public.fn_platform_prepare_mfa_reset(%L, %L, 'lost phone')$q$, (select a from _f), (select a_admin2 from _f))),
          'P0001|not_found|', 'an inactive admin: not_found');

-- ═════════ C3. prepare: happy path + audit + replay ═════════
insert into _c select 'prep', public.fn_platform_prepare_mfa_reset((select a from _f), (select a_admin from _f), '  lost phone, verified by call  ');
select is((select v ->> 'profile_id' from _c where k = 'prep'), (select a_admin::text from _f), 'prepare: profile_id');
select is((select v ->> 'user_id' from _c where k = 'prep'), (select a_admin::text from _f), 'prepare: user_id (the auth user of the profile)');
select is((select string_agg(x, ',' order by x) from _c, jsonb_object_keys(v) x where k = 'prep'), 'factor_ids,profile_id,user_id', 'prepare: exactly these keys');
select lives_ok(format($q$select public.fn_platform_prepare_mfa_reset(%L, %L, 'retry after network error')$q$, (select a from _f), (select a_admin from _f)),
          'replay: prepare again is harmless (read + audit only)');
select tests.clear_auth();
select is((select array(select jsonb_array_elements_text(v -> 'factor_ids') order by 1) from _c where k = 'prep'),
          (select array(select id::text from auth.mfa_factors where user_id = (select a_admin from _f) order by 1)),
          'prepare: every factor of the user (verified and unverified)');
select is((select count(*)::int from public.admin_audit_log where action = 'tenant_admin.mfa_reset_requested'
             and platform_admin_id = (select su from _f) and restaurant_id = (select a from _f) and detail ->> 'profile_id' = (select a_admin::text from _f)),
          2, 'admin_audit_log: one mfa_reset_requested per prepare, actor = the super admin, tenant = central');
select is((select detail ->> 'reason' from public.admin_audit_log where action = 'tenant_admin.mfa_reset_requested' order by created_at, id limit 1),
          'lost phone, verified by call', 'the trimmed reason is recorded');
select is((select tests.n_factors((select a_admin from _f))), 2, 'prepare changes nothing (factors still there)');

-- ═════════ C4. complete: service role only ═════════
select tests.aal2((select su from _f));
select is(tests.run(format($q$select public.fn_platform_complete_mfa_reset(%L, %L, 'lost phone')$q$, (select a_admin from _f), (select su from _f))),
          '42501|permission denied for function fn_platform_complete_mfa_reset|', 'authenticated (even the super admin) cannot execute complete');
select tests.as_anon();
select is(tests.run(format($q$select public.fn_platform_complete_mfa_reset(%L, %L, 'lost phone')$q$, (select a_admin from _f), (select su from _f))),
          '42501|permission denied for function fn_platform_complete_mfa_reset|', 'anon cannot execute complete');
select tests.authenticate_as_service_role();
select is(tests.run(format($q$select public.fn_platform_complete_mfa_reset(%L, %L, 'lost phone')$q$, (select a_admin from _f), (select su from _f))),
          'P0001|invalid_state|factors_remain', 'complete refuses while a verified factor remains');
select is(tests.run(format($q$select public.fn_platform_complete_mfa_reset(%L, %L, 'lost phone')$q$, (select a_admin from _f), (select a_admin2 from _f))),
          'P0001|permission_denied|', 'the actor must be an active super admin (a tenant admin id is refused)');
select is(tests.run(format($q$select public.fn_platform_complete_mfa_reset(%L, gen_random_uuid(), 'lost phone')$q$, (select a_admin from _f))),
          'P0001|permission_denied|', 'an unknown actor is refused');
select is(tests.run(format($q$select public.fn_platform_complete_mfa_reset(%L, %L, 'lost phone')$q$, (select a_waiter from _f), (select su from _f))),
          'P0001|not_found|', 'a staff profile is not a target');
select is(tests.run(format($q$select public.fn_platform_complete_mfa_reset(%L, %L, 'x')$q$, (select a_admin from _f), (select su from _f))),
          'P0001|invalid_input|reason', 'complete validates the reason too');

-- GoTrue deletes the VERIFIED factor (admin.auth.admin.mfa.deleteFactor); an unverified leftover does not block completion
select tests.clear_auth();
delete from auth.mfa_factors where user_id = (select a_admin from _f) and status = 'verified';
select tests.authenticate_as_service_role();
insert into _c select 'done', public.fn_platform_complete_mfa_reset((select a_admin from _f), (select su from _f), 'lost phone, verified by call');
select is((select v from _c where k = 'done'),
          jsonb_build_object('profile_id', (select a_admin from _f), 'sessions_revoked', 2, 'devices_revoked', 2),
          'complete: {profile_id, sessions_revoked, devices_revoked}');
select tests.clear_auth();
select is((select count(*)::int from public.trusted_devices where user_id = (select a_admin from _f) and revoked_at is null), 0, 'every live trusted device is revoked');
select is((select string_agg(distinct revoke_reason || '/' || revoked_by::text, ',') from public.trusted_devices
           where user_id = (select a_admin from _f) and token_hash <> repeat('3', 64)),
          'mfa_reset/' || (select su::text from _f), 'with reason mfa_reset, by the super admin (the earlier revocation is untouched)');
select is((select count(*)::int from public.session_device_attestations where user_id = (select a_admin from _f)), 0, 'its session attestations are gone');
select is((select count(*)::int from auth.sessions where user_id = (select a_admin from _f)), 0, 'every auth session of the user is deleted');
select is((select count(*)::int from auth.sessions where user_id = (select a_admin2 from _f)), 1, 'other users keep their sessions');
select is((select platform_admin_id::text || '|' || restaurant_id::text || '|' || (detail ->> 'devices_revoked') || '|' || (detail ->> 'reason')
           from public.admin_audit_log where action = 'tenant_admin.mfa_reset'),
          (select su::text || '|' || a::text from _f) || '|2|lost phone, verified by call', 'admin_audit_log: tenant_admin.mfa_reset, actor = p_actor, tenant, counts, reason');
select is((select actor_id::text || '|' || actor_type || '|' || (new_data ->> 'profile_id') from public.audit_logs
           where event = 'auth.mfa_reset_by_platform' and restaurant_id = (select a from _f)),
          (select su::text || '|platform_admin|' || a_admin::text from _f), 'tenant audit_logs: auth.mfa_reset_by_platform, actor = the super admin');

-- replay: nothing left to revoke, still audited
select tests.authenticate_as_service_role();
select is(public.fn_platform_complete_mfa_reset((select a_admin from _f), (select su from _f), 'replayed call') - 'profile_id',
          '{"sessions_revoked": 0, "devices_revoked": 0}'::jsonb, 'replay: complete again revokes nothing more');
select tests.aal2((select su from _f));
select is((select e - 'profile_id' - 'email' - 'first_name' - 'middle_name' - 'last_name' - 'is_active'
           from jsonb_array_elements(public.fn_platform_get_tenant((select a from _f)) -> 'tenant_admins') e
           where e ->> 'profile_id' = (select a_admin::text from _f)),
          '{"mfa_enrolled": false, "trusted_devices": 0}'::jsonb, 'the platform detail now shows selam unenrolled, no trusted device');

select * from finish();
rollback;
