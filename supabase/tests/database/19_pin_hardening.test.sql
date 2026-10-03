-- SM3/L2: PIN pepper contract, escalating non-resetting lock, uniform answers, admin reset.
-- (The concurrent 60-guess race is scripts/db/race-tests.sh.)
begin;
select plan(25);

create temp table _f on commit drop as
select tests.user_id('hanna', 'central-cafe') hanna, tests.user_id('yonas', 'central-cafe') yonas,
       tests.user_id('abebe', 'central-cafe') abebe, tests.user_id('selam', 'central-cafe') admin,
       tests.user_id('waiter', 'second-cafe') b_waiter,
       tests.tenant_id('central-cafe') a, tests.tenant_id('second-cafe') b;
grant all on _f to public;

-- ── pepper contract ──
select is(tests.pin_digest('4805'), 'c322f575dc02e97fa786764ad638da86d57e28a251a7589d8d1f4057721bfb62',
          'SQL HMAC-SHA256(pin, demo pepper) equals the Node/Web-Crypto vector used by tests/unit/pin-login-logic.test.ts');
select tests.authenticate_as_service_role();
select is((select public.fn_verify_pin((select hanna from _f), tests.pin_digest('4805')) ->> 'status'), 'ok', 'the seeded demo PIN verifies through the peppered digest');
select is((select public.fn_verify_pin((select hanna from _f), '4805') ->> 'status'), 'invalid', 'the raw PIN does not verify (DB only knows digests)');
select throws_ok(format($q$select public.fn_set_user_pin(%L, '4829')$q$, (select yonas from _f)), 'P0001', 'invalid_pin', 'fn_set_user_pin refuses a raw PIN');
select throws_ok(format($q$select public.fn_set_user_pin(%L, repeat('A', 64))$q$, (select yonas from _f)), 'P0001', 'invalid_pin', 'fn_set_user_pin refuses a non-lowercase-hex digest');
select throws_ok(format($q$select public.fn_set_user_pin(%L, null)$q$, (select yonas from _f)), 'P0001', 'invalid_pin', 'fn_set_user_pin refuses null');
select tests.clear_auth();
select ok((select pin_hash ~ '^\$2[aby]\$10\$' and pin_hash not like '%d4de579e%' from public.profile_secrets where profile_id = (select hanna from _f)), 'stored value is bcrypt(cost 10) of the digest, not the digest');

-- ── uniform answers (L2) ──
select tests.authenticate_as_service_role();
create temp table _ans (k text, v jsonb);
grant all on _ans to public;
insert into _ans values ('unknown', public.fn_verify_pin(gen_random_uuid(), tests.pin_digest('000000')));
insert into _ans values ('wrong', public.fn_verify_pin((select abebe from _f), tests.pin_digest('000000')));
select tests.clear_auth();
update public.profiles set is_active = false where id = (select yonas from _f);
select tests.authenticate_as_service_role();
insert into _ans values ('inactive_right', public.fn_verify_pin((select yonas from _f), tests.pin_digest('7392')));
select tests.clear_auth();
update public.restaurants set status = 'suspended', suspended_at = now(), suspension_reason = 'test', status_before_suspension = 'active' where id = (select b from _f);
select tests.authenticate_as_service_role();
insert into _ans values ('suspended_right', public.fn_verify_pin((select b_waiter from _f), tests.pin_digest('3972')));
select tests.clear_auth();
select is((select count(distinct v::text)::int from _ans), 1, 'unknown / wrong / inactive / suspended-tenant all answer exactly the same');
select is((select v::text from _ans limit 1), '{"status": "invalid"}', 'and that answer carries no attempts_left / locked_until');
update public.restaurants set status = 'active', suspended_at = null, suspension_reason = null, status_before_suspension = null where id = (select b from _f);
update public.profiles set is_active = true where id = (select yonas from _f);

-- ── escalating lock tiers (counter never decays on its own) ──
select tests.authenticate_as_service_role();
select public.fn_verify_pin((select abebe from _f), tests.pin_digest('000000'));  -- 1 failure so far on abebe
select tests.clear_auth();
update public.profile_secrets set failed_attempts = 5, locked_until = null where profile_id = (select abebe from _f);
select tests.authenticate_as_service_role();
select public.fn_verify_pin((select abebe from _f), tests.pin_digest('000000'));  -- 6th failure
select tests.clear_auth();
select ok((select locked_until > now() + interval '59 minutes' and locked_until < now() + interval '61 minutes' from public.profile_secrets where profile_id = (select abebe from _f)), '6th failure: 1 hour lock');
update public.profile_secrets set failed_attempts = 8, locked_until = null where profile_id = (select abebe from _f);
select tests.authenticate_as_service_role();
select public.fn_verify_pin((select abebe from _f), tests.pin_digest('000000'));  -- 9th failure
select tests.clear_auth();
select ok((select locked_until > now() + interval '23 hours' from public.profile_secrets where profile_id = (select abebe from _f)), '9th failure: 24 hour lock');
select is(public.fn_pin_lock_duration(2), null, 'no lock below 3 failures');
select is(public.fn_pin_lock_duration(3), interval '15 minutes', '3rd: 15 minutes');
select is(public.fn_pin_lock_duration(5), interval '15 minutes', '5th: still 15 minutes (every failure re-locks)');
select is(public.fn_pin_lock_duration(6), interval '1 hour', '6th: 1 hour');
select is(public.fn_pin_lock_duration(9), interval '24 hours', '9th: 24 hours');
update public.profile_secrets set locked_until = now() - interval '1 second' where profile_id = (select abebe from _f);
select tests.authenticate_as_service_role();
select is((select public.fn_verify_pin((select abebe from _f), tests.pin_digest('9153')) ->> 'status'), 'ok', 'after the lock expires the right PIN works again');
select tests.clear_auth();
select is((select failed_attempts from public.profile_secrets where profile_id = (select abebe from _f)), 0, 'and only then does the counter return to 0');

-- ── admin reset (users.manage, audited, tenant-scoped) ──
update public.profile_secrets set failed_attempts = 7, locked_until = now() + interval '1 hour' where profile_id = (select hanna from _f);
select tests.authenticate_as((select admin from _f));
select lives_ok(format($q$select public.fn_reset_pin_lockout(%L)$q$, (select hanna from _f)), 'tenant admin resets a staff lockout');
select tests.clear_auth();
select is((select failed_attempts from public.profile_secrets where profile_id = (select hanna from _f)), 0, 'reset zeroes the counter');
select ok((select locked_until is null from public.profile_secrets where profile_id = (select hanna from _f)), 'and clears the lock');
select is((select count(*)::int from public.audit_logs where event = 'auth.pin_lockout_reset' and actor_id = (select admin from _f)), 1, 'reset is audited with the real actor');
select tests.authenticate_as((select admin from _f));
select is(tests.oracle($q$select public.fn_reset_pin_lockout({id})$q$, (select b_waiter from _f)), 'P0001|not_found|', 'resetting another tenant''s (or an unknown) profile: same not_found');
select tests.clear_auth();
select tests.authenticate_as(tests.user_id('abebe', 'central-cafe'));
select is(tests.run(format($q$select public.fn_reset_pin_lockout(%L)$q$, (select hanna from _f))), 'P0001|permission_denied|', 'staff without users.manage cannot reset');
select tests.clear_auth();
select tests.as_anon();
select is(tests.run(format($q$select public.fn_reset_pin_lockout(%L)$q$, (select hanna from _f))), '42501|permission denied for function fn_reset_pin_lockout|', 'anon cannot reset');
select tests.clear_auth();

select * from finish();
rollback;
