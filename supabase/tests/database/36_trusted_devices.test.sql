-- Trusted devices (migration 0032, owner decision 2026-10-09): the TOTP code is asked on the first sign-in from a new device,
-- then the device is trusted for 30 days (server-recorded, revocable); very sensitive actions still need a code of the last 12 h.
-- No MFA opt-out anywhere (owner decision 7).
begin;
select plan(58);

create temp table _f on commit drop as
select tests.tenant_id('central-cafe') a, tests.tenant_id('second-cafe') b,
       '00000000-0000-4000-8000-0000000000c1'::uuid su,
       '00000000-0000-4000-8000-0000000000e1'::uuid su2,
       tests.user_id('selam', 'central-cafe') a_admin, tests.user_id('yonas', 'central-cafe') a_waiter,
       tests.user_id('owner', 'second-cafe') b_admin,
       (select id from public.plans where name = 'Growth') growth;
grant all on _f to public;
create temp table _c (k text primary key, v text);
grant all on _c to public;

-- a session as the client would present it: aal, a session id, and (optionally) a TOTP verification p_totp_age ago
create function tests.session(p_user uuid, p_aal text, p_sid uuid, p_totp_age interval default null) returns void language plpgsql as $$
begin
  perform tests.authenticate_as(p_user);
  perform set_config('request.jwt.claims', json_build_object(
    'sub', p_user, 'role', 'authenticated', 'aud', 'authenticated', 'aal', p_aal, 'session_id', p_sid,
    'amr', case when p_totp_age is null then json_build_array(json_build_object('method', 'password', 'timestamp', extract(epoch from now())::bigint))
                else json_build_array(json_build_object('method', 'password', 'timestamp', extract(epoch from now() - p_totp_age)::bigint),
                                      json_build_object('method', 'totp', 'timestamp', extract(epoch from now() - p_totp_age)::bigint)) end)::text, true);
end $$;
grant execute on function tests.session(uuid, text, uuid, interval) to public;

select tests.create_auth_user((select su2 from _f), 'second.super@cafeos.example.com');
insert into public.platform_admins (id, full_name, role, is_active) select su2, 'Second Super', 'platform_super_admin', true from _f;
select tests.add_verified_factor(su) from _f;
select tests.add_verified_factor(su2) from _f;
select tests.add_verified_factor(a_admin) from _f;
select tests.add_verified_factor(b_admin) from _f;

-- ═════════ no opt-out ═════════
select set_config('app.platform_mfa_required', 'off', true);
select tests.session((select su from _f), 'aal1', '10000000-0000-4000-8000-000000000001');
select is(tests.run('select public.fn_platform_list_tenants()'), 'P0001|mfa_required|', 'aal1, no trusted device: mfa_required (the old opt-out GUC is ignored)');
select ok(not public.is_platform_super_admin(), 'and the RLS helpers refuse too');
select is((select count(*)::int from public.restaurants), 0, 'no tenant row visible');
select tests.clear_auth();

-- ═════════ trust: needs a TOTP code of the last 10 minutes ═════════
select tests.session((select su from _f), 'aal1', '10000000-0000-4000-8000-000000000001');
select is(tests.run($q$select public.fn_trust_device('Laptop')$q$), 'P0001|step_up_required|', 'aal1 cannot trust a device');
select tests.clear_auth();
select tests.session((select su from _f), 'aal2', '10000000-0000-4000-8000-000000000002', interval '2 hours');
select is(tests.run($q$select public.fn_trust_device('Laptop')$q$), 'P0001|step_up_required|', 'a code of 2 hours ago is not "just entered"');
select tests.clear_auth();
select tests.session((select su from _f), 'aal2', '10000000-0000-4000-8000-000000000003', interval '1 minute');
insert into _c select 'tok', public.fn_trust_device(E'Chrome \n on Ubuntu') ->> 'token';
select ok((select v from _c where k = 'tok') ~ '^[0-9a-f]{64}$', 'the raw token is returned once (32 random bytes, hex)');
select is(tests.run('select count(*) from public.trusted_devices'), '42501|permission denied for table trusted_devices|', 'no client table privilege (RPC-only)');
select is((select jsonb_array_length(public.fn_list_my_trusted_devices())), 1, 'listed');
select is((select public.fn_list_my_trusted_devices() -> 0 ->> 'label'), 'Chrome  on Ubuntu', 'label stripped of control characters');
select is((select (public.fn_list_my_trusted_devices() -> 0 ->> 'current')::boolean), true, 'the trusting session is attested too');
select ok((select public.fn_list_my_trusted_devices()::text) !~ (select v from _c where k = 'tok'), 'the token never comes back');
select tests.clear_auth();
select is((select token_hash from public.trusted_devices where user_id = (select su from _f)),
          encode(extensions.digest(convert_to((select v from _c where k = 'tok'), 'UTF8'), 'sha256'), 'hex'), 'only the sha256 is stored');
select is((select (expires_at - created_at) from public.trusted_devices where user_id = (select su from _f)), interval '30 days', 'trusted for 30 days');
select is((select count(*)::int from public.admin_audit_log where action = 'device.trusted' and platform_admin_id = (select su from _f)), 1, 'audited (platform trail)');

-- ═════════ a later password-only sign-in on that device ═════════
select tests.session((select su from _f), 'aal1', '10000000-0000-4000-8000-000000000004');
select is(tests.run('select public.fn_platform_list_tenants()'), 'P0001|mfa_required|', 'before the device check: mfa_required');
select is((select public.fn_check_trusted_device(repeat('0', 64)) ->> 'trusted'), 'false', 'unknown token: not trusted (no detail)');
select is((select public.fn_check_trusted_device('not-a-token') ->> 'trusted'), 'false', 'malformed token: not trusted');
select is((select public.fn_check_trusted_device((select v from _c where k = 'tok')) ->> 'trusted'), 'true', 'the stored token: trusted');
select is(tests.run('select jsonb_typeof(public.fn_platform_list_tenants())'), 'ok:1', 'no TOTP step on this session: the platform guard passes');
select ok(public.is_platform_super_admin(), 'and the RLS helpers too');
select is(tests.run(format($q$select public.fn_platform_change_plan(%L, %L, 'upgrade')$q$, (select b from _f), (select growth from _f))), 'P0001|step_up_required|',
          'a very sensitive action still asks the code (plan change)');
select is(tests.run(format($q$select public.fn_platform_cancel_tenant(%L, 'closing', 'second-cafe')$q$, (select b from _f))), 'P0001|step_up_required|', 'cancel tenant too');
select is(tests.run(format($q$select public.fn_platform_restore_tenant(%L, 'reopen', 'second-cafe')$q$, (select b from _f))), 'P0001|step_up_required|', 'restore tenant too');
select tests.clear_auth();
select tests.session((select su from _f), 'aal1', '10000000-0000-4000-8000-000000000005');
select is(tests.run('select public.fn_platform_list_tenants()'), 'P0001|mfa_required|', 'the attestation belongs to ONE session: another session must check again');
select tests.clear_auth();
select tests.session((select su2 from _f), 'aal1', '10000000-0000-4000-8000-000000000006');
select is((select public.fn_check_trusted_device((select v from _c where k = 'tok')) ->> 'trusted'), 'false', 'another account cannot use the token');
select is(tests.run('select public.fn_platform_list_tenants()'), 'P0001|mfa_required|', 'and stays untrusted');
select tests.clear_auth();
select tests.session((select su from _f), 'aal1', null);
select is((select public.fn_check_trusted_device((select v from _c where k = 'tok')) ->> 'trusted'), 'false', 'a token without a session id is never attested');
select tests.clear_auth();

-- ═════════ the 12 h rule for very sensitive actions ═════════
select tests.session((select su from _f), 'aal2', '10000000-0000-4000-8000-000000000007', interval '13 hours');
select is(tests.run(format($q$select public.fn_platform_change_plan(%L, %L, 'upgrade')$q$, (select b from _f), (select growth from _f))), 'P0001|step_up_required|',
          'aal2 session whose code is 13 h old: step_up_required');
select tests.clear_auth();
select tests.session((select su from _f), 'aal2', '10000000-0000-4000-8000-000000000008', interval '11 hours');
select isnt(tests.run(format($q$select public.fn_platform_change_plan(%L, %L, 'upgrade')$q$, (select b from _f), (select growth from _f))), 'P0001|step_up_required|',
          'a code of 11 h ago is enough');
select tests.clear_auth();

-- ═════════ expiry, factor removal, revocation ═════════
update public.trusted_devices set expires_at = now() - interval '1 second', created_at = now() - interval '30 days' where user_id = (select su from _f);
select tests.session((select su from _f), 'aal1', '10000000-0000-4000-8000-000000000004');
select is(tests.run('select public.fn_platform_list_tenants()'), 'P0001|mfa_required|', 'expired device: the attested session loses it at once');
select is((select public.fn_check_trusted_device((select v from _c where k = 'tok')) ->> 'trusted'), 'false', 'and cannot be re-checked');
select tests.clear_auth();
update public.trusted_devices set created_at = now() - interval '29 days', expires_at = now() + interval '1 day' where user_id = (select su from _f);
delete from auth.mfa_factors where user_id = (select su from _f);
select tests.session((select su from _f), 'aal1', '10000000-0000-4000-8000-000000000004');
select is(tests.run('select public.fn_platform_list_tenants()'), 'P0001|mfa_required|', 'the factor it was trusted with is gone: untrusted (no trigger on auth tables needed)');
select tests.clear_auth();
select tests.add_verified_factor(su) from _f;
select tests.session((select su from _f), 'aal1', '10000000-0000-4000-8000-000000000004');
select is(tests.run('select public.fn_platform_list_tenants()'), 'P0001|mfa_required|', 'a NEW factor does not revive a device trusted with the old one');
select tests.clear_auth();

-- a fresh device for the next checks
select tests.session((select su from _f), 'aal2', '10000000-0000-4000-8000-000000000009', interval '1 minute');
insert into _c select 'tok2', public.fn_trust_device('Phone') ->> 'token';
insert into _c select 'dev2', public.fn_list_my_trusted_devices() -> 0 ->> 'id';
select tests.clear_auth();
select tests.session((select su from _f), 'aal1', '10000000-0000-4000-8000-00000000000a');
select is((select public.fn_check_trusted_device((select v from _c where k = 'tok2')) ->> 'trusted'), 'true', 'new device trusted');
select is((select public.fn_revoke_trusted_device((select v::uuid from _c where k = 'dev2')) ->> 'changed'), 'true', 'the owner revokes it');
select is(tests.run('select public.fn_platform_list_tenants()'), 'P0001|mfa_required|', 'revocation ends the attested session at once');
select is((select public.fn_revoke_trusted_device((select v::uuid from _c where k = 'dev2')) ->> 'changed'), 'false', 'replay: no-op');
select tests.clear_auth();

-- ═════════ tenant portal ═════════
select tests.session((select a_admin from _f), 'aal2', '20000000-0000-4000-8000-000000000001', interval '1 minute');
insert into _c select 'atok', public.fn_trust_device('Front desk') ->> 'token';
insert into _c select 'adev', public.fn_list_my_trusted_devices() -> 0 ->> 'id';
select tests.clear_auth();
select tests.session((select a_admin from _f), 'aal1', '20000000-0000-4000-8000-000000000002');
select is(tests.run($q$select public.fn_create_role('{"name": "Trusted Role"}')$q$), 'P0001|mfa_required|', 'enrolled tenant admin on aal1, untrusted: mfa_required');
select is((select public.fn_check_trusted_device((select v from _c where k = 'atok')) ->> 'trusted'), 'true', 'tenant admin device trusted');
select is(tests.run($q$select public.fn_create_role('{"name": "Trusted Role"}')$q$), 'ok:1', 'the trusted session works without a TOTP step');
select is(tests.run(format($q$select public.fn_update_role_permissions((select id from public.roles where name = 'Trusted Role' and restaurant_id = %L), array['orders.view'], '{}')$q$, (select a from _f))),
          'P0001|step_up_required|', 'the role matrix still asks the code');
select is((select count(*)::int from public.audit_logs where event = 'device.trusted' and restaurant_id = (select a from _f)), 1, 'audited in the tenant trail');
select tests.clear_auth();
-- the super admin's device would never satisfy a tenant gate, nor the reverse (scope), and admins only reach their own portal
select tests.aal2((select b_admin from _f));
select is(tests.run(format($q$select public.fn_revoke_trusted_device(%L)$q$, (select v from _c where k = 'adev'))), 'P0001|not_found|', 'another tenant''s admin: not_found');
select is(tests.run(format($q$select public.fn_list_user_trusted_devices(%L)$q$, (select a_admin from _f))), 'P0001|not_found|', 'nor list them');
select tests.clear_auth();
select tests.aal2((select su from _f));
select is(tests.run(format($q$select public.fn_revoke_trusted_device(%L)$q$, (select v from _c where k = 'adev'))), 'P0001|not_found|', 'the super admin cannot reach a tenant user''s device');
select is(tests.run(format($q$select public.fn_revoke_all_trusted_devices(%L)$q$, (select a_admin from _f))), 'P0001|not_found|', 'nor revoke all of them');
select tests.clear_auth();
select tests.authenticate_as((select a_waiter from _f));
select is(tests.run(format($q$select public.fn_revoke_trusted_device(%L)$q$, (select v from _c where k = 'adev'))), 'P0001|permission_denied|', 'staff cannot revoke an admin''s device');
select is(tests.run($q$select public.fn_trust_device('x')$q$), 'P0001|permission_denied|', 'PIN staff cannot trust a device');
select tests.clear_auth();

-- ═════════ revoke with the account ═════════
select tests.aal2((select su2 from _f));
insert into _c select 'tok3', public.fn_trust_device('Ops laptop') ->> 'token';
select tests.clear_auth();
select tests.aal2((select su from _f));
select is((select jsonb_array_length(public.fn_list_user_trusted_devices((select su2 from _f)))), 1, 'a super admin lists another platform admin''s devices');
select lives_ok(format($q$select public.fn_platform_set_admin_active(%L, false, 'left the company')$q$, (select su2 from _f)), 'deactivate that platform admin');
select tests.clear_auth();
select is((select revoke_reason from public.trusted_devices where user_id = (select su2 from _f)), 'admin_disabled', 'its devices are revoked with it');
insert into public.trusted_devices (user_id, scope, factor_id, token_hash, expires_at)
  select a_waiter, 'tenant', gen_random_uuid(), repeat('a', 64), now() + interval '30 days' from _f;
update public.profile_secrets set must_change_pin = true where profile_id = (select a_waiter from _f);
select is((select revoke_reason from public.trusted_devices where user_id = (select a_waiter from _f)), 'pin_reset', 'a PIN reset revokes the devices');
update public.trusted_devices set revoked_at = null, revoke_reason = null where user_id = (select a_waiter from _f);
update public.profiles set is_active = false where id = (select a_waiter from _f);
select is((select revoke_reason from public.trusted_devices where user_id = (select a_waiter from _f)), 'user_disabled', 'deactivating a user revokes the devices');

-- ═════════ at most 10 live devices ═════════
select tests.session((select a_admin from _f), 'aal2', '20000000-0000-4000-8000-000000000003', interval '1 minute');
select public.fn_trust_device('d' || g) from generate_series(1, 11) g;
select is((select jsonb_array_length(public.fn_list_my_trusted_devices())), 10, 'at most 10 live devices');
select tests.clear_auth();
select is((select count(*)::int from public.trusted_devices where user_id = (select a_admin from _f) and revoke_reason = 'limit'), 2, 'the oldest are revoked (reason limit)');

select tests.authenticate_as((select a_admin from _f));
select is(tests.run('select public.fn_revoke_all_trusted_devices()'), 'ok:1', 'sign out of every trusted device (self, any aal)');
select is((select jsonb_array_length(public.fn_list_my_trusted_devices())), 0, 'none left');
select tests.clear_auth();
select tests.as_anon();
select is(tests.run($q$select public.fn_check_trusted_device('x')$q$), '42501|permission denied for function fn_check_trusted_device|', 'anon: no access');
select tests.clear_auth();

select * from finish();
rollback;
