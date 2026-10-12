-- Migration 0036: plan features in the session context, explicit installments on plan create/update, Tenant Admins on the platform
-- tenant detail, and the two-step Super Admin MFA reset of a Tenant Admin (prepare AS THE CALLER, complete with the SERVICE ROLE).
-- Happy path, unauthorised (tenant admin / another tenant's admin with a fresh TOTP / aal1 / stale TOTP / anon / authenticated on the
-- service step), cross-tenant (not_found, no oracle), validation, the single-use reset row (expired / completed / superseded), audit
-- rows with the right actor and reason, sessions that survived the reset, finishing a half-done reset.
begin;
select plan(92);

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
select is((select count(*)::int from public.plans where jsonb_typeof(features -> 'installments') <> 'boolean'), 0, 'backfill: installments is a boolean in every plan');

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
          'email,first_name,is_active,last_name,mfa_enrolled,mfa_reset_pending,middle_name,profile_id,recovery_resend_available,trusted_devices', 'tenant_admins: identity + authenticator state keys only');
select is((select e - 'profile_id' from _c, jsonb_array_elements(v) e where k = 'detail' and e ->> 'profile_id' = (select a_admin::text from _f)),
          '{"email": "selam@centralcafe.example.com", "first_name": "Selam", "middle_name": "Abate", "last_name": "Girma", "is_active": true, "mfa_enrolled": true, "mfa_reset_pending": false, "recovery_resend_available": false, "trusted_devices": 2}'::jsonb,
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
-- another tenant's admin on aal2 WITH a fresh TOTP amr (tests.aal2 stamps totp at now()): still not a Super Admin
select tests.aal2((select b_admin from _f));
select is(tests.run(format($q$select public.fn_platform_prepare_mfa_reset(%L, %L, 'lost phone')$q$, (select a from _f), (select a_admin from _f))),
          'P0001|permission_denied|', 'another tenant''s admin with aal2 and a fresh TOTP is refused (permission_denied)');
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
          'P0001|invalid_state|no_factor', 'an admin without a verified factor (and no half-done reset; a live session is not enough): no_factor');
select tests.clear_auth();
update public.profiles set is_active = false where id = (select a_admin2 from _f);
select tests.add_verified_factor((select a_admin2 from _f));
select tests.aal2((select su from _f));
select is(tests.run(format($q$select public.fn_platform_prepare_mfa_reset(%L, %L, 'lost phone')$q$, (select a from _f), (select a_admin2 from _f))),
          'P0001|not_found|', 'an inactive admin: not_found');
select is(tests.run('select 1 from public.mfa_resets'), '42501|permission denied for table mfa_resets|', 'mfa_resets: no client access, even for the super admin');

-- ═════════ C3. prepare: happy path + reset row + audit + replay ═════════
insert into _c select 'prep1', public.fn_platform_prepare_mfa_reset((select a from _f), (select a_admin from _f), '  lost phone, verified by call  ');
select is((select v ->> 'profile_id' from _c where k = 'prep1'), (select a_admin::text from _f), 'prepare: profile_id');
select is((select v ->> 'user_id' from _c where k = 'prep1'), (select a_admin::text from _f), 'prepare: user_id (the auth user of the profile)');
select is((select string_agg(x, ',' order by x) from _c, jsonb_object_keys(v) x where k = 'prep1'), 'factor_ids,profile_id,reset_id,user_id', 'prepare: exactly these keys');
insert into _c select 'prep2', public.fn_platform_prepare_mfa_reset((select a from _f), (select a_admin from _f), 'retry after network error');
select isnt((select v ->> 'reset_id' from _c where k = 'prep2'), (select v ->> 'reset_id' from _c where k = 'prep1'), 'replay: prepare again issues a new single-use reset id');
select tests.clear_auth();
select is((select array(select jsonb_array_elements_text(v -> 'factor_ids') order by 1) from _c where k = 'prep1'),
          (select array(select id::text from auth.mfa_factors where user_id = (select a_admin from _f) order by 1)),
          'prepare: every factor of the user (verified and unverified)');
select is((select user_id::text || '|' || restaurant_id::text || '|' || requested_by::text || '|' || reason || '|' || cardinality(factor_ids)
                  || '|' || (expires_at = created_at + interval '5 minutes') || '|' || (completed_at is null)
           from public.mfa_resets where id = (select (v ->> 'reset_id')::uuid from _c where k = 'prep1')),
          (select a_admin::text || '|' || a::text || '|' || su::text from _f) || '|lost phone, verified by call|2|true|true',
          'mfa_resets row: target, tenant, requester, trimmed reason, factor ids, expires in 5 min, not completed');
select is((select count(*)::int from public.admin_audit_log where action = 'tenant_admin.mfa_reset_requested'
             and platform_admin_id = (select su from _f) and restaurant_id = (select a from _f) and detail ->> 'profile_id' = (select a_admin::text from _f)),
          2, 'admin_audit_log: one mfa_reset_requested per prepare, actor = the super admin, tenant = central');
select is((select string_agg(detail ->> 'reason', '|' order by detail ->> 'reason') from public.admin_audit_log
           where action = 'tenant_admin.mfa_reset_requested' and detail ->> 'profile_id' = (select a_admin::text from _f)),
          'lost phone, verified by call|retry after network error', 'the trimmed reason of each request is recorded');
select is((select tests.n_factors((select a_admin from _f))), 2, 'prepare changes nothing (factors still there)');

-- ═════════ C4. complete: service role only, bound to a reset row ═════════
select tests.aal2((select su from _f));
select is(tests.run(format($q$select public.fn_platform_complete_mfa_reset(%L)$q$, (select v ->> 'reset_id' from _c where k = 'prep2'))),
          '42501|permission denied for function fn_platform_complete_mfa_reset|', 'authenticated (even the super admin) cannot execute complete');
select tests.as_anon();
select is(tests.run(format($q$select public.fn_platform_complete_mfa_reset(%L)$q$, (select v ->> 'reset_id' from _c where k = 'prep2'))),
          '42501|permission denied for function fn_platform_complete_mfa_reset|', 'anon cannot execute complete');
select tests.authenticate_as_service_role();
-- the Edge Function's steps before the factors go: claim (before the rotation), sign-out (after it); the completion requires both
select lives_ok(format('select public.fn_platform_claim_mfa_reset(%L)', (select v ->> 'reset_id' from _c where k = 'prep2')), 'setup: prep2 claimed');
select lives_ok(format('select public.fn_platform_mfa_reset_sign_out(%L)', (select v ->> 'reset_id' from _c where k = 'prep2')), 'setup: prep2 signed out');
select is(tests.run(format($q$select public.fn_platform_complete_mfa_reset(%L)$q$, (select v ->> 'reset_id' from _c where k = 'prep2'))),
          'P0001|invalid_state|factors_remain', 'complete refuses while a verified factor remains');
select is(tests.run('select public.fn_platform_complete_mfa_reset(gen_random_uuid())'), 'P0001|not_found|', 'an unknown reset id: not_found');
select is(tests.run('select public.fn_platform_complete_mfa_reset(null)'), 'P0001|invalid_input|reset_id', 'reset id required');
select tests.clear_auth();
insert into public.mfa_resets (user_id, restaurant_id, requested_by, reason, factor_ids, created_at, expires_at)
select a_admin, a, su, 'stale request', '{}', now() - interval '10 minutes', now() - interval '5 minutes' from _f;
insert into _c select 'stale', to_jsonb(id) from public.mfa_resets where reason = 'stale request';
select tests.authenticate_as_service_role();
select is(tests.run(format($q$select public.fn_platform_complete_mfa_reset(%L)$q$, (select v #>> '{}' from _c where k = 'stale'))),
          'P0001|invalid_state|reset_expired', 'an expired reset row (older than 5 min): reset_expired');

-- GoTrue deletes the VERIFIED factor (admin.auth.admin.mfa.deleteFactor); an unverified leftover does not block completion
select tests.clear_auth();
delete from auth.mfa_factors where user_id = (select a_admin from _f) and status = 'verified';
select tests.authenticate_as_service_role();
insert into _c select 'done', public.fn_platform_complete_mfa_reset((select (v ->> 'reset_id')::uuid from _c where k = 'prep2'));
select is((select v from _c where k = 'done'),
          jsonb_build_object('profile_id', (select a_admin from _f), 'sessions_revoked', 2, 'devices_revoked', 2),
          'complete: {profile_id, sessions_revoked, devices_revoked} (totals: the sign-out step + the completion)');
select tests.clear_auth();
select ok((select completed_at is not null from public.mfa_resets where id = (select (v ->> 'reset_id')::uuid from _c where k = 'prep2')), 'the reset row is consumed (completed_at)');
select is((select count(*)::int from public.trusted_devices where user_id = (select a_admin from _f) and revoked_at is null), 0, 'every live trusted device is revoked');
select is((select string_agg(distinct revoke_reason || '/' || revoked_by::text, ',') from public.trusted_devices
           where user_id = (select a_admin from _f) and token_hash <> repeat('3', 64)),
          'mfa_reset/' || (select su::text from _f), 'with reason mfa_reset, by the requesting super admin (the earlier revocation is untouched)');
select is((select count(*)::int from public.session_device_attestations where user_id = (select a_admin from _f)), 0, 'its session attestations are gone');
select is((select count(*)::int from auth.sessions where user_id = (select a_admin from _f)), 0, 'every auth session of the user is deleted');
select is((select count(*)::int from auth.sessions where user_id = (select a_admin2 from _f)), 1, 'other users keep their sessions');
select is((select platform_admin_id::text || '|' || restaurant_id::text || '|' || (detail ->> 'devices_revoked') || '|' || (detail ->> 'reason')
           from public.admin_audit_log where action = 'tenant_admin.mfa_reset'),
          (select su::text || '|' || a::text from _f) || '|2|retry after network error', 'admin_audit_log: tenant_admin.mfa_reset, actor = the requester, tenant, counts, the row''s reason');
select is((select actor_id::text || '|' || actor_type || '|' || (new_data ->> 'profile_id') || '|' || (new_data ->> 'reason') from public.audit_logs
           where event = 'auth.mfa_reset_by_platform' and restaurant_id = (select a from _f)),
          (select su::text || '|platform_admin|' || a_admin::text from _f) || '|retry after network error',
          'tenant audit_logs: auth.mfa_reset_by_platform, actor = the super admin, with the reason');

-- replay
select tests.authenticate_as_service_role();
select is(tests.run(format($q$select public.fn_platform_complete_mfa_reset(%L)$q$, (select v ->> 'reset_id' from _c where k = 'prep2'))),
          'P0001|invalid_state|reset_completed', 'replay of a completed reset is refused');
select is(tests.run(format($q$select public.fn_platform_complete_mfa_reset(%L)$q$, (select v ->> 'reset_id' from _c where k = 'prep1'))),
          'P0001|invalid_state|reset_superseded', 'an older, unused reset of the same user is spent by the completion');
select is((select count(*)::int from public.admin_audit_log where action = 'tenant_admin.mfa_reset'), 1, 'no second completion was recorded');
select tests.aal2((select su from _f));
select is((select e - 'profile_id' - 'email' - 'first_name' - 'middle_name' - 'last_name' - 'is_active'
           from jsonb_array_elements(public.fn_platform_get_tenant((select a from _f)) -> 'tenant_admins') e
           where e ->> 'profile_id' = (select a_admin::text from _f)),
          '{"mfa_enrolled": false, "mfa_reset_pending": false, "recovery_resend_available": true, "trusted_devices": 0}'::jsonb,
          'the platform detail now shows selam unenrolled, nothing pending, no trusted device, the recovery e-mail can be resent');
select is(tests.run(format($q$select public.fn_platform_prepare_mfa_reset(%L, %L, 'again')$q$, (select a from _f), (select a_admin from _f))),
          'P0001|invalid_state|no_factor', 'after a completed reset, nothing is left to reset (no_factor)');
select tests.clear_auth();

-- ═════════ C5. sessions that survived the reset never pass an MFA gate again ═════════
-- hosted Supabase may not let the DB delete auth.sessions: model a surviving session, then a fresh one created after the reset
insert into _c select 'sid_old', to_jsonb(gen_random_uuid());
insert into _c select 'sid_new', to_jsonb(gen_random_uuid());
insert into auth.sessions (id, user_id, created_at, updated_at)
select (select (v #>> '{}')::uuid from _c where k = 'sid_old'), a_admin, now() - interval '1 hour', now() from _f;
insert into auth.sessions (id, user_id, created_at, updated_at)
select (select (v #>> '{}')::uuid from _c where k = 'sid_new'), a_admin, clock_timestamp() + interval '1 second', now() from _f;
-- the attacker on the old session enrols a NEW authenticator (verified factor) and even gets a trusted device attested
select tests.add_verified_factor((select a_admin from _f));
insert into public.trusted_devices (user_id, scope, factor_id, token_hash, expires_at)
select f.a_admin, 'tenant', (select id from auth.mfa_factors where user_id = f.a_admin and status = 'verified'), repeat('9', 64), now() + interval '20 days' from _f f;
insert into public.session_device_attestations (session_id, user_id, device_id, expires_at)
select (select (v #>> '{}')::uuid from _c where k = 'sid_old'), a_admin, (select id from public.trusted_devices where token_hash = repeat('9', 64)), now() + interval '1 day' from _f;
create function tests.claims_48(p_user uuid, p_sid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated', 'aud', 'authenticated', 'aal', 'aal2',
                     'session_id', p_sid,
                     'amr', json_build_array(json_build_object('method', 'totp', 'timestamp', extract(epoch from now())::bigint)))::text, true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
end $$;
select tests.claims_48((select a_admin from _f), (select (v #>> '{}')::uuid from _c where k = 'sid_old'));
select ok(public.fn_device_trust_satisfied(), 'control: the old session holds a live device attestation and aal2 with a verified factor');
select ok(not public.fn_mfa_session_ok(), 'a session created BEFORE the reset fails fn_mfa_session_ok (aal2 + new factor + device are not enough)');
select is(tests.run('select public.fn_require_recent_totp()'), 'P0001|step_up_required|', 'and fn_require_recent_totp (fresh TOTP amr is not enough)');
select is(tests.run('select public.fn_require_aal2()'), 'P0001|mfa_required|', 'and fn_require_aal2');
select is(tests.run('select public.fn_require_step_up()'), 'P0001|mfa_required|', 'and fn_require_step_up');
select tests.claims_48((select a_admin from _f), gen_random_uuid());
select ok(not public.fn_mfa_session_ok(), 'a session id with no auth.sessions row: not ok (fail closed)');
select tests.claims_48((select a_admin from _f), (select (v #>> '{}')::uuid from _c where k = 'sid_new'));
select ok(public.fn_mfa_session_ok(), 'a session created AFTER the reset (recovery sign-in + new factor) passes');
select lives_ok('select public.fn_require_recent_totp()', 'and passes the recent-TOTP gate');
select tests.claims_48((select b_admin from _f), gen_random_uuid());
select ok(public.fn_mfa_session_ok(), 'a user without any reset keeps passing fn_mfa_session_ok with an unknown session id (no behaviour change)');
select tests.clear_auth();

-- ═════════ C6. a half-done reset can be finished; a refused completion after the factors are gone is audited ═════════
do $$ begin perform tests.create_auth_user('00000000-0000-4000-8000-0000000000c8', 'second.super@cafeos.example.com'); end $$;
insert into public.platform_admins (id, full_name, role, is_active) values ('00000000-0000-4000-8000-0000000000c8', 'Second Super', 'platform_super_admin', true);
select tests.aal2('00000000-0000-4000-8000-0000000000c8');
insert into _c select 'prepB', public.fn_platform_prepare_mfa_reset((select b from _f), (select b_admin from _f), 'lost phone B');
select tests.authenticate_as_service_role();
select lives_ok(format('select public.fn_platform_claim_mfa_reset(%L)', (select v ->> 'reset_id' from _c where k = 'prepB')), 'setup: prepB claimed');
select lives_ok(format('select public.fn_platform_mfa_reset_sign_out(%L)', (select v ->> 'reset_id' from _c where k = 'prepB')), 'setup: prepB signed out');
select tests.clear_auth();
update public.platform_admins set is_active = false where id = '00000000-0000-4000-8000-0000000000c8';
select tests.authenticate_as_service_role();
select is(tests.run(format($q$select public.fn_platform_complete_mfa_reset(%L)$q$, (select v ->> 'reset_id' from _c where k = 'prepB'))),
          'P0001|permission_denied|', 'the requester is no longer an active super admin and the factors are still there: refused, nothing changes');
select tests.clear_auth();
delete from auth.mfa_factors where user_id = (select b_admin from _f);   -- GoTrue deleted them before the completion
select tests.authenticate_as_service_role();
select is(public.fn_platform_complete_mfa_reset((select (v ->> 'reset_id')::uuid from _c where k = 'prepB')),
          jsonb_build_object('profile_id', (select b_admin from _f), 'refused', 'permission_denied'),
          'factors already gone: the refusal is RETURNED (not raised)');
select tests.clear_auth();
select is((select platform_admin_id::text || '|' || restaurant_id::text || '|' || (detail ->> 'refused') from public.admin_audit_log
           where action = 'tenant_admin.mfa_reset_incomplete'),
          '00000000-0000-4000-8000-0000000000c8|' || (select b::text from _f) || '|permission_denied', 'admin_audit_log: tenant_admin.mfa_reset_incomplete persists');
select ok((select completed_at is null from public.mfa_resets where id = (select (v ->> 'reset_id')::uuid from _c where k = 'prepB')), 'the refused reset is not completed');
-- the claimed, refused attempt blocks every other claim of the user until it expires (5 min): age it
update public.mfa_resets set created_at = now() - interval '10 minutes', expires_at = now() - interval '5 minutes',
                             claimed_at = now() - interval '9 minutes', signed_out_at = now() - interval '9 minutes'
 where id = (select (v ->> 'reset_id')::uuid from _c where k = 'prepB');
select tests.aal2((select su from _f));
select is((select (e ->> 'mfa_enrolled') || '|' || (e ->> 'mfa_reset_pending')
           from jsonb_array_elements(public.fn_platform_get_tenant((select b from _f)) -> 'tenant_admins') e),
          'false|true', 'the platform detail reports the half-done reset as pending');
insert into _c select 'finishB', public.fn_platform_prepare_mfa_reset((select b from _f), (select b_admin from _f), 'finish the reset of B');
select is((select v -> 'factor_ids' from _c where k = 'finishB'), '[]'::jsonb, 'finishing: prepare is allowed without a factor and hands out no factor id');
select is((select detail ->> 'finishing' from public.admin_audit_log where action = 'tenant_admin.mfa_reset_requested' and detail ->> 'reason' = 'finish the reset of B'),
          'true', 'the request is audited as finishing a half-done reset');
select tests.authenticate_as_service_role();
select lives_ok(format('select public.fn_platform_claim_mfa_reset(%L)', (select v ->> 'reset_id' from _c where k = 'finishB')), 'setup: finishB claimed');
select lives_ok(format('select public.fn_platform_mfa_reset_sign_out(%L)', (select v ->> 'reset_id' from _c where k = 'finishB')), 'setup: finishB signed out');
select is(public.fn_platform_complete_mfa_reset((select (v ->> 'reset_id')::uuid from _c where k = 'finishB')) - 'sessions_revoked' - 'devices_revoked',
          jsonb_build_object('profile_id', (select b_admin from _f)), 'the finishing reset completes');
select tests.clear_auth();
-- give the refused first attempt its 5 minutes back: it is spent by the completion, not merely by its age
update public.mfa_resets set expires_at = now() + interval '5 minutes' where id = (select (v ->> 'reset_id')::uuid from _c where k = 'prepB');
select tests.authenticate_as_service_role();
select is(tests.run(format($q$select public.fn_platform_complete_mfa_reset(%L)$q$, (select v ->> 'reset_id' from _c where k = 'prepB'))),
          'P0001|invalid_state|reset_superseded', 'the refused first attempt can no longer be used');
select tests.aal2((select su from _f));
select is((select e ->> 'mfa_reset_pending' from jsonb_array_elements(public.fn_platform_get_tenant((select b from _f)) -> 'tenant_admins') e),
          'false', 'nothing pending any more');
select tests.clear_auth();
select is((select actor_id::text || '|' || (new_data ->> 'reason') from public.audit_logs where event = 'auth.mfa_reset_by_platform' and restaurant_id = (select b from _f)),
          (select su::text from _f) || '|finish the reset of B', 'second-cafe''s own audit log records its reset (actor = the finishing super admin) and why');
select is((select count(*)::int from public.audit_logs where event = 'auth.mfa_reset_by_platform' and restaurant_id = (select a from _f)), 1,
          'central-cafe''s audit log is untouched by the reset of second-cafe''s admin');

select * from finish();
rollback;
