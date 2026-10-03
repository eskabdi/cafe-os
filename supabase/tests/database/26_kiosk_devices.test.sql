-- Registered kiosk devices: registration / revocation RPCs, token handling, service-only roster + tile eligibility,
-- reserved subdomains.
begin;
select plan(69);

create temp table _f on commit drop as
select tests.tenant_id('central-cafe') a, tests.tenant_id('second-cafe') b,
       tests.user_id('selam', 'central-cafe') admin, tests.user_id('yonas', 'central-cafe') waiter,
       tests.user_id('hanna', 'central-cafe') cashier, tests.user_id('abebe', 'central-cafe') kitchen,
       tests.user_id('owner', 'second-cafe') b_admin, tests.user_id('waiter', 'second-cafe') b_waiter,
       tests.role_id('Waiter', 'central-cafe') r_waiter;
grant all on _f to public;
grant execute on all functions in schema tests to public;
create temp table _k (id uuid, token text, hash text, id2 uuid, token2 text, b_kiosk uuid);
grant all on _k to public;
insert into public.kiosk_devices (restaurant_id, name, token_hash, created_by) select b, 'B terminal', repeat('c', 64), b_admin from _f;
insert into _k (b_kiosk) select id from public.kiosk_devices where restaurant_id = (select b from _f);
create function tests.sha256_hex(p text) returns text language sql immutable as $$ select encode(extensions.digest(convert_to(p, 'UTF8'), 'sha256'), 'hex') $$;
grant execute on function tests.sha256_hex(text) to public;

select is(tests.sha256_hex(repeat('a', 64)), 'ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb', 'SQL sha256 of the token text equals the Web Crypto vector in tests/unit/kiosk-logic.test.ts');

-- ═════════ registration ═════════
select tests.authenticate_as((select admin from _f));
update _k set id = (public.fn_register_kiosk('Front counter') ->> 'id')::uuid;   -- placeholder to prove the call works; token re-read below
select tests.clear_auth();
select ok((select count(*) from public.kiosk_devices where name = 'Front counter') = 1, 'tenant_admin registers a kiosk');
-- register again to capture the token (the first token is unrecoverable by design: only its hash is stored)
select tests.authenticate_as((select admin from _f));
create temp table _r on commit drop as select public.fn_register_kiosk('Back bar') r;
grant all on _r to public;
select tests.clear_auth();
update _k set id2 = ((select r from _r) ->> 'id')::uuid, token2 = (select r from _r) ->> 'token';
select matches((select token2 from _k), '^[0-9a-f]{64}$', 'the token is 32 random bytes as 64 hex characters');
select is((select token_hash from public.kiosk_devices where id = (select id2 from _k)), tests.sha256_hex((select token2 from _k)), 'only sha256(token) is stored');
select ok((select count(*) from public.kiosk_devices where token_hash = (select token2 from _k)) = 0, 'the raw token is not in the table');
select ok(not exists (select 1 from public.audit_logs where coalesce(new_data::text, '') || coalesce(old_data::text, '') like '%' || (select token2 from _k) || '%'
                       or coalesce(new_data::text, '') || coalesce(old_data::text, '') like '%' || (select token_hash from public.kiosk_devices where id = (select id2 from _k)) || '%'),
          'neither the token nor its hash is in any audit row');
select is((select count(*)::int from public.audit_logs where event in ('kiosk.registered', 'kiosk_devices.insert') and actor_id = (select admin from _f)), 4, 'registration is audited twice per kiosk (semantic + row) with the real actor');

-- ═════════ client visibility ═════════
select tests.authenticate_as((select admin from _f));
select is(tests.run('select token_hash from public.kiosk_devices'), '42501|permission denied for table kiosk_devices|', 'token_hash is not selectable');
select is(tests.run('select * from public.kiosk_devices'), '42501|permission denied for table kiosk_devices|', 'select * is denied (column grants)');
select is(tests.run('select id, name, created_at, last_seen_at, revoked_at from public.kiosk_devices'), 'ok:2', 'metadata is readable with kiosks.manage');
select ok(not ((select public.fn_list_kiosks())::text ~* '(token|hash)'), 'fn_list_kiosks never returns a token or hash');
select is(jsonb_array_length(public.fn_list_kiosks()), 2, 'and lists both kiosks');
select is(tests.run($q$insert into public.kiosk_devices (restaurant_id, name, token_hash) select restaurant_id, 'x', repeat('e', 64) from public.profiles limit 1$q$), '42501|permission denied for table kiosk_devices|', 'no direct INSERT');
select is(tests.run($q$update public.kiosk_devices set revoked_at = null$q$), '42501|permission denied for table kiosk_devices|', 'no direct UPDATE');
select is(tests.run($q$delete from public.kiosk_devices$q$), '42501|permission denied for table kiosk_devices|', 'no direct DELETE');
select tests.clear_auth();
select tests.authenticate_as((select waiter from _f));
select is((select count(*)::int from public.kiosk_devices), 0, 'a waiter sees no kiosk');
select is(tests.run($q$select public.fn_register_kiosk('Nope')$q$), 'P0001|permission_denied|', 'a waiter cannot register');
select is(tests.run($q$select public.fn_list_kiosks()$q$), 'P0001|permission_denied|', 'nor list');
select is(tests.run(format($q$select public.fn_revoke_kiosk(%L)$q$, (select id2 from _k))), 'P0001|permission_denied|', 'nor revoke');
select tests.clear_auth();
select tests.as_anon();
select is(tests.run($q$select public.fn_register_kiosk('x')$q$), '42501|permission denied for function fn_register_kiosk|', 'anon cannot register');
select tests.clear_auth();
-- grantable: give the Waiter role kiosks.manage
insert into public.role_permissions (role_id, permission_id, restaurant_id) select (select r_waiter from _f), id, (select a from _f) from public.permissions where key = 'kiosks.manage';
select tests.authenticate_as((select waiter from _f));
select is(tests.run($q$select public.fn_list_kiosks()$q$), 'ok:1', 'the permission is grantable to any role');
select tests.clear_auth();
delete from public.role_permissions where role_id = (select r_waiter from _f) and permission_id = (select id from public.permissions where key = 'kiosks.manage');

-- ═════════ validation / cross-tenant ═════════
select tests.authenticate_as((select admin from _f));
select is(tests.run($q$select public.fn_register_kiosk('   ')$q$), 'P0001|invalid_input|name', 'name required');
select is(tests.run(format($q$select public.fn_register_kiosk(%L)$q$, repeat('x', 61))), 'P0001|invalid_input|name', 'name <= 60');
select is(tests.oracle($q$select public.fn_revoke_kiosk({id})$q$, (select b_kiosk from _k)), 'P0001|not_found|', 'revoking a foreign (or unknown) kiosk: identical not_found');
select tests.clear_auth();
select is((select count(*)::int from public.kiosk_devices where revoked_at is not null and restaurant_id = (select b from _f)), 0, 'the other tenant''s kiosk is untouched');

-- ═════════ service-only helpers ═════════
select tests.authenticate_as((select admin from _f));
select is(tests.run(format($q$select public.fn_kiosk_roster(%L, 'central-cafe')$q$, repeat('a', 64))), '42501|permission denied for function fn_kiosk_roster|', 'authenticated cannot call fn_kiosk_roster');
select is(tests.run($q$select public.fn_kiosk_context(repeat('a', 64), 'central-cafe', false)$q$), '42501|permission denied for function fn_kiosk_context|', 'nor fn_kiosk_context');
select is(tests.run($q$select public.fn_kiosk_tile_eligible(repeat('a', 64), 'central-cafe', gen_random_uuid())$q$), '42501|permission denied for function fn_kiosk_tile_eligible|', 'nor fn_kiosk_tile_eligible');
select tests.clear_auth();
select tests.as_anon();
select is(tests.run($q$select public.fn_kiosk_roster(repeat('a', 64), 'central-cafe')$q$), '42501|permission denied for function fn_kiosk_roster|', 'anon cannot call fn_kiosk_roster');
select tests.clear_auth();

select tests.authenticate_as_service_role();
create temp table _roster on commit drop as select public.fn_kiosk_roster(tests.sha256_hex((select token2 from _k)), 'central-cafe') r;
grant all on _roster to public;
select is(jsonb_typeof((select r from _roster)), 'array', 'valid kiosk: a roster array');
select is((select jsonb_agg(t ->> 'name' order by t ->> 'name') from jsonb_array_elements((select r from _roster)) t), '["Abebe Worku", "Kalkidan Haile", "Meron Alemu", "Sara Bekele", "Yonas Tesfaye"]'::jsonb,
          'only the 4-digit PIN staff, by short name (first + middle); the 6-digit Cashier (Hanna) and the admins are absent');
select is((select array_agg(distinct k order by k) from jsonb_array_elements((select r from _roster)) t, jsonb_object_keys(t) k), array['color', 'icon', 'id', 'name', 'role'], 'a tile has exactly id, name, role, color, icon');
select ok(not ((select r from _roster)::text ~* '(username|email|pin|hash|permission|@|\$2)'), 'no username, email, secret or permission anywhere in the roster');
select is((select t ->> 'role' from jsonb_array_elements((select r from _roster)) t where t ->> 'name' = 'Abebe Worku'), 'Kitchen', 'role label comes from the role row');
select ok((select (t ->> 'color') ~ '^#[0-9a-f]{6}$' from jsonb_array_elements((select r from _roster)) t where t ->> 'name' = 'Abebe Worku'), 'and so does its colour');
select tests.clear_auth();

-- every way a kiosk can be invalid gives the identical NULL
select tests.authenticate_as_service_role();
create temp table _bad (k text, v jsonb);
grant all on _bad to public;
insert into _bad values ('unknown_token', public.fn_kiosk_roster(repeat('f', 64), 'central-cafe'));
insert into _bad values ('malformed_token', public.fn_kiosk_roster('nope', 'central-cafe'));
insert into _bad values ('wrong_slug', public.fn_kiosk_roster(tests.sha256_hex((select token2 from _k)), 'second-cafe'));
insert into _bad values ('null_slug', public.fn_kiosk_roster(tests.sha256_hex((select token2 from _k)), null));
select tests.clear_auth();
select tests.authenticate_as((select admin from _f));
select public.fn_revoke_kiosk((select id2 from _k));
select tests.clear_auth();
select tests.authenticate_as_service_role();
insert into _bad values ('revoked', public.fn_kiosk_roster(tests.sha256_hex((select token2 from _k)), 'central-cafe'));
select tests.clear_auth();
select is((select count(*)::int from _bad where v is null), 5, 'unknown / malformed / wrong-slug / null-slug / revoked: all the same NULL (no roster, no oracle)');

-- suspended / cancelled tenant
select tests.authenticate_as((select admin from _f));
create temp table _r2 on commit drop as select public.fn_register_kiosk('Third') r;
grant all on _r2 to public;
select tests.clear_auth();
select tests.authenticate_as_service_role();
select is(jsonb_typeof(public.fn_kiosk_roster(tests.sha256_hex((select r ->> 'token' from _r2)), 'central-cafe')), 'array', 'a fresh kiosk works');
select tests.clear_auth();
update public.restaurants set status = 'suspended', suspended_at = now(), suspension_reason = 'test', status_before_suspension = 'active' where id = (select a from _f);
select tests.authenticate_as_service_role();
select is(public.fn_kiosk_roster(tests.sha256_hex((select r ->> 'token' from _r2)), 'central-cafe'), null::jsonb, 'suspended tenant: NULL');
select is(public.fn_kiosk_tile_eligible(tests.sha256_hex((select r ->> 'token' from _r2)), 'central-cafe', (select kitchen from _f)), false, 'suspended tenant: no tile is eligible');
select tests.clear_auth();
update public.restaurants set status = 'cancelled', suspended_at = null, suspension_reason = null, status_before_suspension = null where id = (select a from _f);
select tests.authenticate_as_service_role();
select is(public.fn_kiosk_roster(tests.sha256_hex((select r ->> 'token' from _r2)), 'central-cafe'), null::jsonb, 'cancelled tenant: NULL');
select tests.clear_auth();
update public.restaurants set status = 'active' where id = (select a from _f);
select tests.authenticate_as((select admin from _f));
select is(tests.run($q$select public.fn_register_kiosk('x')$q$) , 'ok:1', 'active again: registration works');
create temp table _r3 on commit drop as select public.fn_register_kiosk('Throwaway') r;
grant all on _r3 to public;
select tests.clear_auth();
update public.restaurants set status = 'past_due' where id = (select a from _f);
select tests.authenticate_as((select admin from _f));
select is(tests.run($q$select public.fn_register_kiosk('x')$q$), 'P0001|tenant_read_only|', 'past_due: registration is write-blocked');
select is(tests.run(format($q$select public.fn_revoke_kiosk(%L)$q$, (select (r ->> 'id')::uuid from _r3))), 'ok:1', 'but revocation still works (it only reduces access)');
select is(tests.run(format($q$select public.fn_revoke_kiosk(%L)$q$, (select (r ->> 'id')::uuid from _r3))), 'ok:1', 'revoking again is a harmless no-op');
select tests.clear_auth();
select is((select count(*)::int from public.audit_logs where event = 'kiosk.revoked' and new_data ->> 'kiosk_id' = (select r ->> 'id' from _r3)), 1, 'and it is audited exactly once');
select throws_ok(format($q$update public.kiosk_devices set revoked_at = null where id = %L$q$, (select (r ->> 'id')::uuid from _r3)), 'P0001', 'kiosk_revocation_final', 'revoked_at cannot be cleared');
select throws_ok(format($q$update public.kiosk_devices set revoked_at = now() + interval '1 day' where id = %L$q$, (select (r ->> 'id')::uuid from _r3)), 'P0001', 'kiosk_revocation_final', 'nor moved');
update public.restaurants set status = 'suspended', suspended_at = now(), suspension_reason = 'test', status_before_suspension = 'active' where id = (select a from _f);
update public.restaurants set status = 'active', suspended_at = null, suspension_reason = null, status_before_suspension = null where id = (select a from _f);

-- step-up: registering needs aal2 when the admin has MFA / the tenant requires it; revoking never does
update public.restaurants set status = 'active' where id = (select a from _f);
select tests.authenticate_as((select admin from _f));
select set_config('app.tenant_admin_mfa_required', 'on', true);
select is(tests.run($q$select public.fn_register_kiosk('NoStepUp')$q$), 'P0001|mfa_required|', 'registration without aal2 is refused when MFA is required');
select is(tests.run(format($q$select public.fn_revoke_kiosk(%L)$q$, (select (r ->> 'id')::uuid from _r3))), 'ok:1', 'revocation does not need step-up');
select set_config('app.tenant_admin_mfa_required', 'off', true);
select tests.clear_auth();

-- ═════════ tile eligibility ═════════
select tests.authenticate_as_service_role();
select is(public.fn_kiosk_tile_eligible(tests.sha256_hex((select r ->> 'token' from _r2)), 'central-cafe', (select kitchen from _f)), true, 'a 4-digit staff member is an eligible tile');
select is(public.fn_kiosk_tile_eligible(tests.sha256_hex((select r ->> 'token' from _r2)), 'central-cafe', (select cashier from _f)), false, 'the 6-digit Cashier is not');
select is(public.fn_kiosk_tile_eligible(tests.sha256_hex((select r ->> 'token' from _r2)), 'central-cafe', (select admin from _f)), false, 'a tenant_admin is not');
select is(public.fn_kiosk_tile_eligible(tests.sha256_hex((select r ->> 'token' from _r2)), 'central-cafe', (select b_waiter from _f)), false, 'another tenant''s staff is not');
select is(public.fn_kiosk_tile_eligible(tests.sha256_hex((select r ->> 'token' from _r2)), 'central-cafe', gen_random_uuid()), false, 'an unknown id is not');
select tests.clear_auth();
update public.profiles set is_active = false where id = (select kitchen from _f);
select tests.authenticate_as_service_role();
select is(public.fn_kiosk_tile_eligible(tests.sha256_hex((select r ->> 'token' from _r2)), 'central-cafe', (select kitchen from _f)), false, 'a deactivated member is not');
select tests.clear_auth();

-- ═════════ reserved subdomains ═════════
select is((select string_agg(s, ',' order by s) from unnest(array['www','app','api','admin','platform','auth','static','cdn','mail','support','status','assets','login','r']) s where not public.fn_slug_is_reserved(s)), null, 'every reserved subdomain (spec list + legacy list) is reserved in SQL');
select is((select string_agg(s, ',' order by s) from unnest(array['www','app','api','admin','platform','auth','static','cdn','mail','support','status','assets','login','r']) s
           where tests.run(format($q$update public.restaurants set slug = %L where id = %L$q$, s, (select a from _f))) !~ '^23514\|'), null, 'and every one is refused by the restaurants_slug_format CHECK');

-- ═════════ review additions (rls-tester gate): tenant denial per verb, delegate escalation, restrict FKs, Realtime ═════════
select tests.authenticate_as((select admin from _f));
select is((select count(*)::int from public.kiosk_devices where restaurant_id = (select b from _f)), 0, 'tenant A admin selects none of tenant B''s kiosks');
select tests.clear_auth();
select tests.authenticate_as((select b_admin from _f));
select is((select count(*)::int from public.kiosk_devices where restaurant_id = (select a from _f)), 0, 'tenant B admin selects none of tenant A''s kiosks');
select is((select count(*)::int from public.kiosk_devices), 1, 'and sees exactly its own one');
select tests.clear_auth();

-- a delegate holding ONLY kiosks.manage (Waiter role) gains nothing beyond kiosks
insert into public.role_permissions (role_id, permission_id, restaurant_id) select (select r_waiter from _f), id, (select a from _f) from public.permissions where key = 'kiosks.manage';
select tests.authenticate_as((select waiter from _f));
select is(tests.run(format($q$select public.fn_change_user_role(%L, %L)$q$, (select waiter from _f), (select id from public.roles where restaurant_id = (select a from _f) and system_key = 'tenant_admin'))),
          'P0001|permission_denied|', 'kiosks.manage holder cannot promote itself to tenant_admin');
select is(tests.run(format($q$select public.fn_update_role_permissions(%L, array['kiosks.manage','settings.manage'], '{}')$q$, (select r_waiter from _f))),
          'P0001|permission_denied|', 'nor widen its own role permissions');
select ok(tests.run(format($q$update public.profiles set role_id = %L where id = %L$q$, (select id from public.roles where restaurant_id = (select a from _f) and system_key = 'tenant_admin'), (select waiter from _f))) ~ '^42501\|',
          'nor update profiles.role_id directly');
select is(tests.oracle($q$select public.fn_revoke_kiosk({id})$q$, (select b_kiosk from _k)), 'P0001|not_found|', 'delegate revoking tenant B''s kiosk: identical not_found');
select is((select count(*)::int from public.kiosk_devices where restaurant_id = (select b from _f)), 0, 'delegate cannot see tenant B kiosks');
select tests.clear_auth();
select is((select count(*)::int from public.kiosk_devices where restaurant_id = (select b from _f) and revoked_at is not null), 0, 'tenant B''s kiosk is still not revoked');
-- forced PIN change takes the delegated permission away too (must_change_pin ceiling)
update public.profile_secrets set must_change_pin = true where profile_id = (select waiter from _f);
select tests.authenticate_as((select waiter from _f));
select is(tests.run($q$select public.fn_list_kiosks()$q$), 'P0001|permission_denied|', 'a delegate with a pending PIN change loses kiosks.manage');
select tests.clear_auth();
update public.profile_secrets set must_change_pin = false where profile_id = (select waiter from _f);
delete from public.role_permissions where role_id = (select r_waiter from _f) and permission_id = (select id from public.permissions where key = 'kiosks.manage');

-- deletes are RESTRICT (no cascade from tenant / creator to kiosks or notifications)
select is((select string_agg(conname, ',' order by conname) from pg_constraint
           where contype = 'f' and confdeltype <> 'r' and conrelid in ('public.kiosk_devices'::regclass, 'public.user_notifications'::regclass)), null, 'every FK on kiosk_devices / user_notifications is ON DELETE RESTRICT');
-- token_hash must never reach Realtime
select ok(not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'kiosk_devices'), 'kiosk_devices is not in the Realtime publication');

select * from finish();
rollback;
