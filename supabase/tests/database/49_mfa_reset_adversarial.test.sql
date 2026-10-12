-- Adversarial: migration 0036 (Super Admin MFA reset of a Tenant Admin + plan_features in the session context).
-- Complements 48_plan_features_mfa_reset (happy path, basic guards); nothing here repeats it. Attacks:
--   * public.mfa_resets: no privilege / no policy for anon, authenticated, service_role; owner cannot move a row to another tenant,
--     delete it or truncate it; not in the Realtime publication; its internal predicates are not callable by clients
--   * fn_platform_prepare_mfa_reset: staff, a tenant admin resetting itself, a Super Admin whose MFA is a trusted device (no TOTP),
--     forged / future / missing TOTP amr, a deactivated Super Admin, another platform admin as target (oracle), a foreign staff member
--     as target (oracle), a reason that is blank after trimming, suspended / cancelled tenants
--   * fn_platform_complete_mfa_reset: forged service_role claim on an authenticated connection, two concurrently prepared resets (the
--     first completion spends the other), replay, a target deactivated between prepare and complete (refusal returned + audited)
--   * the post-reset session rule: the pre-reset session BEFORE re-enrolment (step-up / aal2 gates), the pre-reset trusted device,
--     fn_trust_device from the old session after re-enrolment, an attestation obtained by the old session with a NEW device token,
--     borrowing another user's fresh session id, no session id at all; other users and platform admins unaffected
--   * plan_features: no write path to plans / subscriptions for a tenant, platform plan RPCs refused, forged JWT claims ignored
--   * audit integrity: rows not forgeable / editable / deletable (client, service_role, owner), reason in both trails, actor from the
--     reset row, no cross-tenant visibility, admin_audit_log invisible to tenant users
begin;
select plan(106);

create temp table _f on commit drop as
select tests.tenant_id('central-cafe') a, tests.tenant_id('second-cafe') b,
       '00000000-0000-4000-8000-0000000000c1'::uuid su, '00000000-0000-4000-8000-0000000000c9'::uuid su2,
       '00000000-0000-4000-8000-0000000000f1'::uuid su_factor,
       tests.user_id('selam', 'central-cafe') a_admin, tests.user_id('dawit', 'central-cafe') a_admin2,
       tests.user_id('yonas', 'central-cafe') a_waiter,
       tests.user_id('owner', 'second-cafe') b_admin, tests.user_id('waiter', 'second-cafe') b_waiter,
       (select id from public.plans where name = 'Growth') growth, (select id from public.plans where name = 'Starter') starter;
grant all on _f to public;
create temp table _c (k text primary key, v jsonb) on commit drop;
grant all on _c to public;

-- ── helpers (this file only) ──
-- the uuid stored under k (a bare uuid, or the reset_id / device_id of an RPC result)
create function tests.u49(p_k text) returns uuid language sql stable as $$
  select coalesce(v ->> 'reset_id', v ->> 'device_id', v #>> '{}')::uuid from _c where k = p_k $$;
-- an amr array: password + (optionally) a TOTP verification at p_totp_at
create function tests.amr49(p_totp_at timestamptz) returns jsonb language sql stable as $$
  select jsonb_build_array(jsonb_build_object('method', 'password', 'timestamp', extract(epoch from now())::bigint))
         || case when p_totp_at is null then '[]'::jsonb
                 else jsonb_build_array(jsonb_build_object('method', 'totp', 'timestamp', extract(epoch from p_totp_at)::bigint)) end $$;
-- JWT claims of one session (owner role kept: for calling internal predicates directly); null arguments = claim absent
create function tests.c49(p_user uuid, p_sid uuid, p_aal text, p_amr jsonb) returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', (jsonb_build_object('sub', p_user, 'role', 'authenticated', 'aud', 'authenticated')
    || case when p_aal is null then '{}'::jsonb else jsonb_build_object('aal', p_aal) end
    || case when p_sid is null then '{}'::jsonb else jsonb_build_object('session_id', p_sid) end
    || case when p_amr is null then '{}'::jsonb else jsonb_build_object('amr', p_amr) end)::text, true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
end $$;
-- the same session as a PostgREST client (role authenticated)
create function tests.c49c(p_user uuid, p_sid uuid, p_aal text, p_amr jsonb) returns void language plpgsql as $$
begin
  perform tests.c49(p_user, p_sid, p_aal, p_amr);
  execute 'set local role authenticated';
end $$;
-- run a statement and ALWAYS roll its effects back (for attacks that might succeed and destroy fixtures)
create function tests.dry49(p_sql text) returns text language plpgsql as $$
declare
  v text;
begin
  begin
    v := tests.run(p_sql);
    raise exception using errcode = 'XX49D', message = 'dry49';
  exception when sqlstate 'XX49D' then
    return v;
  end;
end $$;
-- the four DML verbs + TRUNCATE on mfa_resets as the CURRENT role
create function tests.mr49() returns text language plpgsql as $$
declare
  q text;
  acc text := '';
begin
  foreach q in array array[
    'select 1 from public.mfa_resets',
    $i$insert into public.mfa_resets (user_id, restaurant_id, requested_by, reason, expires_at)
       values ('00000000-0000-4000-8000-0000000000a1', (select id from public.restaurants limit 1), '00000000-0000-4000-8000-0000000000c1', 'forged', now() + interval '1 hour')$i$,
    'update public.mfa_resets set completed_at = null, expires_at = now() + interval ''1 day''',
    'delete from public.mfa_resets',
    'truncate public.mfa_resets'] loop
    acc := acc || tests.dry49(q) || ';';
  end loop;
  return acc;
end $$;
create function tests.hash49(p_token text) returns text language sql immutable as $$
  select encode(extensions.digest(convert_to(p_token, 'UTF8'), 'sha256'), 'hex') $$;
grant execute on all functions in schema tests to anon, authenticated, service_role;

-- ── fixtures (owner) ──
do $$ begin perform tests.create_auth_user('00000000-0000-4000-8000-0000000000c9', 'third.super@cafeos.example.com'); end $$;
insert into public.platform_admins (id, full_name, role, is_active) values ('00000000-0000-4000-8000-0000000000c9', 'Third Super', 'platform_super_admin', true);
select tests.add_verified_factor(u) from _f, unnest(array[a_admin, a_admin2, b_admin, su2]) u;
insert into _c select k, to_jsonb(gen_random_uuid()) from unnest(array['sid_a_old', 'sid_a2', 'sid_b', 'sid_su', 'sid_su_dev', 'sid_a_new', 'sid_b_new']) k;
-- sessions that exist BEFORE any reset (one hour old)
insert into auth.sessions (id, user_id, created_at, updated_at)
select tests.u49(x.k), x.u, now() - interval '1 hour', now()
from _f f, lateral (values ('sid_a_old', f.a_admin), ('sid_a2', f.a_admin2), ('sid_b', f.b_admin), ('sid_su', f.su), ('sid_su_dev', f.su)) x(k, u);
-- trusted devices with KNOWN raw tokens: selam (tenant), the second-cafe owner (tenant), the super admin (platform); each attested
-- on that user's pre-reset session
insert into public.trusted_devices (user_id, scope, factor_id, token_hash, expires_at)
select x.u, x.scope, (select id from auth.mfa_factors m where m.user_id = x.u and m.status = 'verified' order by m.created_at limit 1),
       tests.hash49(x.tok), now() + interval '20 days'
from _f f, lateral (values (f.a_admin, 'tenant', repeat('a', 64)), (f.b_admin, 'tenant', repeat('b', 64)), (f.su, 'platform', repeat('c', 64))) x(u, scope, tok);
insert into public.session_device_attestations (session_id, user_id, device_id, expires_at)
select tests.u49(x.k), d.user_id, d.id, now() + interval '1 day'
from (values ('sid_a_old', repeat('a', 64)), ('sid_b', repeat('b', 64)), ('sid_su_dev', repeat('c', 64))) x(k, tok)
join public.trusted_devices d on d.token_hash = tests.hash49(x.tok);

-- ═════════ 1. mfa_resets: no client surface at all ═════════
select ok((select c.relrowsecurity and c.relforcerowsecurity from pg_class c where c.oid = 'public.mfa_resets'::regclass), 'mfa_resets: RLS enabled and forced');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'mfa_resets'), 0, 'mfa_resets: no policy for any role');
select is((select string_agg(r || ':' || p, ',') from unnest(array['anon', 'authenticated', 'service_role']) r,
             unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
           where has_table_privilege(r, 'public.mfa_resets', p)), null, 'mfa_resets: no table privilege of any kind for anon / authenticated / service_role');
select is((select string_agg(r || ':' || f, ',') from unnest(array['anon', 'authenticated']) r,
             unnest(array['public.fn_session_after_mfa_reset()', 'public.fn_mfa_reset_pending(uuid)', 'public.fn_plan_normalize(jsonb)',
                          'public.fn_write_admin_audit(text,uuid,jsonb)', 'public.fn_write_audit(text,jsonb,uuid)',
                          'public.fn_platform_complete_mfa_reset(uuid,integer)', 'public.fn_platform_mfa_reset_abort(uuid,text)']) f
           where has_function_privilege(r, f, 'EXECUTE')), null,
          'internal predicates / audit writers / the service step: not executable by anon or authenticated (no reset-state oracle, no forged audit)');
select ok(not exists (select 1 from pg_publication_tables where tablename = 'mfa_resets'), 'mfa_resets is not streamed by any publication (Realtime)');

select tests.c49c((select su from _f), tests.u49('sid_su'), 'aal2', tests.amr49(now()));
insert into _c select 'r_sel1', public.fn_platform_prepare_mfa_reset((select a from _f), (select a_admin from _f), 'lost phone A');
insert into _c select 'r_sel2', public.fn_platform_prepare_mfa_reset((select a from _f), (select a_admin from _f), 'lost phone A, second tab');
select is(tests.mr49(), repeat('42501|permission denied for table mfa_resets|;', 5), 'the Super Admin itself (aal2, fresh TOTP): select / insert / update / delete / truncate all refused');
select tests.c49c((select a_admin from _f), tests.u49('sid_a_old'), 'aal2', tests.amr49(now()));
select is(tests.mr49(), repeat('42501|permission denied for table mfa_resets|;', 5), 'the targeted tenant admin: every verb refused');
select tests.c49c((select b_admin from _f), tests.u49('sid_b'), 'aal2', tests.amr49(now()));
select is(tests.mr49(), repeat('42501|permission denied for table mfa_resets|;', 5), 'another tenant''s admin: every verb refused');
select tests.as_anon();
select is(tests.mr49(), repeat('42501|permission denied for table mfa_resets|;', 5), 'anon: every verb refused');
select tests.authenticate_as_service_role();
select is(tests.mr49(), repeat('42501|permission denied for table mfa_resets|;', 5), 'service_role: every verb refused (only the definer functions touch the table)');
select tests.clear_auth();
select is(tests.dry49(format('update public.mfa_resets set restaurant_id = %L where id = %L', (select b from _f), tests.u49('r_sel1'))),
          'P0001|tenant_change_forbidden|mfa_resets', 'owner: a reset row cannot be moved to another tenant');
select is(tests.dry49(format('delete from public.mfa_resets where id = %L', tests.u49('r_sel1'))), 'P0001|immutable_record|mfa_resets', 'owner: a reset row cannot be deleted');
-- the post-reset session rule reads mfa_resets: wiping it would re-open every session that survived a reset
select matches(tests.dry49('truncate public.mfa_resets'), '^P0001\|immutable_record\|', 'owner: TRUNCATE cannot wipe the reset rows either');

-- ═════════ 2. prepare: who may call it ═════════
select tests.c49c((select a_waiter from _f), gen_random_uuid(), null, null);
select is(tests.run(format($q$select public.fn_platform_prepare_mfa_reset(%L, %L, 'lost phone')$q$, (select a from _f), (select a_admin from _f))),
          'P0001|permission_denied|', 'a staff member is refused');
select tests.c49c((select b_admin from _f), tests.u49('sid_b'), 'aal2', tests.amr49(now()));
select is(tests.run(format($q$select public.fn_platform_prepare_mfa_reset(%L, %L, 'my own phone')$q$, (select b from _f), (select b_admin from _f))),
          'P0001|permission_denied|', 'a tenant admin cannot reset its OWN authenticator through the platform path');
-- a Super Admin whose MFA comes from a trusted device (aal1 + attestation): the platform gate passes, the TOTP step-up does not
select tests.c49((select su from _f), tests.u49('sid_su_dev'), 'aal1', tests.amr49(null));
select ok(public.fn_mfa_session_ok(), 'control: the super admin''s device-attested aal1 session satisfies the platform MFA gate');
select tests.c49c((select su from _f), tests.u49('sid_su_dev'), 'aal1', tests.amr49(null));
select is(tests.run(format($q$select public.fn_platform_prepare_mfa_reset(%L, %L, 'lost phone')$q$, (select a from _f), (select a_admin from _f))),
          'P0001|step_up_required|', 'super admin on a trusted device without a real TOTP: step_up_required');
select tests.c49c((select su from _f), tests.u49('sid_su'), 'aal2', tests.amr49(now() + interval '1 hour'));
select is(tests.run(format($q$select public.fn_platform_prepare_mfa_reset(%L, %L, 'lost phone')$q$, (select a from _f), (select a_admin from _f))),
          'P0001|step_up_required|', 'a TOTP amr stamped in the future does not count');
select tests.c49c((select su from _f), tests.u49('sid_su'), 'aal2', tests.amr49(null));
select is(tests.run(format($q$select public.fn_platform_prepare_mfa_reset(%L, %L, 'lost phone')$q$, (select a from _f), (select a_admin from _f))),
          'P0001|step_up_required|', 'aal2 whose amr holds no TOTP entry: step_up_required');
select tests.c49c((select su from _f), tests.u49('sid_su'), 'aal2', jsonb_build_object('method', 'totp', 'timestamp', extract(epoch from now())::bigint));
select is(tests.run(format($q$select public.fn_platform_prepare_mfa_reset(%L, %L, 'lost phone')$q$, (select a from _f), (select a_admin from _f))),
          'P0001|step_up_required|', 'an amr that is an object instead of an array does not count');
select tests.c49c((select su from _f), tests.u49('sid_su'), 'aal2', jsonb_build_array(jsonb_build_object('method', 'totp', 'timestamp', 'now')));
select is(tests.run(format($q$select public.fn_platform_prepare_mfa_reset(%L, %L, 'lost phone')$q$, (select a from _f), (select a_admin from _f))),
          'P0001|step_up_required|', 'a non-numeric TOTP timestamp does not count');
select tests.clear_auth();
update public.platform_admins set is_active = false where id = (select su2 from _f);
select tests.aal2((select su2 from _f));
select is(tests.run(format($q$select public.fn_platform_prepare_mfa_reset(%L, %L, 'lost phone')$q$, (select a from _f), (select a_admin from _f))),
          'P0001|permission_denied|', 'a deactivated Super Admin (aal2, fresh TOTP, verified factor) is refused');

-- ═════════ 2b. prepare: targets ═════════
select tests.c49c((select su from _f), tests.u49('sid_su'), 'aal2', tests.amr49(now()));
select is(tests.oracle(format($q$select public.fn_platform_prepare_mfa_reset(%L, {id}, 'lost phone')$q$, (select a from _f)), (select su2 from _f)),
          'P0001|not_found|', 'another platform admin as target: not_found, same as an unknown id');
select is(tests.oracle(format($q$select public.fn_platform_prepare_mfa_reset(%L, {id}, 'lost phone')$q$, (select b from _f)), (select b_waiter from _f)),
          'P0001|not_found|', 'a staff member of the right tenant as target: not_found, same as an unknown id');
select is(tests.run(format($q$select public.fn_platform_prepare_mfa_reset(%L, %L, '  ab  ')$q$, (select a from _f), (select a_admin from _f))),
          'P0001|invalid_input|reason', 'a reason that is too short once trimmed is refused');
select tests.clear_auth();
select is((select count(*)::int from public.mfa_resets), 2, 'no refused call left a reset row (only the two real requests exist)');

-- ═════════ 3. complete: only the service role, and every reset row is single-use ═════════
-- an authenticated connection that forges role=service_role in its claims is still the authenticated DB role
select tests.authenticate_as((select a_admin from _f));
do $$ begin
  perform set_config('request.jwt.claims', json_build_object('sub', (select a_admin from _f), 'role', 'service_role')::text, true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
end $$;
select is(tests.run(format($q$select public.fn_platform_complete_mfa_reset(%L)$q$, tests.u49('r_sel1'))),
          '42501|permission denied for function fn_platform_complete_mfa_reset|', 'a forged service_role claim on an authenticated connection: EXECUTE denied');
-- the Edge Function claims r_sel1 (before the rotation) and runs the sign-out step (after it)
select tests.authenticate_as_service_role();
select lives_ok(format('select public.fn_platform_claim_mfa_reset(%L)', tests.u49('r_sel1')), 'setup: r_sel1 claimed');
select lives_ok(format('select public.fn_platform_mfa_reset_sign_out(%L)', tests.u49('r_sel1')), 'setup: r_sel1 signed out');
select tests.clear_auth();
-- GoTrue deletes selam's factors (the Edge Function's step 6)
delete from auth.mfa_factors where user_id = (select a_admin from _f);
select tests.authenticate_as_service_role();
insert into _c select 'done_sel1', public.fn_platform_complete_mfa_reset(tests.u49('r_sel1'));
select is((select v -> 'devices_revoked' from _c where k = 'done_sel1'), '1'::jsonb, 'the first of two concurrently prepared resets completes');
select is(tests.run(format($q$select public.fn_platform_complete_mfa_reset(%L)$q$, tests.u49('r_sel2'))),
          'P0001|invalid_state|reset_superseded', 'the other one (prepared at the same instant) is spent: reset_superseded');
select is(tests.run(format($q$select public.fn_platform_complete_mfa_reset(%L)$q$, tests.u49('r_sel1'))),
          'P0001|invalid_state|reset_completed', 'replay of the completed one: reset_completed');
select tests.clear_auth();
select is((select count(*)::int from public.mfa_resets where user_id = (select a_admin from _f) and completed_at is not null), 1, 'exactly one reset of selam is completed');
select is((select count(*)::int from public.audit_logs where event = 'auth.mfa_reset_by_platform' and restaurant_id = (select a from _f)), 1,
          'exactly one tenant audit row for the reset (no double completion)');

-- ═════════ 4. other users and platform admins are unaffected ═════════
select is((select count(*)::int from auth.sessions where user_id = (select a_admin from _f)), 0, 'selam: every auth session deleted');
select is((select string_agg(x.k, ',' order by x.k) from (values ('sid_a2'), ('sid_b'), ('sid_su'), ('sid_su_dev')) x(k)
           where exists (select 1 from auth.sessions s where s.id = tests.u49(x.k))), 'sid_a2,sid_b,sid_su,sid_su_dev',
          'the other tenant admin, the other tenant''s admin and the super admin keep every session');
select is((select count(*)::int from public.trusted_devices where revoked_at is null and user_id in (select b_admin from _f union all select su from _f)), 2,
          'the other users'' trusted devices stay live');
select is((select count(*)::int from public.session_device_attestations where session_id in (tests.u49('sid_b'), tests.u49('sid_su_dev'))), 2,
          'the other users'' session attestations stay');
select tests.c49((select b_admin from _f), tests.u49('sid_b'), 'aal1', tests.amr49(null));
select ok(public.fn_mfa_session_ok(), 'the other tenant''s admin still passes the MFA gate with its attested pre-existing session');
select tests.c49((select su from _f), tests.u49('sid_su'), 'aal2', tests.amr49(now()));
select ok(public.fn_session_after_mfa_reset() and public.fn_mfa_session_ok(), 'the requesting super admin''s pre-existing session is unaffected');
select tests.c49c((select su from _f), tests.u49('sid_su'), 'aal2', tests.amr49(now()));
select is(tests.run(format('select public.fn_platform_get_tenant(%L)', (select a from _f))), 'ok:1', 'the super admin keeps passing fn_platform_guard');
select is((public.fn_get_session_context() ->> 'platform_mfa'), 'true', 'and its session context reports platform MFA satisfied');

-- ═════════ 5. the pre-reset session, BEFORE the user enrolled a new authenticator ═════════
-- the access token of the old session stays valid until it expires (the DB deleted the auth.sessions row; hosted: the row survives)
select tests.c49((select a_admin from _f), tests.u49('sid_a_old'), 'aal2', tests.amr49(now() - interval '1 hour'));
select ok(not public.fn_mfa_session_ok(), 'old session: fn_mfa_session_ok is false');
select ok(not public.fn_device_trust_satisfied(), 'old session: its pre-reset device attestation is gone');
select is(tests.run('select public.fn_require_aal2()'), 'P0001|mfa_required|', 'old session: fn_require_aal2 refuses');
select is(tests.run('select public.fn_require_step_up()'), 'P0001|mfa_required|',
          'old session: fn_require_step_up refuses (a session that survived a reset never reaches an MFA-gated action)');
select tests.c49c((select a_admin from _f), tests.u49('sid_a_old'), 'aal2', tests.amr49(now() - interval '1 hour'));
select is(tests.run(format('select public.fn_prepare_pin_reset(%L)', (select a_waiter from _f))), 'P0001|mfa_required|',
          'old session: a step-up-gated tenant command (staff PIN reset) is refused');
select is(tests.run(format('select public.fn_set_user_active(%L, false)', (select a_admin2 from _f))), 'P0001|mfa_required|',
          'old session: cannot deactivate the other tenant admin');
select tests.clear_auth();
do $$ begin perform set_config('app.tenant_admin_mfa_required', 'on', true); end $$;
select tests.c49((select a_admin from _f), tests.u49('sid_a_old'), 'aal2', tests.amr49(now() - interval '1 hour'));
select is(tests.run('select public.fn_require_step_up()'), 'P0001|mfa_required|', 'control: with app.tenant_admin_mfa_required = on the old session is refused');
select tests.clear_auth();
do $$ begin perform set_config('app.tenant_admin_mfa_required', 'off', true); end $$;

-- ═════════ 6. trusted devices across the reset ═════════
-- the recovery sign-in: a session created AFTER completed_at
insert into auth.sessions (id, user_id, created_at, updated_at)
select tests.u49('sid_a_new'), a_admin, clock_timestamp() + interval '1 second', now() from _f;
select tests.c49c((select a_admin from _f), tests.u49('sid_a_new'), 'aal1', tests.amr49(null));
select is(public.fn_check_trusted_device(repeat('a', 64)), '{"trusted": false}'::jsonb, 'the pre-reset trusted device token is dead, even on the fresh session');
select tests.c49((select a_admin from _f), tests.u49('sid_a_new'), 'aal1', tests.amr49(null));
select ok(not public.fn_mfa_session_ok(), 'and the fresh session gains nothing from it');
-- the attacker on the hosted surviving old session enrols a NEW authenticator: the old session row still exists there
select tests.clear_auth();
insert into auth.sessions (id, user_id, created_at, updated_at) select tests.u49('sid_a_old'), a_admin, now() - interval '1 hour', now() from _f;
select tests.add_verified_factor((select a_admin from _f));
select tests.c49c((select a_admin from _f), tests.u49('sid_a_old'), 'aal2', tests.amr49(now()));
select is(tests.run($q$select public.fn_trust_device('attacker laptop')$q$), 'P0001|step_up_required|',
          'old session + new factor + fresh TOTP: fn_trust_device refuses (no new trusted device from a pre-reset session)');
select tests.clear_auth();
select is((select count(*)::int from public.trusted_devices where user_id = (select a_admin from _f) and revoked_at is null), 0, 'no device was created');
-- the legitimate user trusts the device on the fresh session
select tests.c49c((select a_admin from _f), tests.u49('sid_a_new'), 'aal2', tests.amr49(now()));
insert into _c select 'dev_new', public.fn_trust_device('my new phone');
select ok((select v ? 'token' from _c where k = 'dev_new'), 'the fresh post-reset session can trust a device');
select tests.c49((select a_admin from _f), tests.u49('sid_a_new'), 'aal1', tests.amr49(null));
select ok(public.fn_mfa_session_ok(), 'control: the fresh session is MFA-satisfied through the new device');
-- the old session presents the NEW device token (e.g. copied from the victim's browser): an attestation is no bypass
select tests.c49c((select a_admin from _f), tests.u49('sid_a_old'), 'aal1', tests.amr49(null));
select lives_ok(format('select public.fn_check_trusted_device(%L)', (select v ->> 'token' from _c where k = 'dev_new')), 'old session presents the new device token');
select tests.c49((select a_admin from _f), tests.u49('sid_a_old'), 'aal1', tests.amr49(null));
select ok(not public.fn_mfa_session_ok(), 'old session + attestation of the NEW device: still not MFA-satisfied');
select is(tests.run('select public.fn_require_aal2()'), 'P0001|mfa_required|', 'old session + new device attestation: fn_require_aal2 refuses');
select is(tests.run('select public.fn_require_step_up()'), 'P0001|mfa_required|', 'old session + new device attestation: fn_require_step_up refuses');
-- borrowing: selam's token carrying the id of ANOTHER user's fresh session
select tests.clear_auth();
insert into auth.sessions (id, user_id, created_at, updated_at) select tests.u49('sid_b_new'), b_admin, clock_timestamp() + interval '1 second', now() from _f;
select tests.c49((select a_admin from _f), tests.u49('sid_b_new'), 'aal2', tests.amr49(now()));
select ok(not public.fn_mfa_session_ok(), 'a session id of another user (created after the reset) does not count');
select tests.c49((select a_admin from _f), null, 'aal2', tests.amr49(now()));
select ok(not public.fn_mfa_session_ok(), 'no session_id claim at all: not ok');
select is(tests.run('select public.fn_require_recent_totp()'), 'P0001|step_up_required|', 'no session_id claim: the recent-TOTP gate refuses too');
select tests.c49((select a_admin from _f), tests.u49('sid_a_new'), 'aal2', tests.amr49(now()));
select lives_ok('select public.fn_require_recent_totp()', 'control: the fresh session passes the recent-TOTP gate');

-- ═════════ 7. complete: target deactivated between prepare and complete ═════════
-- independent of section 5: if the old session managed to deactivate dawit there, he is active again here
update public.profiles set is_active = true where id = (select a_admin2 from _f) and not is_active;
select tests.c49c((select su from _f), tests.u49('sid_su'), 'aal2', tests.amr49(now()));
insert into _c select 'r_dawit', public.fn_platform_prepare_mfa_reset((select a from _f), (select a_admin2 from _f), 'lost phone dawit');
select tests.authenticate_as_service_role();
select lives_ok(format('select public.fn_platform_claim_mfa_reset(%L)', tests.u49('r_dawit')), 'setup: r_dawit claimed');
select lives_ok(format('select public.fn_platform_mfa_reset_sign_out(%L)', tests.u49('r_dawit')), 'setup: r_dawit signed out');
select tests.clear_auth();
-- a session that appeared after the sign-out step (e.g. a refresh): the refused completion must not touch it
insert into auth.sessions (id, user_id, created_at, updated_at) select gen_random_uuid(), a_admin2, now(), now() from _f;
insert into _c select 'n_sess_a2', to_jsonb((select count(*) from auth.sessions where user_id = (select a_admin2 from _f)));
select is((select (v #>> '{}')::int from _c where k = 'n_sess_a2'), 1, 'control: dawit holds a session at completion time');
delete from auth.mfa_factors where user_id = (select a_admin2 from _f);
update public.profiles set is_active = false where id = (select a_admin2 from _f);
select tests.authenticate_as_service_role();
select is(public.fn_platform_complete_mfa_reset(tests.u49('r_dawit')), jsonb_build_object('profile_id', (select a_admin2 from _f), 'refused', 'not_found'),
          'target deactivated after prepare (factors already gone): refusal returned, not raised');
select tests.clear_auth();
select ok((select completed_at is null from public.mfa_resets where id = tests.u49('r_dawit')), 'the refused reset is not completed');
select is((select count(*)::int from auth.sessions where user_id = (select a_admin2 from _f)), (select (v #>> '{}')::int from _c where k = 'n_sess_a2'),
          'the refused completion deleted no session');
select is((select platform_admin_id::text || '|' || restaurant_id::text || '|' || (detail ->> 'refused') from public.admin_audit_log
           where action = 'tenant_admin.mfa_reset_incomplete' and detail ->> 'reset_id' = tests.u49('r_dawit')::text),
          (select su::text || '|' || a::text from _f) || '|not_found', 'the incomplete reset is audited with the requester as actor');
select is((select count(*)::int from public.audit_logs where event = 'auth.mfa_reset_by_platform' and new_data ->> 'profile_id' = (select a_admin2::text from _f)), 0,
          'no completed-reset row in the tenant audit for the refused one');

-- ═════════ 8. plan_features: a tenant has no write path ═════════
select tests.c49c((select b_admin from _f), tests.u49('sid_b'), 'aal2', tests.amr49(now()));
select is(tests.run($q$insert into public.plans (name, price_etb_monthly, features) values ('Mine', 0, '{"installments": true}')$q$),
          '42501|permission denied for table plans|', 'tenant admin: cannot insert a plan');
select is(tests.run($q$update public.plans set features = features || '{"installments": true}'$q$),
          '42501|permission denied for table plans|', 'tenant admin: cannot update plan features');
select is(tests.run(format('update public.subscriptions set plan_id = %L', (select growth from _f))),
          '42501|permission denied for table subscriptions|', 'tenant admin: cannot point its subscription at another plan');
select is(tests.run(format($q$insert into public.subscriptions (restaurant_id, plan_id, status, current_period_end) values (%L, %L, 'active', now() + interval '1 year')$q$, (select b from _f), (select growth from _f))),
          '42501|permission denied for table subscriptions|', 'tenant admin: cannot insert a subscription');
select is(tests.run('delete from public.subscriptions'), '42501|permission denied for table subscriptions|', 'tenant admin: cannot delete its subscription');
select is(tests.run(format($q$select public.fn_platform_change_plan(%L, %L, 'upgrade me')$q$, (select b from _f), (select growth from _f))),
          'P0001|permission_denied|', 'tenant admin: fn_platform_change_plan refused');
select is(tests.run(format($q$select public.fn_platform_update_plan(%L, '{"features": {"installments": true}}')$q$, (select starter from _f))),
          'P0001|permission_denied|', 'tenant admin: fn_platform_update_plan refused');
select is(tests.run($q$select public.fn_platform_create_plan('{"name": "Free Credit", "price_etb_monthly": 0, "features": {"installments": true}}')$q$),
          'P0001|permission_denied|', 'tenant admin: fn_platform_create_plan refused');
-- forged claims: another tenant id and a plan_features object in the JWT are ignored
select is(length(set_config('request.jwt.claims', (jsonb_build_object('sub', (select b_admin from _f), 'role', 'authenticated', 'aud', 'authenticated', 'aal', 'aal2',
                  'session_id', tests.u49('sid_b'), 'restaurant_id', (select a from _f), 'plan_features', '{"installments": true}'::jsonb,
                  'app_metadata', jsonb_build_object('restaurant_id', (select a from _f), 'plan_features', '{"installments": true}'::jsonb)))::text, true)) > 0,
          true, 'setup: forged claims (another tenant id, plan_features, app_metadata) installed');
select is(public.fn_get_session_context() -> 'plan_features', (select features from public.plans where id = (select starter from _f)),
          'forged JWT claims: plan_features is still the tenant''s own (Starter) plan');
select is(public.fn_get_session_context() #>> '{restaurant,id}', (select b::text from _f), 'and the tenant still comes from the profile');
select tests.clear_auth();
select is((select plan_id from public.subscriptions where restaurant_id = (select b from _f)), (select starter from _f), 'second-cafe is still on Starter');
select is((select features -> 'installments' from public.plans where id = (select starter from _f)), 'false'::jsonb, 'Starter still excludes installments');

-- ═════════ 9. audit integrity ═════════
select is((select (detail ->> 'reason') || '|' || (detail ->> 'reset_id') from public.admin_audit_log where action = 'tenant_admin.mfa_reset'
             and detail ->> 'profile_id' = (select a_admin::text from _f)),
          'lost phone A|' || tests.u49('r_sel1')::text, 'admin trail: the reason and the reset id of the row that completed');
select is((select actor_id::text || '|' || actor_type || '|' || (new_data ->> 'reason') from public.audit_logs
           where event = 'auth.mfa_reset_by_platform' and restaurant_id = (select a from _f)),
          (select su::text from _f) || '|platform_admin|lost phone A', 'tenant trail: the requesting super admin (from the row, not the service caller) and the reason');
select is((select count(*)::int from public.admin_audit_log where action = 'tenant_admin.mfa_reset_requested' and detail ->> 'reason' is not null
             and detail ->> 'reset_id' in (tests.u49('r_sel1')::text, tests.u49('r_sel2')::text, tests.u49('r_dawit')::text)), 3,
          'every request carries its reason in the admin trail');
-- visibility
select tests.c49c((select a_admin from _f), tests.u49('sid_a_new'), 'aal2', tests.amr49(now()));
select is((select count(*)::int from public.audit_logs where event = 'auth.mfa_reset_by_platform'), 1, 'central''s admin sees its own tenant''s reset row');
select is((select count(*)::int from public.admin_audit_log), 0, 'a tenant admin sees no admin_audit_log row (not even about itself)');
select tests.c49c((select b_admin from _f), tests.u49('sid_b'), 'aal2', tests.amr49(now()));
select is((select count(*)::int from public.audit_logs where event = 'auth.mfa_reset_by_platform' or restaurant_id = (select a from _f)), 0,
          'another tenant''s admin sees no row of central''s audit, reset rows included');
select tests.c49c((select a_waiter from _f), gen_random_uuid(), null, null);
select is((select count(*)::int from public.audit_logs where event = 'auth.mfa_reset_by_platform'), 0, 'a staff member without audit.view sees no reset row');
-- forging / editing from a client
select tests.c49c((select a_admin from _f), tests.u49('sid_a_new'), 'aal2', tests.amr49(now()));
select is(tests.run(format($q$insert into public.audit_logs (restaurant_id, actor_id, actor_type, event, action, new_data)
                              values (%L, %L, 'platform_admin', 'auth.mfa_reset_by_platform', 'event', '{"reason": "forged"}')$q$, (select a from _f), (select su from _f))),
          '42501|permission denied for table audit_logs|', 'tenant admin cannot forge a platform reset row in its own audit');
select is(tests.run($q$update public.audit_logs set new_data = '{}' where event = 'auth.mfa_reset_by_platform'$q$),
          '42501|permission denied for table audit_logs|', 'tenant admin cannot edit the reset row');
select is(tests.run($q$delete from public.audit_logs where event = 'auth.mfa_reset_by_platform'$q$),
          '42501|permission denied for table audit_logs|', 'tenant admin cannot delete the reset row');
select is(tests.run(format($q$insert into public.admin_audit_log (platform_admin_id, restaurant_id, action, detail) values (%L, %L, 'tenant_admin.mfa_reset', '{}')$q$, (select su from _f), (select a from _f))),
          '42501|permission denied for table admin_audit_log|', 'tenant admin cannot forge an admin_audit_log row');
select tests.c49c((select su from _f), tests.u49('sid_su'), 'aal2', tests.amr49(now()));
select is(tests.run($q$update public.admin_audit_log set detail = detail - 'reason' where action like 'tenant_admin.mfa_reset%'$q$),
          '42501|permission denied for table admin_audit_log|', 'the super admin cannot edit the reset rows of the admin trail');
select is(tests.run(format($q$insert into public.admin_audit_log (platform_admin_id, restaurant_id, action, detail) values (%L, %L, 'tenant_admin.mfa_reset', '{}')$q$, (select su2 from _f), (select a from _f))),
          '42501|permission denied for table admin_audit_log|', 'the super admin cannot insert a reset row attributed to someone else');
select tests.authenticate_as_service_role();
select matches(tests.run(format($q$insert into public.admin_audit_log (platform_admin_id, restaurant_id, action, detail) values (%L, %L, 'tenant_admin.mfa_reset', '{}')$q$, (select su2 from _f), (select a from _f))),
          '^42501\|permission denied for table admin_audit_log\|', 'service_role cannot insert a forged admin trail row directly');
select tests.clear_auth();
select is(tests.dry49($q$update public.audit_logs set new_data = new_data - 'reason' where event = 'auth.mfa_reset_by_platform'$q$),
          'P0001|immutable_record|audit_logs', 'owner cannot edit the tenant reset row');
select is(tests.dry49($q$delete from public.admin_audit_log where action like 'tenant_admin.mfa_reset%'$q$),
          'P0001|immutable_record|admin_audit_log', 'owner cannot delete the admin reset rows');

-- ═════════ 10. tenants that are suspended / cancelled ═════════
-- a tenant admin of a suspended or cancelled tenant gets no credential reset (as for Tenant Admin invitations: tenant_suspended)
select tests.c49c((select su from _f), tests.u49('sid_su'), 'aal2', tests.amr49(now()));
select lives_ok(format($q$select public.fn_suspend_tenant(%L, 'non-payment of the invoice')$q$, (select b from _f)), 'setup: second-cafe suspended');
select matches(tests.run(format($q$select public.fn_platform_prepare_mfa_reset(%L, %L, 'lost phone B')$q$, (select b from _f), (select b_admin from _f))),
          '^P0001\|(tenant_suspended|invalid_state)\|', 'suspended tenant: its admin''s MFA cannot be reset');
select lives_ok(format($q$select public.fn_reactivate_tenant(%L, 'invoice paid')$q$, (select b from _f)), 'setup: second-cafe reactivated');
select lives_ok(format($q$select public.fn_platform_cancel_tenant(%L, 'closing down', 'second-cafe')$q$, (select b from _f)), 'setup: second-cafe cancelled');
select matches(tests.run(format($q$select public.fn_platform_prepare_mfa_reset(%L, %L, 'lost phone B')$q$, (select b from _f), (select b_admin from _f))),
          '^P0001\|(tenant_suspended|invalid_state)\|', 'cancelled tenant: its admin''s MFA cannot be reset');
select tests.clear_auth();
select is((select count(*)::int from public.mfa_resets where restaurant_id = (select b from _f)), 0, 'no reset row was created for second-cafe');

select * from finish();
rollback;
