-- Phase 3B: invitation of a Tenant Admin (migration 0030). The tenant-admin-invite Edge Function runs
--   fn_prepare_tenant_admin_invitation (caller) -> auth.admin.inviteUserByEmail (service role) -> fn_attach_tenant_admin_invitation
-- and the invitee binds itself with fn_accept_tenant_admin_invitation. This file plays the SQL side of every step:
-- lifecycle, validation, rate limit, replay, expiry, revoke, cross-tenant, cross-portal, audit.
begin;
select plan(59);

create temp table _f on commit drop as
select tests.tenant_id('central-cafe') a, tests.tenant_id('second-cafe') b,
       '00000000-0000-4000-8000-0000000000c1'::uuid su,
       tests.user_id('selam', 'central-cafe') a_admin, tests.user_id('yonas', 'central-cafe') a_waiter,
       tests.user_id('owner', 'second-cafe') b_admin,
       (select id from public.plans where name = 'Growth') growth,
       '00000000-0000-4000-8000-0000000000d1'::uuid invitee,
       '00000000-0000-4000-8000-0000000000d2'::uuid invitee2;
grant all on _f to public;
create temp table _c (k text primary key, v text);
grant all on _c to public;
-- what inviteUserByEmail would create: an UNCONFIRMED auth user with the invited e-mail
create function tests.invited_user(p_id uuid, p_email text) returns void language plpgsql as $$
begin
  perform tests.create_auth_user(p_id, p_email);
  update auth.users set email_confirmed_at = null where id = p_id;
end $$;
grant execute on function tests.invited_user(uuid, text) to public;

-- ═════════ platform path: a fresh tenant and its first Tenant Admin ═════════
select tests.aal2((select su from _f));
insert into _c select 'rid', public.fn_platform_create_tenant('Fresh Cafe', 'fresh-cafe', (select growth from _f)) ->> 'restaurant_id';
select is(tests.run($q$select public.fn_prepare_tenant_admin_invitation(null, 'new.owner@fresh.example.com', 'Almaz', null, null, 'almaz')$q$), 'P0001|invalid_input|restaurant_id', 'the platform names the tenant');
select is(tests.run('select public.fn_prepare_tenant_admin_invitation(gen_random_uuid(), $$new.owner@fresh.example.com$$, $$Almaz$$, null, null, $$almaz$$)'), 'P0001|not_found|', 'unknown tenant: not_found');
select is(tests.run(format($q$select public.fn_prepare_tenant_admin_invitation(%L, 'not-an-email', 'Almaz', null, null, 'almaz')$q$, (select v from _c where k = 'rid'))), 'P0001|invalid_input|email', 'e-mail format');
select is(tests.run(format($q$select public.fn_prepare_tenant_admin_invitation(%L, 'x@fresh-cafe.staff.cafeos.invalid', 'Almaz', null, null, 'almaz')$q$, (select v from _c where k = 'rid'))), 'P0001|invalid_input|email', 'never a synthetic .invalid identity');
select is(tests.run(format($q$select public.fn_prepare_tenant_admin_invitation(%L, 'new.owner@fresh.example.com', '', null, null, 'almaz')$q$, (select v from _c where k = 'rid'))), 'P0001|invalid_input|first_name', 'first name required');
select is(tests.run(format($q$select public.fn_prepare_tenant_admin_invitation(%L, 'new.owner@fresh.example.com', 'Almaz', null, null, 'A B')$q$, (select v from _c where k = 'rid'))), 'P0001|invalid_input|username', 'username format');
select is(tests.run(format($q$select public.fn_prepare_tenant_admin_invitation(%L, 'selam@centralcafe.example.com', 'Selam', null, null, 'selam')$q$, (select v from _c where k = 'rid'))), 'P0001|email_in_use|', 'an existing account (another tenant''s admin) is never re-bound');
select is(tests.run(format($q$select public.fn_prepare_tenant_admin_invitation(%L, 'admin@cafeos.example.com', 'Plat', null, null, 'plat')$q$, (select v from _c where k = 'rid'))), 'P0001|email_in_use|', 'nor a platform admin''s account (one account, one portal)');
insert into _c select 'inv', public.fn_prepare_tenant_admin_invitation((select v::uuid from _c where k = 'rid'), ' New.Owner@Fresh.Example.com ', 'Almaz', 'Kebede', null, 'Almaz') ->> 'invitation_id';
select tests.clear_auth();
select is((select email || '/' || username || '/' || status || '/' || invited_by_type from public.tenant_admin_invitations where id = (select v::uuid from _c where k = 'inv')),
          'new.owner@fresh.example.com/almaz/pending/platform_admin', 'invitation reserved (e-mail and username normalised)');
select tests.aal2((select su from _f));
select is(tests.run(format($q$select public.fn_prepare_tenant_admin_invitation(%L, 'new.owner@fresh.example.com', 'Almaz', null, null, 'almaz2')$q$, (select v from _c where k = 'rid'))), 'P0001|email_in_use|', 'replay: one pending invitation per e-mail');
select is(tests.run(format($q$select public.fn_prepare_tenant_admin_invitation(%L, 'other@fresh.example.com', 'Other', null, null, 'almaz')$q$, (select v from _c where k = 'rid'))), 'P0001|username_taken|', 'the username is reserved by the pending invitation');
select is((select platform_admin_id from public.admin_audit_log where action = 'tenant.admin_invited' and restaurant_id = (select v::uuid from _c where k = 'rid')), (select su from _f), 'admin_audit_log: tenant.admin_invited by the super admin');
select is((select (public.fn_platform_get_tenant((select v::uuid from _c where k = 'rid')) -> 'invitations' -> 0 ->> 'state')), 'pending', 'the tenant detail shows the pending invitation');
select is((select (public.fn_platform_get_tenant((select v::uuid from _c where k = 'rid')) -> 'usage' ->> 'pending_invitations')::int), 1, 'and counts it');
select is(tests.run(format($q$select public.fn_attach_tenant_admin_invitation(%L, %L)$q$, (select v from _c where k = 'inv'), (select invitee from _f))), '42501|permission denied for function fn_attach_tenant_admin_invitation|', 'binding the Auth user is service_role only');
select tests.clear_auth();

-- ═════════ the Edge Function's service-role steps ═════════
select tests.invited_user((select invitee from _f), 'new.owner@fresh.example.com');
select tests.invited_user((select invitee2 from _f), 'someone.else@fresh.example.com');
select tests.authenticate_as_service_role();
select is(tests.run(format($q$select public.fn_attach_tenant_admin_invitation(%L, %L)$q$, (select v from _c where k = 'inv'), (select invitee2 from _f))), 'P0001|invalid_auth_user|', 'attach refuses an Auth user with another e-mail');
select is(tests.run(format($q$select public.fn_attach_tenant_admin_invitation(%L, %L)$q$, (select v from _c where k = 'inv'), (select a_admin from _f))), 'P0001|invalid_auth_user|', 'or an existing tenant profile');
select is((select public.fn_attach_tenant_admin_invitation((select v::uuid from _c where k = 'inv'), (select invitee from _f)) ->> 'attached'), 'true', 'attach the invited Auth user');
select is((select public.fn_attach_tenant_admin_invitation((select v::uuid from _c where k = 'inv'), (select invitee from _f)) ->> 'attached'), 'true', 'replay of the same attach is idempotent');
select is(tests.run(format($q$select public.fn_attach_tenant_admin_invitation(%L, %L)$q$, (select v from _c where k = 'inv'), (select invitee2 from _f))), 'P0001|invalid_state|already_attached', 'never re-pointed');
select is((select public.fn_record_tenant_admin_invitation_sent((select v::uuid from _c where k = 'inv')) ->> 'send_count'), '1', 'the successful first send is recorded (send budget)');
select tests.clear_auth();

-- ═════════ resend (rate limited) ═════════
select tests.aal2((select su from _f));
select is(tests.run(format($q$select public.fn_prepare_tenant_admin_invitation_resend(%L)$q$, (select v from _c where k = 'inv'))), 'P0001|invite_rate_limited|', 'a resend right after the send is rate limited (60 s)');
select tests.clear_auth();
update public.tenant_admin_invitations set last_attempt_at = now() - interval '2 minutes' where id = (select v::uuid from _c where k = 'inv');
select tests.aal2((select su from _f));
select is((select public.fn_prepare_tenant_admin_invitation_resend((select v::uuid from _c where k = 'inv')) ->> 'email'), 'new.owner@fresh.example.com', 'resend after the gap');
select tests.clear_auth();
select tests.authenticate_as_service_role();
select is((select public.fn_plan_tenant_admin_invitation_delivery((select v::uuid from _c where k = 'inv')) ->> 'mode'), 'reinvite', 'delivery plan: the attached, unconfirmed user is re-invited');
select lives_ok($q$select public.fn_record_tenant_admin_invitation_sent((select v::uuid from _c where k = 'inv'))$q$, 'the successful resend is recorded');
select tests.clear_auth();
select is((select send_count from public.tenant_admin_invitations where id = (select v::uuid from _c where k = 'inv')), 2, 'send counter');
update public.tenant_admin_invitations set last_attempt_at = now() - interval '2 minutes', send_count = 5 where id = (select v::uuid from _c where k = 'inv');
select tests.aal2((select su from _f));
select is(tests.run(format($q$select public.fn_prepare_tenant_admin_invitation_resend(%L)$q$, (select v from _c where k = 'inv'))), 'P0001|invite_rate_limited|', 'at most 5 sends');
select tests.clear_auth();

-- ═════════ acceptance: the invitee binds itself ═════════
select tests.authenticate_as((select invitee2 from _f));
select is((select public.fn_get_my_invitation()), null::jsonb, 'somebody else sees no invitation');
select is(tests.run('select public.fn_accept_tenant_admin_invitation()'), 'P0001|not_found|', 'and cannot accept one');
select tests.clear_auth();
select tests.authenticate_as((select invitee from _f));
select is((select public.fn_get_my_invitation() -> 'restaurant' ->> 'slug'), 'fresh-cafe', 'the invitee sees where it is invited (name / slug only)');
select is((select public.fn_get_session_context()), null::jsonb, 'before acceptance the invitee has no tenant identity');
select is(tests.run('select public.fn_accept_tenant_admin_invitation()'), 'P0001|owner_email_unconfirmed|', 'the e-mail must be confirmed (the invite link does that)');
select tests.clear_auth();
update auth.users set email_confirmed_at = now() where id = (select invitee from _f);
select tests.authenticate_as((select invitee from _f));
select is((select public.fn_accept_tenant_admin_invitation() ->> 'slug'), 'fresh-cafe', 'accepted');
select is((select public.fn_get_session_context() -> 'role' ->> 'system_key'), 'tenant_admin', 'the invitee is now the tenant''s tenant_admin');
select ok(public.is_tenant_admin() and public.current_restaurant_id() = (select v::uuid from _c where k = 'rid'), 'bound to exactly that tenant');
select is(tests.run('select public.fn_accept_tenant_admin_invitation()'), 'P0001|not_found|', 'replay: nothing left to accept');
select tests.clear_auth();
select is((select auth_method from public.profiles where id = (select invitee from _f)), 'password', 'password login (never PIN)');
select is((select count(*)::int from public.profile_secrets where profile_id = (select invitee from _f)), 0, 'no PIN secret');
select is((select status from public.tenant_admin_invitations where id = (select v::uuid from _c where k = 'inv')), 'accepted', 'invitation accepted');
select is((select count(*)::int from public.audit_logs where event = 'tenant_admin.invitation_accepted' and actor_id = (select invitee from _f)), 1, 'tenant audit: accepted by the invitee');

-- ═════════ tenant path: the tenant_admin invites a co-admin ═════════
select tests.authenticate_as((select a_admin from _f));
select is(tests.run($q$select public.fn_prepare_tenant_admin_invitation(null, 'co.admin@centralcafe.example.com', 'Co', null, null, 'coadmin')$q$), 'P0001|mfa_required|', 'a tenant_admin needs aal2 to invite');
select tests.clear_auth();
select tests.aal2((select a_admin from _f));
select is(tests.run(format($q$select public.fn_prepare_tenant_admin_invitation(%L, 'co.admin@centralcafe.example.com', 'Co', null, null, 'coadmin')$q$, (select b from _f))), 'P0001|permission_denied|', 'never into another tenant');
insert into _c select 'co', public.fn_prepare_tenant_admin_invitation(null, 'co.admin@centralcafe.example.com', 'Co', null, null, 'coadmin') ->> 'invitation_id';
select is((select public.fn_list_tenant_admin_invitations() -> 0 ->> 'restaurant_id')::uuid, (select a from _f), 'invited into the caller''s own tenant');
select is((select jsonb_array_length(public.fn_list_tenant_admin_invitations())), 1, 'the tenant lists its own invitations only');
select is(tests.run(format($q$select public.fn_prepare_tenant_admin_invitation(null, 'x@centralcafe.example.com', 'X', null, null, %L)$q$, 'selam')), 'P0001|username_taken|', 'existing username refused');
select tests.clear_auth();
select tests.aal2((select b_admin from _f));
select is(tests.run(format($q$select public.fn_revoke_tenant_admin_invitation(%L)$q$, (select v from _c where k = 'co'))), 'P0001|not_found|', 'another tenant cannot revoke it (not_found)');
select is(tests.run(format($q$select public.fn_prepare_tenant_admin_invitation_resend(%L)$q$, (select v from _c where k = 'co'))), 'P0001|not_found|', 'nor resend it');
select is((select jsonb_array_length(public.fn_list_tenant_admin_invitations())), 0, 'nor list it');
select tests.clear_auth();
select tests.authenticate_as((select a_waiter from _f));
select is(tests.run($q$select public.fn_prepare_tenant_admin_invitation(null, 'w@centralcafe.example.com', 'W', null, null, 'wwww')$q$), 'P0001|permission_denied|', 'staff cannot invite admins');
select is(tests.run(format($q$select public.fn_revoke_tenant_admin_invitation(%L)$q$, (select v from _c where k = 'co'))), 'P0001|permission_denied|', 'nor revoke');
select tests.clear_auth();

-- ═════════ revoke / expiry ═════════
select tests.invited_user('00000000-0000-4000-8000-0000000000d3', 'co.admin@centralcafe.example.com');
select tests.authenticate_as_service_role();
select public.fn_attach_tenant_admin_invitation((select v::uuid from _c where k = 'co'), '00000000-0000-4000-8000-0000000000d3');
select tests.clear_auth();
select tests.aal2((select a_admin from _f));
select is((select public.fn_revoke_tenant_admin_invitation((select v::uuid from _c where k = 'co')) - 'invitation_id'), '{"status": "revoked", "changed": true}'::jsonb,
          'revoke: the caller learns nothing about the Auth side');
select is((select public.fn_revoke_tenant_admin_invitation((select v::uuid from _c where k = 'co')) ->> 'changed'), 'false', 'replay: no-op');
select tests.clear_auth();
select tests.authenticate_as_service_role();
select is((select public.fn_tenant_admin_invitation_cleanup_user((select v::uuid from _c where k = 'co')) ->> 'cleanup_user_id'), '00000000-0000-4000-8000-0000000000d3',
          'the service side is handed the never-confirmed Auth user for cleanup');
select tests.clear_auth();
update auth.users set email_confirmed_at = now() where id = '00000000-0000-4000-8000-0000000000d3';
select tests.authenticate_as('00000000-0000-4000-8000-0000000000d3');
select is(tests.run('select public.fn_accept_tenant_admin_invitation()'), 'P0001|not_found|', 'a revoked invitation cannot be accepted');
select tests.clear_auth();
-- expiry
select tests.aal2((select a_admin from _f));
insert into _c select 'exp', public.fn_prepare_tenant_admin_invitation(null, 'late@centralcafe.example.com', 'Late', null, null, 'late') ->> 'invitation_id';
select tests.clear_auth();
select tests.invited_user('00000000-0000-4000-8000-0000000000d4', 'late@centralcafe.example.com');
update auth.users set email_confirmed_at = now() where id = '00000000-0000-4000-8000-0000000000d4';
update public.tenant_admin_invitations set auth_user_id = '00000000-0000-4000-8000-0000000000d4', expires_at = now() - interval '1 minute' where id = (select v::uuid from _c where k = 'exp');
select tests.authenticate_as('00000000-0000-4000-8000-0000000000d4');
select is(tests.run('select public.fn_accept_tenant_admin_invitation()'), 'P0001|invitation_expired|', 'an expired invitation cannot be accepted');
select tests.clear_auth();
select tests.authenticate_as_service_role();
select is((select public.fn_abort_tenant_admin_invitation((select v::uuid from _c where k = 'exp')) ->> 'status'), 'revoked', 'the Edge Function''s compensation (send failed) releases the reservation');
select tests.clear_auth();
select is((select count(*)::int from public.audit_logs where event = 'tenant_admin.invitation_failed'), 1, 'and is audited');

-- ═════════ the tenant is suspended / cancelled ═════════
select tests.aal2((select su from _f));
select lives_ok(format($q$select public.fn_suspend_tenant(%L, 'unpaid invoice')$q$, (select v from _c where k = 'rid')), 'suspend the fresh tenant');
select is(tests.run(format($q$select public.fn_prepare_tenant_admin_invitation(%L, 'later@fresh.example.com', 'Later', null, null, 'later')$q$, (select v from _c where k = 'rid'))), 'P0001|tenant_suspended|', 'no invitation into a suspended tenant');
select tests.clear_auth();

select * from finish();
rollback;
