-- Maker-checker for a forced PIN change (migration 0024): state machine (required -> pending_approval -> approved | rejected),
-- the single restriction predicate, approve/reject/list RPCs (tenant from identity, users.manage, step-up, tenant status
-- past_due / suspended, no oracle, never the subject), service-only completion, notifications, audit rows free of secrets,
-- session-context fields.
begin;
select plan(207);

create temp table _f on commit drop as
select tests.tenant_id('central-cafe') a, tests.tenant_id('second-cafe') b,
       tests.user_id('selam', 'central-cafe') admin, tests.user_id('dawit', 'central-cafe') admin2,
       tests.user_id('yonas', 'central-cafe') waiter, tests.user_id('meron', 'central-cafe') deleg,
       tests.user_id('abebe', 'central-cafe') kitchen, tests.user_id('hanna', 'central-cafe') cashier,
       tests.user_id('sara', 'central-cafe') pastry,
       tests.user_id('owner', 'second-cafe') b_admin, tests.user_id('waiter', 'second-cafe') b_waiter,
       '00000000-0000-4000-8000-0000000000c1'::uuid platform;
grant all on _f to public;
grant execute on all functions in schema tests to public;
create temp table _n (k text primary key, v text);
grant all on _n to public;
-- tests.aal2(user) (00_helpers): an authenticated session that satisfied MFA, as GoTrue issues after a TOTP challenge = the aal2 claim AND
-- the verified factor behind it (fn_require_aal2 needs both, 0028). tests.aal2_token(user) is the claim alone (a token that outlives its factor).
create function tests.n_admin_notes(p_kind text, p_subject uuid) returns int language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.user_notifications n where n.kind = p_kind and n.payload ->> 'profile_id' = p_subject::text and n.recipient_id <> p_subject $$;
create function tests.n_notes(p_kind text, p_recipient uuid) returns int language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.user_notifications n where n.kind = p_kind and n.recipient_id = p_recipient $$;
grant execute on function tests.n_admin_notes(text, uuid), tests.n_notes(text, uuid) to public;

-- ═════════ structure and privileges ═════════
select has_column('public', 'profile_secrets', 'pin_change_pending', 'profile_secrets.pin_change_pending exists');
select has_column('public', 'profile_secrets', 'pin_change_requested_at', 'profile_secrets.pin_change_requested_at exists');
select is((select is_nullable from information_schema.columns where table_name = 'profile_secrets' and column_name = 'pin_change_pending'), 'NO', 'pin_change_pending is not null');
select is((select column_default from information_schema.columns where table_name = 'profile_secrets' and column_name = 'pin_change_pending'), 'false', 'and defaults to false');
select ok(not has_table_privilege('authenticated', 'public.profile_secrets', 'select,insert,update,delete')
      and not has_any_column_privilege('authenticated', 'public.profile_secrets', 'select,insert,update')
      and not has_any_column_privilege('anon', 'public.profile_secrets', 'select,insert,update'), 'profile_secrets stays closed to clients (new columns included)');
select ok(not exists (select 1 from pg_policies where tablename = 'profile_secrets'), 'and has no policy');
select is(tests.run(format($q$update public.profile_secrets set must_change_pin = true, pin_change_pending = true where profile_id = %L$q$, (select waiter from _f)))::text ~ '^23514\|', true, 'CHECK: must_change_pin and pin_change_pending can never both be true');
select ok(not has_function_privilege('authenticated', 'public.fn_complete_forced_pin_change(uuid,text,integer)', 'execute')
      and not has_function_privilege('anon', 'public.fn_complete_forced_pin_change(uuid,text,integer)', 'execute'), 'fn_complete_forced_pin_change: no client EXECUTE');
select ok(has_function_privilege('service_role', 'public.fn_complete_forced_pin_change(uuid,text,integer)', 'execute'), 'service_role may execute it');
select ok(not has_function_privilege('authenticated', 'public.fn_pin_restricted(uuid)', 'execute')
      and not has_function_privilege('anon', 'public.fn_pin_restricted(uuid)', 'execute'), 'fn_pin_restricted: internal');
select ok(not has_function_privilege('authenticated', 'public.fn_decide_pin_change(uuid,boolean)', 'execute')
      and not has_function_privilege('anon', 'public.fn_decide_pin_change(uuid,boolean)', 'execute'), 'fn_decide_pin_change: internal (only the two wrappers are public)');
select ok(not has_function_privilege('authenticated', 'public.fn_require_aal2()', 'execute')
      and not has_function_privilege('anon', 'public.fn_require_aal2()', 'execute'), 'fn_require_aal2: internal (no client EXECUTE), like fn_require_step_up');
select ok((select p.prosecdef and p.proconfig @> array['search_path=""'] from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'fn_require_aal2'), 'fn_require_aal2: security definer with an empty search_path');
select ok((select prosrc ~ 'fn_require_aal2' and prosrc !~ 'fn_require_step_up' from pg_proc where proname = 'fn_decide_pin_change' and pronamespace = 'public'::regnamespace), 'fn_decide_pin_change requires aal2 (not the factor-dependent step-up)');
select is((select provolatile::text from pg_proc where proname = 'fn_require_aal2' and pronamespace = 'public'::regnamespace), 's', 'fn_require_aal2: STABLE');
select ok(not has_function_privilege('public', 'public.fn_require_aal2()', 'execute') and not has_function_privilege('service_role', 'public.fn_require_aal2()', 'execute')
      and (select proacl::text from pg_proc where proname = 'fn_require_aal2' and pronamespace = 'public'::regnamespace)
          = (select proacl::text from pg_proc where proname = 'fn_require_step_up' and pronamespace = 'public'::regnamespace), 'fn_require_aal2: same ACL as fn_require_step_up (owner only: no PUBLIC, no service_role)');

-- ═════════ fn_require_aal2 itself: each of its three conditions is necessary ═════════
-- (1) the token says aal2, (2) the caller's own profile exists and is not a PIN account (0027), (3) the caller still owns a VERIFIED
-- factor (0028, finding L1). The helper is internal: it is called directly, as the owner role, with the claims a real session would carry.
-- Start without any factor row (the seed has none, a developer database might; rolled back with the file).
delete from auth.mfa_factors;
select tests.set_jwt('00000000-0000-4000-8000-000000000001', 'aal1');
select is(tests.run('select public.fn_require_aal2()'), 'P0001|mfa_required|', 'fn_require_aal2: aal1 -> mfa_required');
select tests.set_jwt('00000000-0000-4000-8000-000000000001', null);
select is(tests.run('select public.fn_require_aal2()'), 'P0001|mfa_required|', 'fn_require_aal2: no aal claim -> mfa_required');
select tests.set_jwt('00000000-0000-4000-8000-000000000001', 'aal2');
select is(tests.run('select public.fn_require_aal2()'), 'P0001|mfa_required|', 'fn_require_aal2: aal2 but NO profile row -> mfa_required (fail closed)');
-- all three hold: the positive control
select tests.add_verified_factor((select admin from _f));
select tests.set_jwt((select admin from _f), 'aal2');
select is(tests.run('select public.fn_require_aal2()'), 'ok:1', 'fn_require_aal2: aal2 + password profile (tenant_admin) + verified factor passes (positive control)');
-- (1) the claim negated; profile and factor as in the control
select tests.set_jwt((select admin from _f), 'aal1');
select is(tests.run('select public.fn_require_aal2()'), 'P0001|mfa_required|', 'fn_require_aal2: aal1 + password profile + verified factor -> mfa_required (the claim is still required)');
select tests.set_jwt((select admin from _f), null);
select is(tests.run('select public.fn_require_aal2()'), 'P0001|mfa_required|', 'fn_require_aal2: no aal claim + password profile + verified factor -> mfa_required');
-- (2) the profile negated: a PIN account that enrolled its own TOTP holds an aal2 token AND a verified factor
select tests.add_verified_factor((select waiter from _f));
select tests.set_jwt((select waiter from _f), 'aal2');
select is(tests.run('select public.fn_require_aal2()'), 'P0001|mfa_required|', 'fn_require_aal2 (H1): aal2 + PIN profile + verified factor -> mfa_required (a PIN session that enrolled its own TOTP is not enough)');
-- ... and the PIN rule is the ONLY thing refusing it: the identical token + factor pass once the profile is a password account (owner-only simulation, rolled back)
select tests.set_jwt(null, null);
alter table public.profiles disable trigger trg_guard_profile_auth_method;
update public.profiles set auth_method = 'password' where id = (select waiter from _f);
alter table public.profiles enable trigger trg_guard_profile_auth_method;
select tests.set_jwt((select waiter from _f), 'aal2');
select is(tests.run('select public.fn_require_aal2()'), 'ok:1', '(control) the same aal2 token + verified factor with a password profile passes: the PIN rule alone refused it above');
select tests.set_jwt(null, null);
alter table public.profiles disable trigger trg_guard_profile_auth_method;
update public.profiles set auth_method = 'pin' where id = (select waiter from _f);
alter table public.profiles enable trigger trg_guard_profile_auth_method;
select tests.set_jwt((select platform from _f), 'aal2');
select tests.add_verified_factor((select platform from _f));
select is(tests.run('select public.fn_require_aal2()'), 'P0001|mfa_required|', 'fn_require_aal2: aal2 + verified factor but NO tenant profile (a platform admin) -> mfa_required (fail closed)');
select set_config('request.jwt.claims', '{"role":"authenticated","aal":"aal2"}', true);
select set_config('request.jwt.claim.sub', '', true);
select is(tests.run('select public.fn_require_aal2()'), 'P0001|mfa_required|', 'fn_require_aal2: an aal2 claim without any subject (no caller) -> mfa_required');
-- (3) the factor negated; aal2 token and password profile as in the control. The claims never change below: only the factor rows do.
select tests.set_jwt((select admin from _f), 'aal2');
select is(tests.run('select public.fn_require_aal2()'), 'ok:1', 'fn_require_aal2: (control) the tenant_admin''s aal2 token passes while its verified factor exists');
delete from auth.mfa_factors where user_id = (select admin from _f);
select is(tests.n_factors((select admin from _f)), 0, '(precondition) the authenticator was removed: no factor row left for the tenant_admin');
select is(tests.run('select public.fn_require_aal2()'), 'P0001|mfa_required|', 'fn_require_aal2 (L1): the SAME aal2 token once its factor row is gone (auth.mfa.unenroll elsewhere) -> mfa_required');
select tests.add_factor((select admin from _f), 'totp', 'unverified');
select is(tests.run('select public.fn_require_aal2()'), 'P0001|mfa_required|', 'fn_require_aal2: only an UNVERIFIED factor (abandoned enrolment) -> mfa_required');
select tests.add_verified_factor((select admin2 from _f));
select is(tests.run('select public.fn_require_aal2()'), 'P0001|mfa_required|', 'fn_require_aal2: a verified factor that belongs to ANOTHER user does not count -> mfa_required');
select tests.add_verified_factor((select admin from _f));
select is(tests.run('select public.fn_require_aal2()'), 'ok:1', 'fn_require_aal2: a verified factor next to the unverified leftover -> passes again (the same token)');
-- the factor predicate is the one fn_require_step_up uses (0015): with no GUC, step-up demands aal2 of an aal1 token exactly when a verified factor exists
select set_config('app.tenant_admin_mfa_required', 'off', true);
select tests.set_jwt((select admin from _f), 'aal1');
delete from auth.mfa_factors where user_id = (select admin from _f);
select is(tests.run('select public.fn_require_step_up()'), 'ok:1', 'parity: fn_require_step_up (aal1) with no factor demands nothing (fn_require_aal2 refuses even an aal2 token then)');
select tests.add_factor((select admin from _f), 'totp', 'unverified');
select is(tests.run('select public.fn_require_step_up()'), 'ok:1', 'parity: an unverified factor is no authenticator for fn_require_step_up either');
select tests.add_verified_factor((select admin from _f));
select is(tests.run('select public.fn_require_step_up()'), 'P0001|mfa_required|', 'parity: a verified factor makes fn_require_step_up demand aal2 (the very predicate that lets fn_require_aal2 pass)');
delete from auth.mfa_factors;
select tests.clear_auth();
select ok((select prosrc ~ 'auth_method' and prosrc ~ 'auth\.uid' from pg_proc where proname = 'fn_require_aal2' and pronamespace = 'public'::regnamespace), 'fn_require_aal2 reads auth_method of the caller''s own profile (id = auth.uid())');
select ok((select prosrc ~ 'auth\.mfa_factors' and prosrc ~ '''verified''' and prosrc ~ 'f\.user_id = \(select auth\.uid\(\)\)' from pg_proc where proname = 'fn_require_aal2' and pronamespace = 'public'::regnamespace), 'fn_require_aal2 reads auth.mfa_factors of the caller''s own id for a verified factor (like fn_require_step_up)');
select ok(has_function_privilege('authenticated', 'public.fn_approve_pin_change(uuid)', 'execute')
      and has_function_privilege('authenticated', 'public.fn_reject_pin_change(uuid)', 'execute')
      and has_function_privilege('authenticated', 'public.fn_list_pending_pin_changes()', 'execute'), 'approve / reject / list: authenticated');
select ok(not has_function_privilege('anon', 'public.fn_approve_pin_change(uuid)', 'execute')
      and not has_function_privilege('anon', 'public.fn_reject_pin_change(uuid)', 'execute')
      and not has_function_privilege('anon', 'public.fn_list_pending_pin_changes()', 'execute'), 'and not anon');
select ok((select bool_and(p.prosecdef and p.proconfig @> array['search_path=""'])
           from pg_proc p where p.pronamespace = 'public'::regnamespace
             and p.proname in ('fn_pin_restricted', 'fn_complete_forced_pin_change', 'fn_decide_pin_change', 'fn_approve_pin_change', 'fn_reject_pin_change', 'fn_list_pending_pin_changes')),
          'all six: security definer with an empty search_path');
select is(tests.run(format($q$select public.fn_complete_forced_pin_change(%L, %L)$q$, (select waiter from _f), tests.pin_digest('7391'))), 'P0001|permission_denied|', 'a non-service caller (owner role) gets permission_denied');
select tests.authenticate_as((select admin from _f));
select is(tests.run(format($q$select public.fn_complete_forced_pin_change(%L, %L)$q$, (select waiter from _f), tests.pin_digest('7391'))), '42501|permission denied for function fn_complete_forced_pin_change|', 'a tenant_admin cannot call it');
select tests.clear_auth();
select tests.authenticate_as((select waiter from _f));
select is(tests.run(format($q$select public.fn_complete_forced_pin_change(%L, %L)$q$, (select waiter from _f), tests.pin_digest('7391'))), '42501|permission denied for function fn_complete_forced_pin_change|', 'nor the staff member themselves (no self-service path around the Edge Function)');
select tests.clear_auth();
select tests.as_anon();
select is(tests.run(format($q$select public.fn_complete_forced_pin_change(%L, %L)$q$, (select waiter from _f), tests.pin_digest('7391'))), '42501|permission denied for function fn_complete_forced_pin_change|', 'anon cannot call it');
select is(tests.run($q$select public.fn_list_pending_pin_changes()$q$), '42501|permission denied for function fn_list_pending_pin_changes|', 'anon cannot list');
select is(tests.run(format($q$select public.fn_approve_pin_change(%L)$q$, (select waiter from _f))), '42501|permission denied for function fn_approve_pin_change|', 'anon cannot approve');
select tests.clear_auth();

-- ═════════ voluntary change: no approval ═════════
select tests.authenticate_as((select waiter from _f));
select is(public.fn_get_session_context() ->> 'pin_change_status', 'none', 'unflagged waiter: pin_change_status = none');
select is((public.fn_get_session_context() ->> 'pin_length')::int, 4, 'pin_length = 4 for a normal PIN role');
select is((public.fn_get_session_context() ->> 'must_change_pin')::boolean, false, 'must_change_pin stays (false)');
select tests.clear_auth();
select tests.authenticate_as_service_role();
select is(public.fn_complete_forced_pin_change((select waiter from _f), tests.pin_digest('7391'), 4) ->> 'pending_approval', 'false', 'voluntary change: pending_approval = false');
select tests.clear_auth();
select is((select pin_change_pending or must_change_pin from public.profile_secrets where profile_id = (select waiter from _f)), false, 'no flag, nothing pending');
select ok(extensions.crypt(tests.pin_digest('7391'), (select pin_hash from public.profile_secrets where profile_id = (select waiter from _f))) = (select pin_hash from public.profile_secrets where profile_id = (select waiter from _f)), 'the new PIN is stored (bcrypt of the digest)');
select is((select count(*)::int from public.audit_logs where event = 'auth.pin_set' and created_at >= now() and (new_data ->> 'profile_id') = (select waiter::text from _f)), 1, 'audited like fn_set_user_pin (auth.pin_set)');
select is(tests.n_admin_notes('security.pin_change_pending_approval', (select waiter from _f)), 0, 'no admin notification for a voluntary change');
select tests.authenticate_as((select waiter from _f));
select ok(public.has_permission('orders.create'), 'access is unchanged');
select tests.clear_auth();

-- ═════════ forced: required ═════════
select tests.authenticate_as_service_role();
select public.fn_staff_login_blocked((select waiter from _f));
select tests.clear_auth();
select tests.authenticate_as((select waiter from _f));
select is(public.fn_get_session_context() ->> 'pin_change_status', 'required', 'flagged: pin_change_status = required');
select is((public.fn_get_session_context() ->> 'must_change_pin')::boolean, true, 'and must_change_pin = true');
select tests.clear_auth();

-- validation (same as fn_set_user_pin)
select tests.authenticate_as_service_role();
select is(tests.run(format($q$select public.fn_complete_forced_pin_change(%L, 'not-a-digest')$q$, (select waiter from _f))), 'P0001|invalid_pin|', 'a raw PIN / non-hex digest: invalid_pin');
select is(tests.run(format($q$select public.fn_complete_forced_pin_change(%L, null)$q$, (select waiter from _f))), 'P0001|invalid_pin|', 'null digest: invalid_pin');
select is(tests.run(format($q$select public.fn_complete_forced_pin_change(%L, %L, 6)$q$, (select waiter from _f), tests.pin_digest('7391'))), 'P0001|pin_length_mismatch|', 'claimed length 6 for a 4-digit role: pin_length_mismatch');
select is(tests.run(format($q$select public.fn_complete_forced_pin_change(%L, %L)$q$, gen_random_uuid(), tests.pin_digest('7391'))), 'P0001|not_found|', 'unknown profile: not_found');
select is(tests.run(format($q$select public.fn_complete_forced_pin_change(%L, %L)$q$, (select admin from _f), tests.pin_digest('7391'))), 'P0001|pin_not_allowed|', 'a tenant_admin: pin_not_allowed (never a PIN)');
select tests.clear_auth();
select is((select must_change_pin and not pin_change_pending from public.profile_secrets where profile_id = (select waiter from _f)), true, 'failed attempts changed nothing');

-- the change itself
select tests.authenticate_as_service_role();
select is(public.fn_complete_forced_pin_change((select waiter from _f), tests.pin_digest('5183'), 4) ->> 'pending_approval', 'true', 'forced change: pending_approval = true');
select tests.clear_auth();
select is((select must_change_pin from public.profile_secrets where profile_id = (select waiter from _f)), false, 'must_change_pin cleared');
select is((select pin_change_pending from public.profile_secrets where profile_id = (select waiter from _f)), true, 'pin_change_pending set');
select ok((select pin_change_requested_at > now() - interval '1 minute' from public.profile_secrets where profile_id = (select waiter from _f)), 'pin_change_requested_at = now');
insert into _n select 'requested_at', pin_change_requested_at::text from public.profile_secrets where profile_id = (select waiter from _f);
select ok(extensions.crypt(tests.pin_digest('5183'), (select pin_hash from public.profile_secrets where profile_id = (select waiter from _f))) = (select pin_hash from public.profile_secrets where profile_id = (select waiter from _f)), 'the new PIN is stored');
select is((select failed_attempts from public.profile_secrets where profile_id = (select waiter from _f)), 0, 'lockout counter reset');
select is(tests.n_notes('security.pin_change_pending_approval', (select admin from _f)), 1, 'tenant_admin 1 notified');
select is(tests.n_notes('security.pin_change_pending_approval', (select admin2 from _f)), 1, 'tenant_admin 2 notified');
select is(tests.n_notes('security.pin_change_pending_approval', (select waiter from _f)), 0, 'the subject is not notified of their own request');
select is(tests.n_notes('security.pin_change_pending_approval', (select deleg from _f)) + tests.n_notes('security.pin_change_pending_approval', (select b_admin from _f)), 0, 'neither a delegate nor another tenant''s admin');
select is((select string_agg(k, ',' order by k) from (select distinct jsonb_object_keys(payload) k from public.user_notifications where kind = 'security.pin_change_pending_approval') x), 'at,profile_id,user_name', 'payload keys: at, profile_id, user_name');
select is((select payload ->> 'user_name' from public.user_notifications where kind = 'security.pin_change_pending_approval' limit 1), (select short_name from public.profiles where id = (select waiter from _f)), 'user_name is the short name');
select is((select count(*)::int from public.audit_logs where event = 'auth.pin_change_requested' and restaurant_id = (select a from _f)), 1, 'audit auth.pin_change_requested written once');
select is((select actor_id from public.audit_logs where event = 'auth.pin_change_requested'), null, 'actor is the system (service call), no spoofed actor');

-- restricted while pending: nothing but identity, own notifications and the pin-change path
select tests.authenticate_as((select waiter from _f));
select is(public.fn_get_session_context() ->> 'pin_change_status', 'pending_approval', 'context: pin_change_status = pending_approval');
select is((public.fn_get_session_context() ->> 'must_change_pin')::boolean, false, 'must_change_pin is false while pending (the PIN change screen is done)');
select is(public.fn_get_session_context() -> 'permissions', '[]'::jsonb, 'permissions []');
select is(public.fn_get_session_context() -> 'station_ids', '[]'::jsonb, 'station_ids []');
select is(public.fn_get_session_context() #>> '{user,id}', (select waiter::text from _f), 'identity still returned');
select ok(not public.has_permission('orders.create') and not public.has_permission('menu.view'), 'has_permission false for every key');
select is(public.current_station_ids(), '{}'::uuid[], 'no station ids');
select ok(not exists (select 1 from public.stations s where public.has_station_access(s.id)), 'no station access');
select is((select count(*)::int from public.menu_items), 0, 'RLS: tenant data needing a permission reads nothing');
select is((select count(*)::int from public.orders), 0, 'RLS: orders read nothing');
select ok((select count(*) from public.user_notifications) >= 1, 'but the restricted user still reads their OWN notifications (recipient-only policy)');
select ok((select count(*) from public.user_notifications where recipient_id <> (select waiter from _f)) = 0, 'and only their own');
insert into _n select 'own_note', (select id::text from public.user_notifications order by created_at limit 1);
select ok((public.fn_mark_notification_read((select v::uuid from _n where k = 'own_note')) ->> 'read_at') is not null, 'and can mark them read while restricted');
select is(tests.run($q$select public.fn_list_pending_pin_changes()$q$), 'P0001|permission_denied|', 'cannot list pending changes');
select is(tests.run(format($q$select public.fn_approve_pin_change(%L)$q$, (select waiter from _f))), 'P0001|permission_denied|', 'cannot approve their own change (no users.manage while restricted; also never the subject)');
select is(tests.run(format($q$select public.fn_reject_pin_change(%L)$q$, (select waiter from _f))), 'P0001|permission_denied|', 'nor reject');
select tests.clear_auth();
select is((select pin_change_pending from public.profile_secrets where profile_id = (select waiter from _f)), true, 'still pending after the attempts');

-- a second change while pending stays pending (no bypass), keeps the request time, sends nothing new
select tests.authenticate_as_service_role();
select is(public.fn_complete_forced_pin_change((select waiter from _f), tests.pin_digest('2749'), 4) ->> 'pending_approval', 'true', 'changing the PIN again while pending: still pending_approval');
select tests.clear_auth();
select is((select pin_change_pending and not must_change_pin from public.profile_secrets where profile_id = (select waiter from _f)), true, 'state unchanged');
select is((select pin_change_requested_at::text from public.profile_secrets where profile_id = (select waiter from _f)), (select v from _n where k = 'requested_at'), 'request time unchanged');
select is(tests.n_admin_notes('security.pin_change_pending_approval', (select waiter from _f)), 2, 'no new notification');
select is((select count(*)::int from public.audit_logs where event = 'auth.pin_change_requested'), 1, 'no second request audit row');
select ok(extensions.crypt(tests.pin_digest('2749'), (select pin_hash from public.profile_secrets where profile_id = (select waiter from _f))) = (select pin_hash from public.profile_secrets where profile_id = (select waiter from _f)), '(the newest PIN is the one stored)');

-- ═════════ list ═════════
select tests.authenticate_as((select admin from _f));
select is(jsonb_array_length(public.fn_list_pending_pin_changes()), 1, 'admin lists exactly one pending change');
select is((select string_agg(k, ',' order by k) from jsonb_object_keys(public.fn_list_pending_pin_changes() -> 0) k), 'profile_id,requested_at,role_label,user_name', 'item keys');
select is(public.fn_list_pending_pin_changes() -> 0 ->> 'profile_id', (select waiter::text from _f), 'profile_id');
select is(public.fn_list_pending_pin_changes() -> 0 ->> 'user_name', (select short_name from public.profiles where id = (select waiter from _f)), 'user_name is First + Middle');
select is(public.fn_list_pending_pin_changes() -> 0 ->> 'role_label', (select ro.name from public.profiles p join public.roles ro on ro.id = p.role_id where p.id = (select waiter from _f)), 'role_label is the role row name');
select is((public.fn_list_pending_pin_changes() -> 0 ->> 'requested_at')::timestamptz, (select v::timestamptz from _n where k = 'requested_at'), 'requested_at');
select ok(not (public.fn_list_pending_pin_changes()::text ~* '(pin_hash|digest|token|\$2[aby]\$|[0-9a-f]{64})'), 'no secret in the list');
select tests.clear_auth();
select tests.authenticate_as((select b_admin from _f));
select is(public.fn_list_pending_pin_changes(), '[]'::jsonb, 'tenant B''s admin sees an empty list (tenant A''s pending is invisible)');
select tests.clear_auth();
select tests.authenticate_as((select kitchen from _f));
select is(tests.run($q$select public.fn_list_pending_pin_changes()$q$), 'P0001|permission_denied|', 'staff without users.manage: permission_denied');
select tests.clear_auth();
-- make tenant B have its own pending change; each admin only ever sees their own tenant's
select tests.authenticate_as_service_role();
select public.fn_staff_login_blocked((select b_waiter from _f));
select public.fn_complete_forced_pin_change((select b_waiter from _f), tests.pin_digest('6428'), 4);
select tests.clear_auth();
select tests.authenticate_as((select b_admin from _f));
select is((select string_agg(e ->> 'profile_id', ',') from jsonb_array_elements(public.fn_list_pending_pin_changes()) e), (select b_waiter::text from _f), 'tenant B lists only its own');
select tests.clear_auth();
select tests.authenticate_as((select admin from _f));
select is((select string_agg(e ->> 'profile_id', ',') from jsonb_array_elements(public.fn_list_pending_pin_changes()) e), (select waiter::text from _f), 'tenant A still lists only its own');
select tests.clear_auth();

-- ═════════ approve / reject: authorisation, oracle, self ═════════
select tests.aal2((select admin from _f));
select is(tests.run(format($q$select public.fn_approve_pin_change(%L)$q$, (select admin from _f))), 'P0001|permission_denied|', 'the approver is never the subject (own id)');
select is(tests.run(format($q$select public.fn_reject_pin_change(%L)$q$, (select admin from _f))), 'P0001|permission_denied|', 'nor reject own id');
select is(tests.run('select public.fn_approve_pin_change(null)'), 'P0001|invalid_input|', 'null id: invalid_input');
select is(tests.oracle($q$select public.fn_approve_pin_change({id})$q$, (select b_waiter from _f)), 'P0001|not_found|', 'approve(foreign pending id) answers exactly like an unknown id');
select is(tests.oracle($q$select public.fn_reject_pin_change({id})$q$, (select b_waiter from _f)), 'P0001|not_found|', 'reject(foreign pending id) answers exactly like an unknown id');
select is(tests.oracle($q$select public.fn_approve_pin_change({id})$q$, (select kitchen from _f)), 'P0001|not_found|', 'approve(own-tenant NOT pending user) answers exactly like an unknown id');
select is(tests.oracle($q$select public.fn_reject_pin_change({id})$q$, (select kitchen from _f)), 'P0001|not_found|', 'reject(not pending) likewise');
select is(tests.oracle($q$select public.fn_approve_pin_change({id})$q$, (select admin2 from _f)), 'P0001|not_found|', 'approve(another admin id): not_found as well');
select tests.clear_auth();
select tests.aal2((select b_admin from _f));
select is(tests.oracle($q$select public.fn_approve_pin_change({id})$q$, (select waiter from _f)), 'P0001|not_found|', 'cross-tenant: B admin approving A''s pending id = unknown id');
select is(tests.oracle($q$select public.fn_reject_pin_change({id})$q$, (select waiter from _f)), 'P0001|not_found|', 'cross-tenant reject likewise');
select tests.clear_auth();
select tests.authenticate_as((select kitchen from _f));
select is(tests.run(format($q$select public.fn_approve_pin_change(%L)$q$, (select waiter from _f))), 'P0001|permission_denied|', 'staff without users.manage: approve denied');
select is(tests.run(format($q$select public.fn_reject_pin_change(%L)$q$, (select waiter from _f))), 'P0001|permission_denied|', 'reject denied');
select tests.clear_auth();
select tests.authenticate_as((select b_waiter from _f));
select is(tests.run(format($q$select public.fn_approve_pin_change(%L)$q$, (select waiter from _f))), 'P0001|permission_denied|', 'another tenant''s restricted user: denied');
select tests.clear_auth();
select is((select pin_change_pending from public.profile_secrets where profile_id = (select waiter from _f)), true, 'every refusal left the request pending');
select is((select count(*)::int from public.audit_logs where event in ('auth.pin_change_approved', 'auth.pin_change_rejected')), 0, 'and wrote no decision audit row');

-- delegate (users.manage, lower rights) cannot decide for a role it does not cover
select tests.authenticate_as((select admin from _f));
insert into public.roles (restaurant_id, name) values ((select a from _f), 'HR Lead');
select public.fn_update_role_permissions((select id from public.roles where restaurant_id = (select a from _f) and name = 'HR Lead'), array['users.manage', 'users.view'], '{}');
select public.fn_change_user_role((select deleg from _f), (select id from public.roles where restaurant_id = (select a from _f) and name = 'HR Lead'));
select tests.clear_auth();
select tests.authenticate_as_service_role();
select public.fn_staff_login_blocked((select cashier from _f));
select public.fn_complete_forced_pin_change((select cashier from _f), tests.pin_digest('834921'), 6);
select tests.clear_auth();
select tests.aal2((select deleg from _f));
select is(tests.run(format($q$select public.fn_approve_pin_change(%L)$q$, (select cashier from _f))), 'P0001|mfa_required|', 'PIN delegate on an aal2 session (self-enrolled TOTP, H1): mfa_required before the role check');
select tests.clear_auth();
-- defence in depth: the role-coverage check still holds for any aal2 password caller (simulated; owner-only, rolled back)
alter table public.profiles disable trigger trg_guard_profile_auth_method;
update public.profiles set auth_method = 'password' where id = (select deleg from _f);
alter table public.profiles enable trigger trg_guard_profile_auth_method;
select tests.aal2((select deleg from _f));
select is(tests.run(format($q$select public.fn_approve_pin_change(%L)$q$, (select cashier from _f))), 'P0001|permission_escalation|', 'a password caller on aal2 that does not hold the role''s rights: permission_escalation');
select tests.clear_auth();
alter table public.profiles disable trigger trg_guard_profile_auth_method;
update public.profiles set auth_method = 'pin' where id = (select deleg from _f);
alter table public.profiles enable trigger trg_guard_profile_auth_method;
select is((select pin_change_pending from public.profile_secrets where profile_id = (select cashier from _f)), true, 'cashier still pending');
select tests.authenticate_as((select cashier from _f));
select is(public.fn_get_session_context() ->> 'pin_change_status', 'pending_approval', 'cashier context: pending_approval');
select is((public.fn_get_session_context() ->> 'pin_length')::int, 6, 'pin_length = 6 for the documented Cashier exception');
select tests.clear_auth();
select tests.authenticate_as_service_role();
select is(tests.run(format($q$select public.fn_staff_login_blocked(%L)$q$, (select cashier from _f))), 'ok:1', 'PIN exposed again while pending: the blocked-login handler does not violate the exclusive CHECK');
select tests.clear_auth();
select is((select must_change_pin and not pin_change_pending and pin_change_requested_at is null from public.profile_secrets where profile_id = (select cashier from _f)), true, 'and moves the account back to required');
select tests.authenticate_as_service_role();
select is(tests.run(format($q$select public.fn_complete_forced_pin_change(%L, %L, 4)$q$, (select cashier from _f), tests.pin_digest('3917'))), 'P0001|pin_length_mismatch|', 'cashier: a 4-digit claim is refused');
select tests.clear_auth();

-- ═════════ step-up ═════════
select tests.add_verified_factor((select admin from _f));
select tests.authenticate_as((select admin from _f));
select is(tests.run(format($q$select public.fn_approve_pin_change(%L)$q$, (select waiter from _f))), 'P0001|mfa_required|', 'admin with an MFA factor on an aal1 session: approve needs step-up (mfa_required)');
select is(tests.run(format($q$select public.fn_reject_pin_change(%L)$q$, (select waiter from _f))), 'P0001|mfa_required|', 'reject too');
select ok(jsonb_array_length(public.fn_list_pending_pin_changes()) >= 1, 'listing needs no step-up');
select tests.clear_auth();
select is((select pin_change_pending from public.profile_secrets where profile_id = (select waiter from _f)), true, 'nothing decided without step-up');
select tests.authenticate_as((select admin2 from _f));
select set_config('app.tenant_admin_mfa_required', 'on', true);
select is(tests.run(format($q$select public.fn_approve_pin_change(%L)$q$, (select waiter from _f))), 'P0001|mfa_required|', 'app.tenant_admin_mfa_required = on: even an admin without a factor needs aal2');
select set_config('app.tenant_admin_mfa_required', 'off', true);
select tests.clear_auth();

-- ═════════ approve ═════════
select tests.aal2((select admin from _f));
select is(public.fn_approve_pin_change((select waiter from _f)) ->> 'status', 'approved', 'approve (aal2): status approved');
select tests.clear_auth();
select is((select not pin_change_pending and not must_change_pin and pin_change_requested_at is null from public.profile_secrets where profile_id = (select waiter from _f)), true, 'state cleared');
select ok(extensions.crypt(tests.pin_digest('2749'), (select pin_hash from public.profile_secrets where profile_id = (select waiter from _f))) = (select pin_hash from public.profile_secrets where profile_id = (select waiter from _f)), 'the PIN the user chose stays in force');
select tests.authenticate_as((select waiter from _f));
select ok(public.has_permission('orders.create'), 'access restored immediately');
select ok((select count(*) from public.menu_items) > 0, 'RLS reads work again');
select is(public.fn_get_session_context() ->> 'pin_change_status', 'none', 'context: none');
select ok(jsonb_array_length(public.fn_get_session_context() -> 'permissions') > 0, 'permissions listed again');
select tests.clear_auth();
select is(tests.n_notes('security.pin_change_approved', (select waiter from _f)), 1, 'the subject is notified (approved)');
select is((select string_agg(k, ',' order by k) from public.user_notifications n, jsonb_object_keys(n.payload) k where n.kind = 'security.pin_change_approved'), 'at,profile_id,user_name', 'approved payload keys');
select is((select count(*)::int from public.audit_logs where event = 'auth.pin_change_approved' and actor_id = (select admin from _f) and (new_data ->> 'profile_id') = (select waiter::text from _f)), 1, 'audit auth.pin_change_approved with the approver as actor');
select tests.aal2((select admin from _f));
select is(tests.run(format($q$select public.fn_approve_pin_change(%L)$q$, (select waiter from _f))), 'P0001|not_found|', 'replay approve: not_found (idempotent-safe, no second notification)');
select is(tests.run(format($q$select public.fn_reject_pin_change(%L)$q$, (select waiter from _f))), 'P0001|not_found|', 'reject after approve: not_found');
select tests.clear_auth();
select is(tests.n_notes('security.pin_change_approved', (select waiter from _f)), 1, 'still one approved notification');
select is((select count(*)::int from public.audit_logs where event = 'auth.pin_change_approved'), 1, 'still one audit row');

-- ═════════ tenant status: deciding is a write (past_due -> tenant_read_only, suspended -> tenant_suspended) ═════════
-- fn_tenant_status_guard(true) is called twice on purpose: by each wrapper and by the shared body behind them. Through the public
-- API either layer therefore masks a missing guard in the other, so each layer is also proven on its own below.
-- A pending change of its own (sara, Pastry: used nowhere else in this file), so no other section's state, counts or notifications move.
select tests.authenticate_as_service_role();
select public.fn_staff_login_blocked((select pastry from _f));
select public.fn_complete_forced_pin_change((select pastry from _f), tests.pin_digest('3856'), 4);
select tests.clear_auth();
select is((select pin_change_pending and not must_change_pin from public.profile_secrets where profile_id = (select pastry from _f)), true, '(a Pastry staff member now awaits approval)');
insert into _n select 'ts_requested_at', pin_change_requested_at::text from public.profile_secrets where profile_id = (select pastry from _f);
insert into _n select 'ts_status', status from public.restaurants where id = (select a from _f);

-- past_due: read-only. An aal2 tenant_admin holding users.manage is refused before anything is read or written.
update public.restaurants set status = 'past_due' where id = (select a from _f);
insert into _n select 'ts_audit_pd', count(*)::text from public.audit_logs where restaurant_id = (select a from _f);
select tests.aal2((select admin from _f));
select is(tests.run(format($q$select public.fn_approve_pin_change(%L)$q$, (select pastry from _f))), 'P0001|tenant_read_only|', 'past_due: approve refused (tenant_read_only), even for an aal2 tenant_admin');
select is(tests.run(format($q$select public.fn_reject_pin_change(%L)$q$, (select pastry from _f))), 'P0001|tenant_read_only|', 'past_due: reject refused (tenant_read_only)');
select tests.clear_auth();
-- the shared body refuses on its own too: called directly (internal: owner role + an aal2 tenant_admin's claims, as for fn_require_aal2 above)
select set_config('request.jwt.claims', json_build_object('sub', (select admin from _f), 'role', 'authenticated', 'aud', 'authenticated', 'aal', 'aal2')::text, true);
select is(tests.run(format($q$select public.fn_decide_pin_change(%L, true)$q$, (select pastry from _f))), 'P0001|tenant_read_only|', 'past_due: fn_decide_pin_change(approve) refuses on its own');
select is(tests.run(format($q$select public.fn_decide_pin_change(%L, false)$q$, (select pastry from _f))), 'P0001|tenant_read_only|', 'past_due: fn_decide_pin_change(reject) refuses on its own');
select set_config('request.jwt.claims', '', true);
select is((select pin_change_pending and not must_change_pin and pin_change_requested_at::text = (select v from _n where k = 'ts_requested_at') from public.profile_secrets where profile_id = (select pastry from _f)), true, 'past_due: the request is still pending, request time untouched');
select is((select count(*)::int from public.audit_logs where restaurant_id = (select a from _f)), (select v::int from _n where k = 'ts_audit_pd'), 'past_due: no audit row was written');

-- suspended: no access at all, and the refusal says why (tenant_suspended, not a bare permission_denied)
update public.restaurants set status = 'suspended', suspended_at = now(), suspension_reason = 'test', status_before_suspension = 'past_due' where id = (select a from _f);
insert into _n select 'ts_audit_su', count(*)::text from public.audit_logs where restaurant_id = (select a from _f);
select tests.aal2((select admin from _f));
select is(tests.run(format($q$select public.fn_approve_pin_change(%L)$q$, (select pastry from _f))), 'P0001|tenant_suspended|', 'suspended: approve refused (tenant_suspended), even for an aal2 tenant_admin');
select is(tests.run(format($q$select public.fn_reject_pin_change(%L)$q$, (select pastry from _f))), 'P0001|tenant_suspended|', 'suspended: reject refused (tenant_suspended)');
select tests.clear_auth();
select set_config('request.jwt.claims', json_build_object('sub', (select admin from _f), 'role', 'authenticated', 'aud', 'authenticated', 'aal', 'aal2')::text, true);
select is(tests.run(format($q$select public.fn_decide_pin_change(%L, true)$q$, (select pastry from _f))), 'P0001|tenant_suspended|', 'suspended: fn_decide_pin_change(approve) refuses on its own');
select is(tests.run(format($q$select public.fn_decide_pin_change(%L, false)$q$, (select pastry from _f))), 'P0001|tenant_suspended|', 'suspended: fn_decide_pin_change(reject) refuses on its own');
select set_config('request.jwt.claims', '', true);
select is((select pin_change_pending and not must_change_pin and pin_change_requested_at::text = (select v from _n where k = 'ts_requested_at') from public.profile_secrets where profile_id = (select pastry from _f)), true, 'suspended: the request is still pending, request time untouched');
select is((select count(*)::int from public.audit_logs where restaurant_id = (select a from _f)), (select v::int from _n where k = 'ts_audit_su'), 'suspended: no audit row was written');

-- Each wrapper also refuses on its own: take the shared body away from them (owner EXECUTE revoked, restored below), so only a
-- wrapper's own fn_tenant_status_guard(true) can still produce the refusal. The control (tenant writable again) proves the body
-- really is unreachable: an unguarded wrapper would die right there with 42501.
update public.restaurants set status = (select v from _n where k = 'ts_status'), suspended_at = null, suspension_reason = null, status_before_suspension = null where id = (select a from _f);
insert into _n select 'ts_acl', (select string_agg(a::text, ',' order by a::text) from pg_proc p, unnest(p.proacl) a where p.oid = 'public.fn_decide_pin_change(uuid,boolean)'::regprocedure);
revoke execute on function public.fn_decide_pin_change(uuid, boolean) from current_user;
select tests.aal2((select admin from _f));
select is(tests.run(format($q$select public.fn_approve_pin_change(%L)$q$, (select pastry from _f))), '42501|permission denied for function fn_decide_pin_change|', '(control) writable tenant: fn_approve_pin_change cannot reach the shared body');
select is(tests.run(format($q$select public.fn_reject_pin_change(%L)$q$, (select pastry from _f))), '42501|permission denied for function fn_decide_pin_change|', '(control) writable tenant: nor can fn_reject_pin_change');
select tests.clear_auth();
update public.restaurants set status = 'past_due' where id = (select a from _f);
select tests.aal2((select admin from _f));
select is(tests.run(format($q$select public.fn_approve_pin_change(%L)$q$, (select pastry from _f))), 'P0001|tenant_read_only|', 'past_due: fn_approve_pin_change refuses on its own');
select is(tests.run(format($q$select public.fn_reject_pin_change(%L)$q$, (select pastry from _f))), 'P0001|tenant_read_only|', 'past_due: fn_reject_pin_change refuses on its own');
select tests.clear_auth();
update public.restaurants set status = 'suspended', suspended_at = now(), suspension_reason = 'test', status_before_suspension = 'past_due' where id = (select a from _f);
select tests.aal2((select admin from _f));
select is(tests.run(format($q$select public.fn_approve_pin_change(%L)$q$, (select pastry from _f))), 'P0001|tenant_suspended|', 'suspended: fn_approve_pin_change refuses on its own');
select is(tests.run(format($q$select public.fn_reject_pin_change(%L)$q$, (select pastry from _f))), 'P0001|tenant_suspended|', 'suspended: fn_reject_pin_change refuses on its own');
select tests.clear_auth();
grant execute on function public.fn_decide_pin_change(uuid, boolean) to current_user;
update public.restaurants set status = (select v from _n where k = 'ts_status'), suspended_at = null, suspension_reason = null, status_before_suspension = null where id = (select a from _f);
select is((select string_agg(a::text, ',' order by a::text) from pg_proc p, unnest(p.proacl) a where p.oid = 'public.fn_decide_pin_change(uuid,boolean)'::regprocedure), (select v from _n where k = 'ts_acl'), 'the shared body''s privileges are exactly as they were');
select is((select status = (select v from _n where k = 'ts_status') and suspended_at is null and suspension_reason is null and status_before_suspension is null from public.restaurants where id = (select a from _f)), true, 'tenant status restored (suspension fields cleared)');
-- control: with the status restored the very same call succeeds, so every refusal above was the tenant status and nothing else
select tests.aal2((select admin from _f));
select is(tests.run(format($q$select public.fn_approve_pin_change(%L)$q$, (select pastry from _f))), 'ok:1', 'restored: the same approve now succeeds');
select tests.clear_auth();
select is((select not pin_change_pending and not must_change_pin and pin_change_requested_at is null from public.profile_secrets where profile_id = (select pastry from _f)), true, 'restored: the request is decided (released) by that call');
select is((select count(*)::int from public.audit_logs where event = 'auth.pin_change_approved' and actor_id = (select admin from _f) and (new_data ->> 'profile_id') = (select pastry::text from _f)), 1, 'restored: and audited exactly once, with the tenant_admin as actor');

-- ═════════ reject, resubmit, admin-set PIN ═════════
select tests.authenticate_as_service_role();
select public.fn_staff_login_blocked((select waiter from _f));
select is(public.fn_complete_forced_pin_change((select waiter from _f), tests.pin_digest('8264'), 4) ->> 'pending_approval', 'true', 'second forced cycle: pending again');
select tests.clear_auth();
select is(tests.n_admin_notes('security.pin_change_pending_approval', (select waiter from _f)), 2, 'reject/resubmit loop: admins are not spammed (5 minute dedupe per admin and subject)');
select is((select count(*)::int from public.audit_logs where event = 'auth.pin_change_requested' and (new_data ->> 'profile_id') = (select waiter::text from _f)), 2, 'but the request is audited every time');
select tests.aal2((select admin2 from _f));
select is(public.fn_reject_pin_change((select waiter from _f)) ->> 'status', 'rejected', 'the OTHER admin rejects: status rejected');
select tests.clear_auth();
select is((select must_change_pin and not pin_change_pending and pin_change_requested_at is null from public.profile_secrets where profile_id = (select waiter from _f)), true, 'reject: pending cleared, must_change_pin = true again');
select tests.authenticate_as((select waiter from _f));
select is(public.fn_get_session_context() ->> 'pin_change_status', 'required', 'context: required');
select is(public.fn_get_session_context() -> 'permissions', '[]'::jsonb, 'still no permissions');
select tests.clear_auth();
select is(tests.n_notes('security.pin_change_rejected', (select waiter from _f)), 1, 'the subject is notified (rejected)');
select is((select string_agg(k, ',' order by k) from public.user_notifications n, jsonb_object_keys(n.payload) k where n.kind = 'security.pin_change_rejected'), 'at,profile_id,user_name', 'rejected payload keys');
select is((select count(*)::int from public.audit_logs where event = 'auth.pin_change_rejected' and actor_id = (select admin2 from _f)), 1, 'audit auth.pin_change_rejected with that admin as actor');
select tests.aal2((select admin2 from _f));
select is(tests.run(format($q$select public.fn_reject_pin_change(%L)$q$, (select waiter from _f))), 'P0001|not_found|', 'replay reject: not_found');
select is(tests.run(format($q$select public.fn_approve_pin_change(%L)$q$, (select waiter from _f))), 'P0001|not_found|', 'approve a rejected (required, not pending) user: not_found');
select tests.clear_auth();
-- an admin-set PIN (service fn_set_user_pin) never leaves anyone pending or flagged
select tests.authenticate_as_service_role();
select public.fn_complete_forced_pin_change((select waiter from _f), tests.pin_digest('9146'), 4);
select tests.clear_auth();
select is((select pin_change_pending from public.profile_secrets where profile_id = (select waiter from _f)), true, 'pending once more');
select tests.authenticate_as_service_role();
select lives_ok(format($q$select public.fn_set_user_pin(%L, %L, 4)$q$, (select waiter from _f), tests.pin_digest('3175')), 'fn_set_user_pin (admin-set PIN)');
select tests.clear_auth();
select is((select not pin_change_pending and not must_change_pin and pin_change_requested_at is null from public.profile_secrets where profile_id = (select waiter from _f)), true, 'fn_set_user_pin leaves nobody pending or flagged');
select tests.authenticate_as((select waiter from _f));
select ok(public.has_permission('orders.create'), 'access back');
select tests.clear_auth();

-- ═════════ aal2 gate (0026): a PIN-only delegate holding users.manage may not decide; an authenticator may ═════════
select tests.authenticate_as_service_role();
select public.fn_staff_login_blocked((select kitchen from _f));
select public.fn_complete_forced_pin_change((select kitchen from _f), tests.pin_digest('4608'), 4);
select tests.clear_auth();
select is((select pin_change_pending from public.profile_secrets where profile_id = (select kitchen from _f)), true, '(kitchen staff now awaits approval)');
-- the delegate role covers the kitchen role, so only the aal2 gate stands between the delegate and the decision
insert into public.role_permissions (role_id, permission_id, restaurant_id)
  select (select id from public.roles where restaurant_id = (select a from _f) and name = 'HR Lead'), rp.permission_id, rp.restaurant_id
  from public.role_permissions rp join public.profiles p on p.role_id = rp.role_id where p.id = (select kitchen from _f)
  on conflict do nothing;
insert into public.role_station_access (role_id, station_id, restaurant_id)
  select (select id from public.roles where restaurant_id = (select a from _f) and name = 'HR Lead'), rsa.station_id, rsa.restaurant_id
  from public.role_station_access rsa join public.profiles p on p.role_id = rsa.role_id where p.id = (select kitchen from _f)
  on conflict do nothing;
delete from auth.mfa_factors where user_id in (select deleg from _f union select admin2 from _f);   -- (the aal2 helper enrolled them above) the next two cases have NO authenticator
select tests.authenticate_as((select deleg from _f));   -- aal1 session, no authenticator: a PIN-only delegate
select ok(public.has_permission('users.manage'), '(the PIN delegate holds users.manage)');
select is(tests.run(format($q$select public.fn_approve_pin_change(%L)$q$, (select kitchen from _f))), 'P0001|mfa_required|', 'PIN delegate (aal1, no factor) with users.manage: approve -> mfa_required');
select is(tests.run(format($q$select public.fn_reject_pin_change(%L)$q$, (select kitchen from _f))), 'P0001|mfa_required|', 'PIN delegate: reject -> mfa_required');
select is(tests.run('select public.fn_approve_pin_change(null)'), 'P0001|mfa_required|', 'aal2 is checked before input validation (null id -> mfa_required, not invalid_input)');
select is(tests.run(format($q$select public.fn_approve_pin_change(%L)$q$, gen_random_uuid())), 'P0001|mfa_required|', 'and before the lookup (unknown id -> mfa_required: no existence signal for aal1)');
select ok(jsonb_array_length(public.fn_list_pending_pin_changes()) >= 1, 'the delegate can still LIST (read needs no aal2)');
select tests.clear_auth();
select tests.authenticate_as((select admin2 from _f));   -- tenant_admin without any authenticator, aal1
select is(tests.run(format($q$select public.fn_approve_pin_change(%L)$q$, (select kitchen from _f))), 'P0001|mfa_required|', 'tenant_admin without an authenticator (aal1): approve -> mfa_required (no pass for users without a factor)');
select is(tests.run(format($q$select public.fn_reject_pin_change(%L)$q$, (select kitchen from _f))), 'P0001|mfa_required|', 'tenant_admin without an authenticator: reject -> mfa_required');
select tests.clear_auth();
select is((select pin_change_pending from public.profile_secrets where profile_id = (select kitchen from _f)), true, 'nothing was decided without aal2');
select is((select count(*)::int from public.audit_logs where event in ('auth.pin_change_approved', 'auth.pin_change_rejected') and (new_data ->> 'profile_id') = (select kitchen::text from _f)), 0, 'and nothing was audited as a decision');
select tests.aal2((select deleg from _f));   -- H1: the PIN delegate enrolled its OWN TOTP through GoTrue and holds an aal2 JWT
select is(tests.run(format($q$select public.fn_approve_pin_change(%L)$q$, (select kitchen from _f))), 'P0001|mfa_required|', 'PIN delegate on a self-enrolled aal2 session: approve -> mfa_required');
select is(tests.run(format($q$select public.fn_reject_pin_change(%L)$q$, (select kitchen from _f))), 'P0001|mfa_required|', 'PIN delegate on aal2: reject -> mfa_required');
select tests.clear_auth();
select is((select pin_change_pending from public.profile_secrets where profile_id = (select kitchen from _f)), true, 'nothing decided by the aal2 PIN delegate');
-- aal2 needs a LIVE authenticator (0028, L1): the token keeps its aal2 claim after the factor is removed, the database no longer honours it
select tests.add_verified_factor((select admin from _f));
select tests.aal2_token((select admin from _f));
select is(tests.run(format($q$select public.fn_approve_pin_change(%L)$q$, gen_random_uuid())), 'P0001|not_found|', 'aal2 token + verified factor: the gate is open (an unknown id reaches the lookup)');
select tests.clear_auth();
delete from auth.mfa_factors where user_id = (select admin from _f);   -- auth.mfa.unenroll from another session
select tests.aal2_token((select admin from _f));   -- another live token, still aal2
select is(tests.run(format($q$select public.fn_approve_pin_change(%L)$q$, (select kitchen from _f))), 'P0001|mfa_required|', 'aal2 token, authenticator removed: approve -> mfa_required');
select is(tests.run(format($q$select public.fn_reject_pin_change(%L)$q$, (select kitchen from _f))), 'P0001|mfa_required|', 'aal2 token, authenticator removed: reject -> mfa_required');
select is(tests.run('select public.fn_approve_pin_change(null)'), 'P0001|mfa_required|', 'still checked before validation (null id)');
select is(tests.run(format($q$select public.fn_approve_pin_change(%L)$q$, gen_random_uuid())), 'P0001|mfa_required|', 'and before the lookup (unknown id: no existence signal)');
select tests.clear_auth();
select tests.add_factor((select admin from _f), 'totp', 'unverified');
select tests.aal2_token((select admin from _f));
select is(tests.run(format($q$select public.fn_approve_pin_change(%L)$q$, (select kitchen from _f))), 'P0001|mfa_required|', 'only an unverified factor: approve -> mfa_required');
select is(tests.run(format($q$select public.fn_reject_pin_change(%L)$q$, (select kitchen from _f))), 'P0001|mfa_required|', 'only an unverified factor: reject -> mfa_required');
select tests.clear_auth();
select tests.aal2_token((select kitchen from _f));
select is(tests.run(format($q$select public.fn_approve_pin_change(%L)$q$, (select waiter from _f))), 'P0001|permission_denied|', 'permission is checked before aal2');
select tests.clear_auth();
update public.restaurants set status = 'past_due' where id = (select a from _f);
select tests.aal2_token((select admin from _f));
select is(tests.run(format($q$select public.fn_approve_pin_change(%L)$q$, (select kitchen from _f))), 'P0001|tenant_read_only|', 'tenant status is checked before aal2');
select tests.clear_auth();
update public.restaurants set status = (select v from _n where k = 'ts_status') where id = (select a from _f);
select is((select pin_change_pending from public.profile_secrets where profile_id = (select kitchen from _f)), true, 'every refusal left the request pending');
select is((select count(*)::int from public.audit_logs where event in ('auth.pin_change_approved', 'auth.pin_change_rejected') and (new_data ->> 'profile_id') = (select kitchen::text from _f)), 0, 'and audited no decision');
select tests.add_verified_factor((select admin from _f));
select tests.aal2_token((select admin from _f));
select is(tests.run(format($q$select public.fn_approve_pin_change(%L)$q$, gen_random_uuid())), 'P0001|not_found|', 're-enrolled: the same kind of token passes the gate again');
select tests.clear_auth();
select tests.aal2((select admin from _f));   -- the tenant_admin (password account) on an aal2 session
select is(public.fn_approve_pin_change((select kitchen from _f)) ->> 'status', 'approved', 'tenant_admin (password account) on an aal2 session: approve succeeds');
select tests.clear_auth();
select is((select not pin_change_pending and not must_change_pin from public.profile_secrets where profile_id = (select kitchen from _f)), true, 'kitchen staff released');
select is((select count(*)::int from public.audit_logs where event = 'auth.pin_change_approved' and actor_id = (select admin from _f) and (new_data ->> 'profile_id') = (select kitchen::text from _f)), 1, 'audited with the tenant_admin as actor');
select tests.aal2((select admin from _f));
select is(tests.run(format($q$select public.fn_approve_pin_change(%L)$q$, (select kitchen from _f))), 'P0001|not_found|', 'aal2 replay: not_found (idempotent-safe)');
select tests.clear_auth();
delete from public.role_station_access where role_id = (select id from public.roles where restaurant_id = (select a from _f) and name = 'HR Lead');
delete from public.role_permissions where role_id = (select id from public.roles where restaurant_id = (select a from _f) and name = 'HR Lead') and permission_id not in (select id from public.permissions where key in ('users.manage', 'users.view'));

-- ═════════ concurrency primitive: the decision locks the row ═════════
select ok((select prosrc ~* 'for update of ps' from pg_proc where proname = 'fn_decide_pin_change' and pronamespace = 'public'::regnamespace), 'approve/reject lock the secret row (FOR UPDATE) before deciding');
select ok((select prosrc ~* 'for update' from pg_proc where proname = 'fn_complete_forced_pin_change' and pronamespace = 'public'::regnamespace), 'and so does the completion');

-- ═════════ admin exempt ═════════
select tests.authenticate_as((select admin from _f));
select is(public.fn_get_session_context() ->> 'pin_change_status', 'none', 'tenant_admin: status none');
select is((public.fn_get_session_context() ->> 'pin_length')::int, 4, 'pin_length present (4)');
select ok(public.has_permission('users.manage'), 'admin keeps every permission');
select tests.clear_auth();
alter table public.profile_secrets disable trigger trg_guard_profile_secret;   -- owner-only, rolled back: simulate a corrupted row
insert into public.profile_secrets (profile_id, restaurant_id, pin_hash, pin_change_pending, pin_change_requested_at)
  values ((select admin from _f), (select a from _f), 'x', true, now());
alter table public.profile_secrets enable trigger trg_guard_profile_secret;
select ok(not public.fn_pin_restricted((select admin from _f)), 'fn_pin_restricted: tenant_admin exempt even with a corrupted pending row');
select ok(public.fn_pin_restricted((select waiter from _f)) is false, 'fn_pin_restricted: a free staff member is not restricted');
select tests.authenticate_as((select admin from _f));
select ok(public.has_permission('users.manage') and cardinality(public.current_station_ids()) > 0 and public.fn_get_session_context() ->> 'pin_change_status' = 'none'
          and jsonb_array_length(public.fn_get_session_context() -> 'permissions') > 10, 'a corrupted pending row locks no admin out (permissions, stations, context)');
select tests.clear_auth();
delete from public.profile_secrets where profile_id = (select admin from _f);

-- ═════════ no secrets anywhere ═════════
select ok(not exists (select 1 from public.audit_logs where event like 'auth.pin_change_%' and new_data::text ~* '(pin_hash|digest|token|secret|[0-9a-f]{64}|\$2[aby]\$)'), 'pin_change audit rows carry no secret');
select ok(not exists (select 1 from public.user_notifications where kind like 'security.pin_change_%' and payload::text ~* '(pin_hash|digest|token|secret|[0-9a-f]{64}|\$2[aby]\$)'), 'pin_change notifications carry no secret');
select ok(not exists (select 1 from public.audit_logs where event like 'auth.pin_%' and (new_data::text ~ '(2749|5183|8264|9146|3175|3856|7391|6428|834921)')), 'and no PIN value');
select ok(not (select string_agg(prosrc, ' ') ~* 'pin_hash\s*,\s*''' from pg_proc where proname in ('fn_list_pending_pin_changes', 'fn_get_session_context') and pronamespace = 'public'::regnamespace), 'neither list nor context read pin_hash');

-- ═════════ docs/architecture/deploy-checklist.md item 17: the lockout query (keep the body identical to the document) ═════════
create function tests.lockout_slugs() returns text language sql stable as $f$
  select string_agg(q.slug, ',' order by q.slug) from (
    select r.id, r.slug
    from public.restaurants r
    where not exists (
      select 1
      from public.profiles p
      join public.roles ro on ro.id = p.role_id and ro.restaurant_id = p.restaurant_id and ro.system_key = 'tenant_admin'
      join auth.mfa_factors f on f.user_id = p.id and f.status = 'verified' and f.factor_type = 'totp'
      where p.restaurant_id = r.id and p.is_active)
  ) q where q.slug in ('central-cafe', 'second-cafe') $f$;
grant execute on function tests.lockout_slugs() to public;
delete from auth.mfa_factors;
select is(tests.lockout_slugs(), 'central-cafe,second-cafe', 'lockout query: tenants whose tenant_admins have no verified TOTP factor are returned');
select tests.add_verified_factor((select admin from _f));
select is(tests.lockout_slugs(), 'second-cafe', 'a verified TOTP factor on one tenant_admin removes that tenant');
select tests.add_factor((select b_admin from _f), 'totp', 'unverified');
select tests.add_verified_factor((select b_waiter from _f));
select is(tests.lockout_slugs(), 'second-cafe', 'an unverified factor, or a verified one held by a non-admin, does not count');
select tests.add_verified_factor((select b_admin from _f));
select is(tests.lockout_slugs(), null, 'once every tenant has a verified TOTP admin: no rows');
delete from auth.mfa_factors;

select * from finish();
rollback;
