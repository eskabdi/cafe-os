-- Migration 0036, the hardened reset order and the recovery resend:
--   * fn_platform_claim_mfa_reset (service role, BEFORE the password rotation): single claim per user in flight, superseded /
--     expired / completed / suspended tenant refused while nothing has changed yet
--   * fn_platform_mfa_reset_sign_out (service role, after the rotation, before the factors are deleted): claimed rows only, counts
--     carried into the completion totals
--   * fn_session_after_mfa_reset: a PENDING (prepared, unexpired) reset and a CLAIMED (possibly rotated, even expired) reset cut the
--     old sessions off at once; an expired, unclaimed one does not
--   * fn_platform_complete_mfa_reset: suspended / cancelled tenant refused; a refusal after the factors are gone is recorded in BOTH
--     trails with the reason
--   * fn_platform_prepare_recovery_resend (caller, Super Admin + recent TOTP): happy path + audit in both trails, unauthorized,
--     cross-tenant, not available (no completed reset / a factor exists), suspended tenant, replay (audited each time)
--   * fn_platform_get_tenant: recovery_resend_available
--   * fn_platform_complete_mfa_reset refuses a row never claimed / never signed out, validates late_factors and records it in both
--     trails; fn_platform_mfa_reset_abort (service role) audits a stop after the claim and leaves the row claimed
--   * resend stays available when a LATER-requested reset was abandoned after an earlier one completed, and disappears once the
--     admin signed in after the completion
begin;
select plan(89);

create temp table _f on commit drop as
select tests.tenant_id('central-cafe') a, tests.tenant_id('second-cafe') b,
       '00000000-0000-4000-8000-0000000000c1'::uuid su,
       tests.user_id('selam', 'central-cafe') a_admin, tests.user_id('dawit', 'central-cafe') a_admin2,
       tests.user_id('yonas', 'central-cafe') a_waiter,
       tests.user_id('owner', 'second-cafe') b_admin;
grant all on _f to public;
create temp table _c (k text primary key, v jsonb) on commit drop;
grant all on _c to public;

-- the uuid stored under k (a bare uuid, or the reset_id of an RPC result)
create function tests.u50(p_k text) returns uuid language sql stable as $$
  select coalesce(v ->> 'reset_id', v #>> '{}')::uuid from _c where k = p_k $$;
-- claims of one session (owner role kept, for internal predicates): aal2 with a TOTP verified at p_totp_at
create function tests.c50(p_user uuid, p_sid uuid, p_totp_at timestamptz) returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', 'authenticated', 'aud', 'authenticated', 'aal', 'aal2',
    'session_id', p_sid, 'amr', jsonb_build_array(jsonb_build_object('method', 'totp', 'timestamp', extract(epoch from p_totp_at)::bigint)))::text, true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
end $$;
create function tests.c50c(p_user uuid, p_sid uuid, p_totp_at timestamptz) returns void language plpgsql as $$
begin
  perform tests.c50(p_user, p_sid, p_totp_at);
  execute 'set local role authenticated';
end $$;
create function tests.session50(p_k text, p_user uuid, p_created timestamptz) returns void language sql as $$
  insert into _c values (p_k, to_jsonb(gen_random_uuid()));
  insert into auth.sessions (id, user_id, created_at, updated_at) select tests.u50(p_k), p_user, p_created, now() $$;
grant execute on all functions in schema tests to anon, authenticated, service_role;

-- fixtures: selam (central) has a verified factor and a session from an hour ago
select tests.add_verified_factor((select a_admin from _f)) where tests.n_factors((select a_admin from _f), 'verified') = 0;
select tests.session50('sid_old', (select a_admin from _f), now() - interval '1 hour');

-- ═════════ 1. privileges ═════════
select is((select string_agg(r || ':' || f, ',') from unnest(array['anon', 'authenticated']) r,
             unnest(array['public.fn_platform_claim_mfa_reset(uuid)', 'public.fn_platform_mfa_reset_sign_out(uuid)',
                          'public.fn_mfa_reset_revoke_access(uuid,uuid)', 'public.fn_mfa_reset_target_check(uuid,uuid)',
                          'public.fn_mfa_recovery_resend_available(uuid)']) f
           where has_function_privilege(r, f, 'EXECUTE')), null, 'claim / sign-out / internals: not executable by anon or authenticated');
select ok(has_function_privilege('service_role', 'public.fn_platform_claim_mfa_reset(uuid)', 'EXECUTE')
          and has_function_privilege('service_role', 'public.fn_platform_mfa_reset_sign_out(uuid)', 'EXECUTE'), 'service_role executes claim and sign-out');
select ok(not has_function_privilege('service_role', 'public.fn_mfa_reset_revoke_access(uuid,uuid)', 'EXECUTE'), 'service_role cannot call the revoke internal directly');
select is((select string_agg(r, ',' order by r) from unnest(array['anon', 'authenticated', 'service_role']) r
           where has_function_privilege(r, 'public.fn_platform_mfa_reset_abort(uuid,text)', 'EXECUTE')), 'service_role',
          'abort: service_role only');
select is((select string_agg(r, ',' order by r) from unnest(array['anon', 'authenticated', 'service_role']) r
           where has_function_privilege(r, 'public.fn_platform_prepare_recovery_resend(uuid,uuid,text)', 'EXECUTE')), 'authenticated',
          'resend prepare: authenticated only (the Super Admin through the Edge Function, as the caller)');

-- ═════════ 2. a pending reset cuts the old sessions off at once ═════════
select tests.aal2((select su from _f));
insert into _c select 'r1', public.fn_platform_prepare_mfa_reset((select a from _f), (select a_admin from _f), 'lost phone, call verified');
insert into _c select 'r2', public.fn_platform_prepare_mfa_reset((select a from _f), (select a_admin from _f), 'second tab');
select tests.c50((select a_admin from _f), tests.u50('sid_old'), now());
select ok(not public.fn_mfa_session_ok(), 'pending reset: the pre-reset session (aal2, verified factor, fresh TOTP) is no longer MFA-satisfied');
select is(tests.run('select public.fn_require_step_up()'), 'P0001|mfa_required|', 'pending reset: fn_require_step_up refuses the old session');
select tests.clear_auth();
select tests.session50('sid_after_prep', (select a_admin from _f), clock_timestamp() + interval '1 second');
select tests.c50((select a_admin from _f), tests.u50('sid_after_prep'), now());
select ok(public.fn_mfa_session_ok(), 'control: a session created after the request still passes (the factor is still there)');
select tests.clear_auth();

-- ═════════ 3. claim ═════════
select tests.aal2((select su from _f));
select is(tests.run(format('select public.fn_platform_claim_mfa_reset(%L)', tests.u50('r1'))),
          '42501|permission denied for function fn_platform_claim_mfa_reset|', 'the super admin itself cannot claim (service step)');
select tests.authenticate_as_service_role();
select is(tests.run('select public.fn_platform_claim_mfa_reset(null)'), 'P0001|invalid_input|reset_id', 'claim: reset id required');
select is(tests.run('select public.fn_platform_claim_mfa_reset(gen_random_uuid())'), 'P0001|not_found|', 'claim: unknown reset id');
insert into _c select 'claim1', public.fn_platform_claim_mfa_reset(tests.u50('r1'));
select is((select string_agg(x, ',' order by x) from _c, jsonb_object_keys(v) x where k = 'claim1'),
          'created_at,factor_ids,profile_id,reset_id,user_id', 'claim: exactly these keys');
select tests.clear_auth();
select is((select (v -> 'factor_ids') = to_jsonb(m.factor_ids) and (v ->> 'created_at')::timestamptz = m.created_at and m.claimed_at is not null
           from _c, public.mfa_resets m where k = 'claim1' and m.id = tests.u50('r1')), true,
          'claim: the row''s factor ids and request time, claimed_at stamped');
select tests.authenticate_as_service_role();
select is(tests.run(format('select public.fn_platform_claim_mfa_reset(%L)', tests.u50('r1'))), 'P0001|invalid_state|reset_in_progress', 'claim replay: reset_in_progress');
select is(tests.run(format('select public.fn_platform_claim_mfa_reset(%L)', tests.u50('r2'))), 'P0001|invalid_state|reset_in_progress',
          'a second reset of the same user cannot be claimed while the first is in flight');
select tests.clear_auth();
select is((select count(*)::int from public.admin_audit_log where action = 'tenant_admin.mfa_reset_claimed' and platform_admin_id = (select su from _f)
             and detail ->> 'reset_id' = tests.u50('r1')::text), 1, 'claim audited once, actor = the requesting super admin');

-- ═════════ 4. sign-out ═════════
insert into _c select 'n_sess', to_jsonb((select count(*) from auth.sessions where user_id = (select a_admin from _f)));
select tests.authenticate_as_service_role();
select is(tests.run(format('select public.fn_platform_mfa_reset_sign_out(%L)', tests.u50('r2'))), 'P0001|invalid_state|reset_not_claimed',
          'sign-out: an unclaimed row is refused');
select is(tests.run(format('select public.fn_platform_complete_mfa_reset(%L)', tests.u50('r2'))), 'P0001|invalid_state|reset_not_claimed',
          'complete: a row that was never claimed is refused (no password rotation happened under it)');
insert into _c select 's1', public.fn_platform_mfa_reset_sign_out(tests.u50('r1'));
select is((select (v -> 'sessions_revoked') = (select v from _c where k = 'n_sess') from _c where k = 's1'), true, 'sign-out: every session of the user counted');
select tests.clear_auth();
select is((select count(*)::int from auth.sessions where user_id = (select a_admin from _f)), 0, 'sign-out: the user''s sessions are deleted');
select ok((select signed_out_at is not null and sessions_revoked = (select (v #>> '{}')::int from _c where k = 'n_sess')
           from public.mfa_resets where id = tests.u50('r1')), 'sign-out: recorded on the reset row');
select ok(tests.n_factors((select a_admin from _f), 'verified') > 0, 'sign-out leaves the factors alone (they are deleted last)');
select is((select count(*)::int from public.admin_audit_log where action = 'tenant_admin.mfa_reset_signed_out' and detail ->> 'reset_id' = tests.u50('r1')::text), 1,
          'sign-out audited');
select tests.aal2((select su from _f));
select is(tests.run(format('select public.fn_platform_mfa_reset_sign_out(%L)', tests.u50('r1'))),
          '42501|permission denied for function fn_platform_mfa_reset_sign_out|', 'the super admin itself cannot call the sign-out step');
select tests.clear_auth();

-- ═════════ 5. complete: totals include the sign-out step ═════════
delete from auth.mfa_factors where user_id = (select a_admin from _f);
select tests.session50('sid_straggler', (select a_admin from _f), now());   -- e.g. a refresh between the sign-out and the completion
select tests.authenticate_as_service_role();
insert into _c select 'd1', public.fn_platform_complete_mfa_reset(tests.u50('r1'));
select is((select (v ->> 'sessions_revoked')::int from _c where k = 'd1'), (select (v #>> '{}')::int + 1 from _c where k = 'n_sess'),
          'complete: sessions_revoked = the sign-out step + the straggler');
select tests.clear_auth();
select is((select (detail ->> 'sessions_revoked')::int from public.admin_audit_log where action = 'tenant_admin.mfa_reset' and detail ->> 'reset_id' = tests.u50('r1')::text),
          (select (v ->> 'sessions_revoked')::int from _c where k = 'd1'), 'the admin trail records the totals');
select tests.authenticate_as_service_role();
select is(tests.run(format('select public.fn_platform_claim_mfa_reset(%L)', tests.u50('r2'))), 'P0001|invalid_state|reset_superseded',
          'the concurrently prepared reset can no longer be claimed: it can never rotate the password set from the first recovery link');
select is(tests.run(format('select public.fn_platform_mfa_reset_sign_out(%L)', tests.u50('r1'))), 'P0001|invalid_state|reset_completed', 'sign-out after completion: reset_completed');
select tests.clear_auth();

-- ═════════ 6. resend the recovery e-mail ═════════
select tests.aal2((select su from _f));
select is((select (e ->> 'recovery_resend_available')::boolean from jsonb_array_elements(public.fn_platform_get_tenant((select a from _f)) -> 'tenant_admins') e
           where e ->> 'profile_id' = (select a_admin::text from _f)), true, 'detail: selam (completed reset, no factor) can get the recovery e-mail again');
select is((select (e ->> 'recovery_resend_available')::boolean from jsonb_array_elements(public.fn_platform_get_tenant((select a from _f)) -> 'tenant_admins') e
           where e ->> 'profile_id' = (select a_admin2::text from _f)), false, 'detail: dawit (never reset) cannot');
select is(tests.run(format($q$select public.fn_platform_prepare_recovery_resend(%L, %L, 'x')$q$, (select a from _f), (select a_admin from _f))),
          'P0001|invalid_input|reason', 'resend: reason 3..500');
select is(tests.oracle(format($q$select public.fn_platform_prepare_recovery_resend(%L, {id}, 'link expired')$q$, (select a from _f)), (select b_admin from _f)),
          'P0001|not_found|', 'resend: another tenant''s admin under this restaurant: not_found, same as unknown');
select is(tests.run(format($q$select public.fn_platform_prepare_recovery_resend(%L, %L, 'link expired')$q$, (select a from _f), (select a_waiter from _f))),
          'P0001|not_found|', 'resend: a staff member: not_found');
select is(tests.run(format($q$select public.fn_platform_prepare_recovery_resend(%L, %L, 'link expired')$q$, (select a from _f), (select a_admin2 from _f))),
          'P0001|invalid_state|recovery_not_available', 'resend: an admin who never had a completed reset: recovery_not_available');
select is(tests.run(format($q$select public.fn_platform_prepare_recovery_resend(%L, %L, 'link expired')$q$, (select a from _f), (select su from _f))),
          'P0001|permission_denied|', 'resend: never the caller');
select tests.c50c((select su from _f), gen_random_uuid(), now() - interval '13 hours');
select is(tests.run(format($q$select public.fn_platform_prepare_recovery_resend(%L, %L, 'link expired')$q$, (select a from _f), (select a_admin from _f))),
          'P0001|step_up_required|', 'resend: a TOTP older than 12 h: step_up_required');
select tests.clear_auth();
select tests.session50('sid_sel_new', (select a_admin from _f), clock_timestamp() + interval '1 second');
select tests.c50c((select a_admin from _f), tests.u50('sid_sel_new'), now());
select is(tests.run(format($q$select public.fn_platform_prepare_recovery_resend(%L, %L, 'my own link')$q$, (select a from _f), (select a_admin from _f))),
          'P0001|permission_denied|', 'resend: a tenant admin (even for itself) is refused');
select tests.authenticate_as_service_role();
select is(tests.run(format($q$select public.fn_platform_prepare_recovery_resend(%L, %L, 'link expired')$q$, (select a from _f), (select a_admin from _f))),
          '42501|permission denied for function fn_platform_prepare_recovery_resend|', 'resend: service_role cannot run the caller step');
select tests.aal2((select su from _f));
select is(public.fn_platform_prepare_recovery_resend((select a from _f), (select a_admin from _f), '  link expired, call verified  '),
          jsonb_build_object('profile_id', (select a_admin from _f), 'user_id', (select a_admin from _f)), 'resend: {profile_id, user_id}');
select lives_ok(format($q$select public.fn_platform_prepare_recovery_resend(%L, %L, 'sent again')$q$, (select a from _f), (select a_admin from _f)),
                'resend replay: allowed again (GoTrue rate-limits the e-mail), audited again');
select tests.clear_auth();
select is((select string_agg(detail ->> 'reason', '|' order by created_at, detail ->> 'reason') from public.admin_audit_log
           where action = 'tenant_admin.recovery_resent' and platform_admin_id = (select su from _f) and restaurant_id = (select a from _f)
             and detail ->> 'profile_id' = (select a_admin::text from _f)), 'link expired, call verified|sent again',
          'admin trail: tenant_admin.recovery_resent per request, actor = the super admin, trimmed reason');
select is((select count(*)::int from public.audit_logs where event = 'auth.recovery_resent_by_platform' and restaurant_id = (select a from _f)
             and actor_id = (select su from _f) and actor_type = 'platform_admin' and new_data ->> 'reason' is not null), 2,
          'tenant trail: auth.recovery_resent_by_platform with the reason');
select is((select count(*)::int from public.audit_logs where event = 'auth.recovery_resent_by_platform' and restaurant_id = (select b from _f)), 0,
          'nothing in another tenant''s trail');
-- once a factor is enrolled again there is nothing to resend
select tests.add_verified_factor((select a_admin from _f));
select tests.aal2((select su from _f));
select is(tests.run(format($q$select public.fn_platform_prepare_recovery_resend(%L, %L, 'link expired')$q$, (select a from _f), (select a_admin from _f))),
          'P0001|invalid_state|recovery_not_available', 'resend: refused once the admin has a verified factor again');
select tests.clear_auth();
delete from auth.mfa_factors where user_id = (select a_admin from _f);

-- ═════════ 7. suspended / cancelled tenant: claim, complete (both ways) and resend refused; refusal in both trails ═════════
select tests.add_verified_factor((select b_admin from _f)) where tests.n_factors((select b_admin from _f), 'verified') = 0;
select tests.aal2((select su from _f));
insert into _c select 'rB0', public.fn_platform_prepare_mfa_reset((select b from _f), (select b_admin from _f), 'lost phone B, first try');
select lives_ok(format($q$select public.fn_suspend_tenant(%L, 'non-payment of the invoice')$q$, (select b from _f)), 'setup: second-cafe suspended after the request');
select tests.authenticate_as_service_role();
select is(tests.run(format('select public.fn_platform_claim_mfa_reset(%L)', tests.u50('rB0'))), 'P0001|tenant_suspended|', 'claim: suspended tenant refused before anything changes');
select tests.aal2((select su from _f));
select lives_ok(format($q$select public.fn_reactivate_tenant(%L, 'invoice paid')$q$, (select b from _f)), 'setup: second-cafe reactivated');
-- a reset that got through claim and sign-out, then the tenant is suspended before the completion
insert into _c select 'rB', public.fn_platform_prepare_mfa_reset((select b from _f), (select b_admin from _f), 'lost phone B');
select tests.authenticate_as_service_role();
select lives_ok(format('select public.fn_platform_claim_mfa_reset(%L)', tests.u50('rB')), 'setup: rB claimed');
select lives_ok(format('select public.fn_platform_mfa_reset_sign_out(%L)', tests.u50('rB')), 'setup: rB signed out');
select tests.aal2((select su from _f));
select lives_ok(format($q$select public.fn_suspend_tenant(%L, 'non-payment again')$q$, (select b from _f)), 'setup: second-cafe suspended again');
select tests.authenticate_as_service_role();
select is(tests.run(format('select public.fn_platform_complete_mfa_reset(%L)', tests.u50('rB'))), 'P0001|tenant_suspended|',
          'complete: suspended tenant refused (raised while the factors remain)');
select tests.clear_auth();
delete from auth.mfa_factors where user_id = (select b_admin from _f);
select tests.authenticate_as_service_role();
select is(public.fn_platform_complete_mfa_reset(tests.u50('rB')), jsonb_build_object('profile_id', (select b_admin from _f), 'refused', 'tenant_suspended'),
          'complete after the factors are gone: the tenant_suspended refusal is returned');
select tests.clear_auth();
select is((select platform_admin_id::text || '|' || (detail ->> 'refused') || '|' || (detail ->> 'reason') from public.admin_audit_log
           where action = 'tenant_admin.mfa_reset_incomplete' and detail ->> 'reset_id' = tests.u50('rB')::text),
          (select su::text from _f) || '|tenant_suspended|lost phone B', 'admin trail: mfa_reset_incomplete with the refusal and the reason');
select is((select actor_id::text || '|' || actor_type || '|' || (new_data ->> 'profile_id') || '|' || (new_data ->> 'refused') || '|' || (new_data ->> 'reason')
           from public.audit_logs where event = 'auth.mfa_reset_incomplete_by_platform' and restaurant_id = (select b from _f)),
          (select su::text || '|platform_admin|' || b_admin::text from _f) || '|tenant_suspended|lost phone B',
          'tenant trail: auth.mfa_reset_incomplete_by_platform, actor = the super admin, with the refusal and the reason');
select ok((select completed_at is null from public.mfa_resets where id = tests.u50('rB')), 'the refused reset is not completed');
select tests.aal2((select su from _f));
select is(tests.run(format($q$select public.fn_platform_prepare_mfa_reset(%L, %L, 'finish B')$q$, (select b from _f), (select b_admin from _f))),
          'P0001|tenant_suspended|', 'finishing it is refused too while the tenant is suspended');
select lives_ok(format($q$select public.fn_suspend_tenant(%L, 'non-payment of central')$q$, (select a from _f)), 'setup: central-cafe suspended');
select is(tests.run(format($q$select public.fn_platform_prepare_recovery_resend(%L, %L, 'link expired')$q$, (select a from _f), (select a_admin from _f))),
          'P0001|tenant_suspended|', 'resend: suspended tenant refused');
select is((select (e ->> 'recovery_resend_available')::boolean from jsonb_array_elements(public.fn_platform_get_tenant((select a from _f)) -> 'tenant_admins') e
           where e ->> 'profile_id' = (select a_admin::text from _f)), false, 'detail: no resend offered while the tenant is suspended');
select tests.clear_auth();

-- ═════════ 8. which reset rows cut sessions off ═════════
select tests.session50('sid_dawit_old', (select a_admin2 from _f), now() - interval '20 minutes');
select tests.session50('sid_dawit_recent', (select a_admin2 from _f), now() - interval '1 minute');
insert into public.mfa_resets (user_id, restaurant_id, requested_by, reason, created_at, expires_at)
select a_admin2, a, su, 'expired unclaimed', now() - interval '10 minutes', now() - interval '5 minutes' from _f;
select tests.c50((select a_admin2 from _f), tests.u50('sid_dawit_old'), now());
select ok(public.fn_session_after_mfa_reset(), 'an expired reset that was never claimed changed nothing: no cut-off');
select tests.clear_auth();
insert into public.mfa_resets (user_id, restaurant_id, requested_by, reason, created_at, expires_at, claimed_at)
select a_admin2, a, su, 'expired claimed', now() - interval '10 minutes', now() - interval '5 minutes', now() - interval '9 minutes' from _f;
select tests.c50((select a_admin2 from _f), tests.u50('sid_dawit_old'), now());
select ok(not public.fn_session_after_mfa_reset(), 'a claimed reset (the password may be rotated) keeps cutting the older sessions off after it expired');
select tests.c50((select a_admin2 from _f), tests.u50('sid_dawit_recent'), now());
select ok(public.fn_session_after_mfa_reset(), 'a session created after that request passes');
select tests.clear_auth();

-- ═════════ 9. TRUNCATE guard ═════════
select ok(exists (select 1 from pg_trigger where tgrelid = 'public.mfa_resets'::regclass and tgname = 'trg_00_no_truncate' and not tgisinternal),
          'mfa_resets carries the statement-level TRUNCATE guard');

-- ═════════ 10. completion order, abort, late factors; resend after a LATER-requested reset was abandoned ═════════
select tests.aal2((select su from _f));
select lives_ok(format($q$select public.fn_reactivate_tenant(%L, 'invoice paid')$q$, (select a from _f)), 'setup: central-cafe reactivated');
select tests.clear_auth();
select tests.add_verified_factor((select a_admin2 from _f)) where tests.n_factors((select a_admin2 from _f), 'verified') = 0;
select tests.aal2((select su from _f));
insert into _c select 'D1', public.fn_platform_prepare_mfa_reset((select a from _f), (select a_admin2 from _f), 'lost phone dawit');
insert into _c select 'D2', public.fn_platform_prepare_mfa_reset((select a from _f), (select a_admin2 from _f), 'lost phone dawit, later tab');
select tests.clear_auth();
-- owner: D1 requested 20 min ago (still valid); D2 requested LATER (10 min ago) and abandoned: expired, never claimed
update public.mfa_resets set created_at = now() - interval '20 minutes', expires_at = now() + interval '5 minutes' where id = tests.u50('D1');
update public.mfa_resets set created_at = now() - interval '10 minutes', expires_at = now() - interval '5 minutes' where id = tests.u50('D2');
select tests.authenticate_as_service_role();
select is(tests.run(format('select public.fn_platform_mfa_reset_abort(%L, ''rotate'')', tests.u50('D1'))), 'P0001|invalid_state|reset_not_claimed',
          'abort: an unclaimed row is refused');
select lives_ok(format('select public.fn_platform_claim_mfa_reset(%L)', tests.u50('D1')), 'setup: D1 claimed');
select is(tests.run(format('select public.fn_platform_complete_mfa_reset(%L)', tests.u50('D1'))), 'P0001|invalid_state|reset_not_signed_out',
          'complete: a claimed row whose sign-out step never ran is refused');
select is(tests.run(format('select public.fn_platform_mfa_reset_abort(%L, ''delete'')', tests.u50('D1'))), 'P0001|invalid_input|stage', 'abort: stage is rotate | sign_out');
select is(tests.run('select public.fn_platform_mfa_reset_abort(null, ''rotate'')'), 'P0001|invalid_input|reset_id', 'abort: reset id required');
select is(tests.run('select public.fn_platform_mfa_reset_abort(gen_random_uuid(), ''rotate'')'), 'P0001|not_found|', 'abort: unknown reset id');
select is(public.fn_platform_mfa_reset_abort(tests.u50('D1'), 'rotate'),
          jsonb_build_object('reset_id', tests.u50('D1'), 'profile_id', (select a_admin2 from _f), 'stage', 'rotate'), 'abort: {reset_id, profile_id, stage}');
select tests.aal2((select su from _f));
select is(tests.run(format('select public.fn_platform_mfa_reset_abort(%L, ''rotate'')', tests.u50('D1'))),
          '42501|permission denied for function fn_platform_mfa_reset_abort|', 'the super admin itself cannot call abort');
select tests.clear_auth();
select is((select platform_admin_id::text || '|' || restaurant_id::text || '|' || (detail ->> 'profile_id') || '|' || (detail ->> 'stage') || '|' || (detail ->> 'signed_out')
           from public.admin_audit_log where action = 'tenant_admin.mfa_reset_aborted' and detail ->> 'reset_id' = tests.u50('D1')::text),
          (select su::text || '|' || a::text || '|' || a_admin2::text from _f) || '|rotate|false', 'abort audited: actor = the requester, tenant, target, stage');
select ok((select claimed_at is not null and completed_at is null from public.mfa_resets where id = tests.u50('D1')),
          'the aborted row stays claimed (it keeps cutting the older sessions off) and is not completed');
-- (the database lets the claimed row go on; the Edge Function itself starts over after an abort)
select tests.authenticate_as_service_role();
select lives_ok(format('select public.fn_platform_mfa_reset_sign_out(%L)', tests.u50('D1')), 'setup: D1 signed out');
select tests.clear_auth();
delete from auth.mfa_factors where user_id = (select a_admin2 from _f);
select tests.authenticate_as_service_role();
select is(tests.run(format('select public.fn_platform_complete_mfa_reset(%L, -1)', tests.u50('D1'))), 'P0001|invalid_input|late_factors', 'late_factors >= 0');
select is(tests.run(format('select public.fn_platform_complete_mfa_reset(%L, 101)', tests.u50('D1'))), 'P0001|invalid_input|late_factors', 'late_factors <= 100');
select is(tests.run(format('select public.fn_platform_complete_mfa_reset(%L, null)', tests.u50('D1'))), 'P0001|invalid_input|late_factors', 'late_factors not null');
insert into _c select 'dD1', public.fn_platform_complete_mfa_reset(tests.u50('D1'), 2);
select tests.clear_auth();
select is((select (detail ->> 'late_factors') from public.admin_audit_log where action = 'tenant_admin.mfa_reset' and detail ->> 'reset_id' = tests.u50('D1')::text),
          '2', 'admin trail: late_factors (factors enrolled during the reset)');
select is((select (new_data ->> 'late_factors') from public.audit_logs where event = 'auth.mfa_reset_by_platform' and new_data ->> 'profile_id' = (select a_admin2::text from _f)),
          '2', 'tenant trail: late_factors');
select is((select (detail ->> 'late_factors') from public.admin_audit_log where action = 'tenant_admin.mfa_reset' and detail ->> 'reset_id' = tests.u50('r1')::text),
          '0', 'a completion without late factors records 0');
-- the scenario: D2 was requested AFTER D1 and BEFORE D1 completed, then abandoned (the latest reset by request time is not completed)
select ok((select d2.created_at > d1.created_at and d2.created_at < d1.completed_at and d2.completed_at is null and d2.claimed_at is null and d2.expires_at <= now()
           from public.mfa_resets d1, public.mfa_resets d2 where d1.id = tests.u50('D1') and d2.id = tests.u50('D2')),
          'fixture: the later-requested D2 is abandoned while the earlier D1 completed');
select ok(public.fn_mfa_recovery_resend_available((select a_admin2 from _f)), 'resend stays available: the abandoned later request does not lock the admin out');
select tests.aal2((select su from _f));
select is((select (e ->> 'recovery_resend_available')::boolean from jsonb_array_elements(public.fn_platform_get_tenant((select a from _f)) -> 'tenant_admins') e
           where e ->> 'profile_id' = (select a_admin2::text from _f)), true, 'detail: dawit can get the recovery e-mail again');
select lives_ok(format($q$select public.fn_platform_prepare_recovery_resend(%L, %L, 'link expired, dawit')$q$, (select a from _f), (select a_admin2 from _f)),
                'resend for dawit succeeds');
select tests.clear_auth();
-- the admin opened the recovery link (signed in after the completion) but never set a password / enrolled: resend must stay available
update auth.users set last_sign_in_at = (select completed_at + interval '1 second' from public.mfa_resets where id = tests.u50('D1')) where id = (select a_admin2 from _f);
select ok(public.fn_mfa_recovery_resend_available((select a_admin2 from _f)), 'signed in via the link but no factor yet: resend still available (no lockout)');
select tests.aal2((select su from _f));
select is((select (e ->> 'recovery_resend_available')::boolean from jsonb_array_elements(public.fn_platform_get_tenant((select a from _f)) -> 'tenant_admins') e
           where e ->> 'profile_id' = (select a_admin2::text from _f)), true, 'detail: resend still offered after a link sign-in without enrolment');
select lives_ok(format($q$select public.fn_platform_prepare_recovery_resend(%L, %L, 'link opened, password never set')$q$, (select a from _f), (select a_admin2 from _f)),
                'resend after a link sign-in succeeds');
select tests.clear_auth();
-- once a verified factor exists again, resend is gone (enrolment is the end of the recovery)
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
values (gen_random_uuid(), (select a_admin2 from _f), 'new phone', 'totp', 'verified', now(), now());
select ok(not public.fn_mfa_recovery_resend_available((select a_admin2 from _f)), 'a verified factor again: resend not available');
select * from finish();
rollback;
