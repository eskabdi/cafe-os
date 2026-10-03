-- One concurrent session per PIN staff (migration 0023): the service-only session check, the blocked-login handler
-- (notifications, dedupe, audit, forced PIN change), user_notifications RLS + fn_mark_notification_read, and the
-- server-side enforcement of must_change_pin (has_permission and friends answer "nothing").
begin;
select plan(120);

create temp table _f on commit drop as
select tests.tenant_id('central-cafe') a, tests.tenant_id('second-cafe') b,
       tests.user_id('selam', 'central-cafe') admin, tests.user_id('yonas', 'central-cafe') waiter,
       tests.user_id('meron', 'central-cafe') deleg, tests.user_id('abebe', 'central-cafe') kitchen,
       tests.user_id('hanna', 'central-cafe') cashier,
       tests.user_id('owner', 'second-cafe') b_admin, tests.user_id('waiter', 'second-cafe') b_waiter;
grant all on _f to public;
grant execute on all functions in schema tests to public;
create temp table _n (k text primary key, id uuid, t text);
grant all on _n to public;
create function tests.sha256_hex(p text) returns text language sql immutable as $$ select encode(extensions.digest(convert_to(p, 'UTF8'), 'sha256'), 'hex') $$;
grant execute on function tests.sha256_hex(text) to public;

-- ═════════ structure and privileges ═════════
select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.user_notifications'::regclass), 'user_notifications: RLS enabled and forced');
select is((select count(*)::int from pg_policies where tablename = 'user_notifications'), 1, 'exactly one policy (select), no write policy');
select is((select cmd from pg_policies where tablename = 'user_notifications'), 'SELECT', 'and it is the SELECT policy');
select ok(not has_table_privilege('authenticated', 'public.user_notifications', 'insert,update,delete,truncate'), 'authenticated has no write privilege on the table');
select ok(not has_any_column_privilege('authenticated', 'public.user_notifications', 'insert,update'), 'nor on any column');
select ok(not has_any_column_privilege('anon', 'public.user_notifications', 'select,insert,update'), 'anon has nothing');
select ok(not has_function_privilege('authenticated', 'public.fn_staff_has_active_session(uuid)', 'execute')
      and not has_function_privilege('anon', 'public.fn_staff_has_active_session(uuid)', 'execute'), 'fn_staff_has_active_session: no client EXECUTE');
select ok(not has_function_privilege('authenticated', 'public.fn_staff_login_blocked(uuid,text)', 'execute')
      and not has_function_privilege('anon', 'public.fn_staff_login_blocked(uuid,text)', 'execute'), 'fn_staff_login_blocked: no client EXECUTE');
select ok(not has_function_privilege('authenticated', 'public.fn_active_session_window()', 'execute'), 'fn_active_session_window: no client EXECUTE');
select ok(has_function_privilege('service_role', 'public.fn_staff_has_active_session(uuid)', 'execute')
      and has_function_privilege('service_role', 'public.fn_staff_login_blocked(uuid,text)', 'execute'), 'service_role can execute both');
select ok(has_function_privilege('authenticated', 'public.fn_mark_notification_read(uuid)', 'execute')
      and not has_function_privilege('anon', 'public.fn_mark_notification_read(uuid)', 'execute'), 'fn_mark_notification_read: authenticated only');
select is(tests.run(format($q$select public.fn_staff_has_active_session(%L)$q$, (select waiter from _f))), 'P0001|permission_denied|', 'a non-service caller (even the owner role) gets permission_denied from the session check');
select is(tests.run(format($q$select public.fn_staff_login_blocked(%L)$q$, (select waiter from _f))), 'P0001|permission_denied|', 'and from the blocked handler');
select tests.authenticate_as((select admin from _f));
select is(tests.run(format($q$select public.fn_staff_has_active_session(%L)$q$, (select waiter from _f))), '42501|permission denied for function fn_staff_has_active_session|', 'a tenant_admin cannot call the session check');
select is(tests.run(format($q$select public.fn_staff_login_blocked(%L)$q$, (select waiter from _f))), '42501|permission denied for function fn_staff_login_blocked|', 'nor the blocked handler');
select tests.clear_auth();
select tests.as_anon();
select is(tests.run(format($q$select public.fn_staff_has_active_session(%L)$q$, (select waiter from _f))), '42501|permission denied for function fn_staff_has_active_session|', 'anon cannot call the session check');
select is(tests.run($q$select * from public.user_notifications$q$), '42501|permission denied for table user_notifications|', 'anon cannot read notifications');
select tests.clear_auth();
select is((select public.fn_active_session_window()), interval '2 hours', 'window = 2 hours');
select ok((select public.fn_active_session_window()) > interval '1 hour', 'and it is longer than jwt_expiry (3600 s, supabase/config.toml)');

-- ═════════ session-active window (auth.sessions as GoTrue stores it) ═════════
select tests.authenticate_as_service_role();
select is(public.fn_staff_has_active_session((select waiter from _f)), false, 'no session row: not active');
select is(public.fn_staff_has_active_session(null), false, 'null id: false');
select is(public.fn_staff_has_active_session(gen_random_uuid()), false, 'unknown id: false');
select tests.clear_auth();

insert into auth.sessions (id, user_id, created_at, updated_at, refreshed_at, not_after)
  values (gen_random_uuid(), (select waiter from _f), now() - interval '10 minutes', now() - interval '10 minutes', null, null);
select tests.authenticate_as_service_role();
select is(public.fn_staff_has_active_session((select waiter from _f)), true, 'fresh session (created 10 minutes ago, never refreshed): active');
select tests.clear_auth();

delete from auth.sessions where user_id = (select waiter from _f);   -- sign-out deletes the row
select tests.authenticate_as_service_role();
select is(public.fn_staff_has_active_session((select waiter from _f)), false, 'sign-out (row deleted): free immediately');
select tests.clear_auth();

insert into auth.sessions (id, user_id, created_at, updated_at, refreshed_at, not_after)
  values (gen_random_uuid(), (select waiter from _f), now() - interval '5 hours', now() - interval '3 hours', (now() at time zone 'utc') - interval '3 hours', null);
select tests.authenticate_as_service_role();
select is(public.fn_staff_has_active_session((select waiter from _f)), false, 'closed browser: last refresh 3 hours ago is stale');
select tests.clear_auth();

update auth.sessions set refreshed_at = (now() at time zone 'utc') - interval '30 minutes' where user_id = (select waiter from _f);
select tests.authenticate_as_service_role();
select is(public.fn_staff_has_active_session((select waiter from _f)), true, 'refreshed 30 minutes ago (refreshed_at is a UTC timestamp without zone): active even though created long ago');
select tests.clear_auth();

update auth.sessions set refreshed_at = (now() at time zone 'utc') - interval '119 minutes' where user_id = (select waiter from _f);
select tests.authenticate_as_service_role();
select is(public.fn_staff_has_active_session((select waiter from _f)), true, 'inside the window by a minute: active');
select tests.clear_auth();
update auth.sessions set refreshed_at = (now() at time zone 'utc') - interval '121 minutes' where user_id = (select waiter from _f);
select tests.authenticate_as_service_role();
select is(public.fn_staff_has_active_session((select waiter from _f)), false, 'outside the window by a minute: stale');
select tests.clear_auth();

update auth.sessions set refreshed_at = null, updated_at = now() - interval '20 minutes', created_at = now() - interval '9 hours' where user_id = (select waiter from _f);
select tests.authenticate_as_service_role();
select is(public.fn_staff_has_active_session((select waiter from _f)), true, 'no refreshed_at: updated_at counts');
select tests.clear_auth();

update auth.sessions set not_after = now() - interval '1 minute' where user_id = (select waiter from _f);
select tests.authenticate_as_service_role();
select is(public.fn_staff_has_active_session((select waiter from _f)), false, 'expired (not_after in the past) even though recently updated: not active');
select tests.clear_auth();
update auth.sessions set not_after = now() + interval '1 hour' where user_id = (select waiter from _f);
select tests.authenticate_as_service_role();
select is(public.fn_staff_has_active_session((select waiter from _f)), true, 'not_after in the future: active');
select is(public.fn_staff_has_active_session((select kitchen from _f)), false, 'another user''s session does not count');
select tests.clear_auth();

-- admins and non-PIN users are never "blocked", whatever sessions they hold
insert into auth.sessions (id, user_id, created_at, updated_at) values (gen_random_uuid(), (select admin from _f), now(), now());
insert into auth.sessions (id, user_id, created_at, updated_at) values (gen_random_uuid(), (select b_admin from _f), now(), now());
select tests.authenticate_as_service_role();
select is(public.fn_staff_has_active_session((select admin from _f)), false, 'tenant_admin with a fresh session: never blocked');
select is(public.fn_staff_has_active_session((select b_admin from _f)), false, 'other tenant''s admin: never blocked');
select tests.clear_auth();
update public.profiles set auth_method = 'password' where id = (select deleg from _f) and false;   -- (auth_method is trigger-locked to the role; password staff cannot exist, see 04)
insert into auth.sessions (id, user_id, created_at, updated_at) values (gen_random_uuid(), (select deleg from _f), now(), now());
update public.profiles set is_active = false where id = (select deleg from _f);
select tests.authenticate_as_service_role();
select ok(public.fn_staff_has_active_session((select deleg from _f)) is not null, 'an inactive member answers without error');
select tests.clear_auth();
update public.profiles set is_active = true where id = (select deleg from _f);
delete from auth.sessions where user_id = (select deleg from _f);

-- ═════════ before the block: yonas is a normal waiter ═════════
select tests.authenticate_as((select waiter from _f));
select ok(public.has_permission('orders.create'), 'before: the waiter holds orders.create');
select ok((select count(*) from public.menu_items) > 0, 'before: the waiter reads the menu');
select is((public.fn_get_session_context() ->> 'must_change_pin')::boolean, false, 'before: session context says must_change_pin = false');
select ok(jsonb_array_length(public.fn_get_session_context() -> 'permissions') > 0, 'before: permissions are listed');
select tests.clear_auth();

-- ═════════ blocked login: username path ═════════
select tests.authenticate_as_service_role();
select is((public.fn_staff_login_blocked((select waiter from _f)) ->> 'notified')::boolean, true, 'blocked handler: notified');
select tests.clear_auth();
select is((select must_change_pin from public.profile_secrets where profile_id = (select waiter from _f)), true, 'must_change_pin is now set');
select is((select count(*)::int from public.user_notifications where recipient_id = (select waiter from _f) and kind = 'security.concurrent_login_blocked'), 1, 'the affected user got one notification');
select is((select count(distinct n.recipient_id)::int from public.user_notifications n where n.restaurant_id = (select a from _f)),
          1 + (select count(*)::int from public.profiles p join public.roles ro on ro.id = p.role_id where p.restaurant_id = (select a from _f) and ro.system_key = 'tenant_admin' and p.is_active),
          'recipients = the user + every active tenant_admin of the tenant');
select ok((select count(*) from public.user_notifications where recipient_id = (select admin from _f)) = 1, 'the tenant admin got one');
select is((select count(*)::int from public.user_notifications where restaurant_id = (select b from _f)), 0, 'nobody in the other tenant was notified');
select is((select string_agg(k, ',' order by k) from public.user_notifications n, jsonb_object_keys(n.payload) k where n.recipient_id = (select waiter from _f)),
          'at,profile_id,user_name', 'payload keys on the username path: at, profile_id, user_name (no kiosk_name)');
select is((select payload ->> 'user_name' from public.user_notifications where recipient_id = (select waiter from _f)),
          (select short_name from public.profiles where id = (select waiter from _f)), 'user_name is the short name (first + middle)');
select ok((select (payload ->> 'at')::timestamptz from public.user_notifications where recipient_id = (select waiter from _f)) > now() - interval '1 minute', 'at is a timestamp');
select ok(not exists (select 1 from public.user_notifications where payload::text ~* '(pin|digest|token|hash|secret|password|[0-9a-f]{64})'), 'no PIN / token / hash data in any payload');
select is((select count(*)::int from public.audit_logs where event = 'auth.concurrent_login_blocked' and restaurant_id = (select a from _f)), 1, 'one audit row');
select ok(not exists (select 1 from public.audit_logs where event = 'auth.concurrent_login_blocked' and new_data::text ~* '(pin_hash|digest|token|[0-9a-f]{64})'), 'audit row carries no secret');

-- dedupe: at most one per user per 5 minutes
select tests.authenticate_as_service_role();
select is((public.fn_staff_login_blocked((select waiter from _f)) ->> 'notified')::boolean, false, 'second blocked attempt within 5 minutes: not notified again');
select tests.clear_auth();
select is((select count(*)::int from public.user_notifications where payload ->> 'profile_id' = (select waiter::text from _f)), 
          1 + (select count(*)::int from public.profiles p join public.roles ro on ro.id = p.role_id where p.restaurant_id = (select a from _f) and ro.system_key = 'tenant_admin' and p.is_active),
          'still exactly one notification per recipient');
select is((select count(*)::int from public.audit_logs where event = 'auth.concurrent_login_blocked' and restaurant_id = (select a from _f)), 2, 'but the attempt is audited every time');
alter table public.user_notifications disable trigger trg_notification_immutable;   -- owner-only, rolled back: age the rows by 6 minutes
update public.user_notifications set created_at = now() - interval '6 minutes';
alter table public.user_notifications enable trigger trg_notification_immutable;
select tests.authenticate_as_service_role();
select is((public.fn_staff_login_blocked((select waiter from _f)) ->> 'notified')::boolean, true, 'after the 5 minute window a new notification is sent');
select tests.clear_auth();
select is((select count(*)::int from public.user_notifications where recipient_id = (select waiter from _f)), 2, 'the user now has two');

-- ═════════ blocked login: tile path (kiosk name) ═════════
insert into public.kiosk_devices (restaurant_id, name, token_hash, created_by) values ((select a from _f), 'Front counter', tests.sha256_hex('kiosk-a'), (select admin from _f));
insert into public.kiosk_devices (restaurant_id, name, token_hash, created_by) values ((select b from _f), 'B terminal', tests.sha256_hex('kiosk-b'), (select b_admin from _f));
alter table public.user_notifications disable trigger trg_notification_immutable;
update public.user_notifications set created_at = now() - interval '6 minutes';
alter table public.user_notifications enable trigger trg_notification_immutable;
select tests.authenticate_as_service_role();
select is((public.fn_staff_login_blocked((select kitchen from _f), tests.sha256_hex('kiosk-a')) ->> 'notified')::boolean, true, 'tile path: notified');
select tests.clear_auth();
select is((select payload ->> 'kiosk_name' from public.user_notifications where recipient_id = (select kitchen from _f)), 'Front counter', 'payload carries the kiosk name');
select is((select string_agg(k, ',' order by k) from public.user_notifications n, jsonb_object_keys(n.payload) k where n.recipient_id = (select kitchen from _f)),
          'at,kiosk_name,profile_id,user_name', 'tile path payload keys');
select tests.authenticate_as_service_role();
select public.fn_staff_login_blocked((select cashier from _f), tests.sha256_hex('kiosk-b'));   -- another tenant's kiosk
select tests.clear_auth();
select ok((select payload ->> 'kiosk_name' is null from public.user_notifications where recipient_id = (select cashier from _f)), 'a foreign tenant''s kiosk hash never yields a name');

-- admin / unknown / bad input: nothing happens, nothing raised
select count(*) as before_n from public.user_notifications \gset
select tests.authenticate_as_service_role();
select is((public.fn_staff_login_blocked((select admin from _f)) ->> 'notified')::boolean, false, 'a tenant_admin id: nothing');
select is((public.fn_staff_login_blocked(gen_random_uuid()) ->> 'notified')::boolean, false, 'an unknown id: nothing');
select is((public.fn_staff_login_blocked(null) ->> 'notified')::boolean, false, 'null: nothing');
select tests.clear_auth();
select is((select count(*)::int from public.user_notifications), :before_n::int, 'no notification was created for them');
select is((select count(*)::int from public.profile_secrets where profile_id = (select admin from _f)), 0, 'and no secret row (admins never hold a PIN)');

-- ═════════ RLS on user_notifications ═════════
select tests.authenticate_as((select waiter from _f));
select is((select count(*)::int from public.user_notifications), 2, 'the recipient sees exactly their own rows');
select is((select count(*)::int from public.user_notifications where recipient_id <> (select waiter from _f)), 0, 'and no one else''s');
select is(tests.run($q$insert into public.user_notifications (restaurant_id, recipient_id, kind) select restaurant_id, recipient_id, 'x' from public.user_notifications limit 1$q$), '42501|permission denied for table user_notifications|', 'client insert denied');
select is(tests.run($q$update public.user_notifications set read_at = now()$q$), '42501|permission denied for table user_notifications|', 'client update denied (use fn_mark_notification_read)');
select is(tests.run($q$delete from public.user_notifications$q$), '42501|permission denied for table user_notifications|', 'client delete denied');
select tests.clear_auth();
select tests.authenticate_as((select admin from _f));
select is((select count(*)::int from public.user_notifications where recipient_id <> (select admin from _f)), 0, 'a tenant_admin sees only notifications addressed to themselves (one per blocked attempt), not the staff member''s');
select is((select count(*)::int from public.user_notifications where recipient_id = (select waiter from _f)), 0, 'not even the notifications about their own staff addressed to others');
select tests.clear_auth();
select tests.authenticate_as((select b_waiter from _f));
select is((select count(*)::int from public.user_notifications where restaurant_id = (select a from _f)), 0, 'cross-tenant: tenant B sees none of A''s notifications');
select tests.clear_auth();
-- composite tenant key: a notification cannot point a tenant-A restaurant at a tenant-B recipient
select is(tests.run(format($q$insert into public.user_notifications (restaurant_id, recipient_id, kind) values (%L, %L, 'x')$q$, (select a from _f), (select b_waiter from _f))),
          '23503|insert or update on table "user_notifications" violates foreign key constraint "user_notifications_recipient_fk"|Key (restaurant_id, recipient_id)=(<uuid>, <uuid>) is not present in table "profiles".',
          'composite FK: cross-tenant recipient impossible, even for the owner role');
-- history is immutable (even for the owner role) except read_at NULL -> time
select is(tests.run(format($q$update public.user_notifications set payload = '{}' where recipient_id = %L$q$, (select waiter from _f))), 'P0001|immutable_column|', 'payload cannot be rewritten');
select is(tests.run(format($q$update public.user_notifications set kind = 'x' where recipient_id = %L$q$, (select waiter from _f))), 'P0001|immutable_column|', 'kind cannot be rewritten');
select is(tests.run(format($q$update public.user_notifications set restaurant_id = %L where recipient_id = %L$q$, (select b from _f), (select waiter from _f))), 'P0001|tenant_change_forbidden|user_notifications', 'restaurant_id cannot move');
select is(tests.run($q$insert into public.user_notifications (restaurant_id, recipient_id, kind, payload) select restaurant_id, id, 'Bad Kind!', '{}' from public.profiles limit 1$q$)::text ~ '^23514', true, 'kind format is checked');

-- ═════════ fn_mark_notification_read ═════════
select tests.authenticate_as((select waiter from _f));
select tests.run(format($q$select 1$q$)) as dummy \gset
insert into _n (k, id) select 'own', (select id from public.user_notifications order by created_at limit 1);
select tests.clear_auth();
insert into _n (k, id) select 'admin_row', id from public.user_notifications where recipient_id = (select admin from _f) limit 1;

select tests.authenticate_as((select waiter from _f));
select ok((public.fn_mark_notification_read((select id from _n where k = 'own')) ->> 'read_at') is not null, 'the recipient marks their own notification read');
select tests.clear_auth();
select ok((select read_at is not null from public.user_notifications where id = (select id from _n where k = 'own')), 'read_at is set');
update _n set t = (select read_at::text from public.user_notifications where id = (select id from _n where k = 'own')) where k = 'own';
select tests.authenticate_as((select waiter from _f));
select is((public.fn_mark_notification_read((select id from _n where k = 'own')) ->> 'read_at')::timestamptz, (select t::timestamptz from _n where k = 'own'), 'marking again is idempotent (read_at keeps its first value)');
select is(tests.oracle('select public.fn_mark_notification_read({id})', (select id from _n where k = 'admin_row')), 'P0001|not_found|', 'a colleague''s (admin''s) notification id answers exactly like an unknown id');
select is(tests.run('select public.fn_mark_notification_read(null)'), 'P0001|invalid_input|', 'null id: invalid_input');
select tests.clear_auth();
select tests.authenticate_as((select b_waiter from _f));
select is(tests.oracle('select public.fn_mark_notification_read({id})', (select id from _n where k = 'admin_row')), 'P0001|not_found|', 'cross-tenant: tenant A''s id answers exactly like an unknown id');
select tests.clear_auth();
select ok((select read_at is null from public.user_notifications where id = (select id from _n where k = 'admin_row')), 'and the foreign notification stays unread');
select tests.as_anon();
select is(tests.run(format($q$select public.fn_mark_notification_read(%L)$q$, (select id from _n where k = 'admin_row'))), '42501|permission denied for function fn_mark_notification_read|', 'anon cannot call it');
select tests.clear_auth();

-- ═════════ must_change_pin is a server-side ceiling ═════════
select tests.authenticate_as((select waiter from _f));
select ok(not public.has_permission('orders.create'), 'flagged: has_permission is false (was true)');
select ok(not public.has_permission('menu.view') and not public.has_permission('orders.view'), 'for every key');
select is((select count(*)::int from public.menu_items), 0, 'flagged: RLS reads that need a permission return nothing');
select is(public.current_station_ids(), '{}'::uuid[], 'flagged: no station ids');
select ok(not exists (select 1 from public.stations s where public.has_station_access(s.id)), 'flagged: no station access');
select is((public.fn_get_session_context() ->> 'must_change_pin')::boolean, true, 'session context reports must_change_pin = true');
select is(public.fn_get_session_context() -> 'permissions', '[]'::jsonb, 'with no permissions');
select is(public.fn_get_session_context() -> 'station_ids', '[]'::jsonb, 'and no stations');
select is(public.fn_get_session_context() #>> '{user,id}', (select waiter::text from _f), 'but identity, role and tenant are still returned (the SPA needs them)');
select is(tests.run(format($q$select public.fn_reset_pin_lockout(%L)$q$, (select waiter from _f))), 'P0001|permission_denied|', 'an RPC that needs a permission denies (self-service reset is not a permission)');
select ok(public.current_restaurant_id() is not null, 'the identity helpers still work (the session is valid)');
select tests.clear_auth();

select tests.authenticate_as((select kitchen from _f));
select ok(not public.has_permission('orders.view'), 'a second flagged user (kitchen, tile path) is also denied');
select tests.clear_auth();
select tests.authenticate_as((select deleg from _f));
select ok(exists (select 1 from public.role_permissions rp join public.profiles p on p.role_id = rp.role_id where p.id = (select deleg from _f)) and public.has_permission((select pm.key from public.role_permissions rp join public.permissions pm on pm.id = rp.permission_id join public.profiles p on p.role_id = rp.role_id where p.id = (select deleg from _f) limit 1)), 'an unflagged colleague keeps their permissions');
select tests.clear_auth();
select tests.authenticate_as((select admin from _f));
select ok(public.has_permission('users.manage') and public.has_permission('settings.manage'), 'tenant_admin is unaffected');
select is((public.fn_get_session_context() ->> 'must_change_pin')::boolean, false, 'admin context: must_change_pin = false');
select ok(jsonb_array_length(public.fn_get_session_context() -> 'permissions') > 10, 'admin context keeps its permissions');
select tests.clear_auth();
select tests.authenticate_as((select b_waiter from _f));
select ok(public.has_permission('orders.create'), 'another tenant''s waiter is unaffected');
select tests.clear_auth();

-- guard: the flag cannot exist on an admin; and even if a row existed, an admin is exempt
select is(tests.run(format($q$insert into public.profile_secrets (profile_id, restaurant_id, pin_hash, must_change_pin) values (%L, %L, 'x', true)$q$, (select admin from _f), (select a from _f))),
          'P0001|pin_not_allowed|', 'must_change_pin cannot be set on a tenant_admin (no secret row for admins)');
alter table public.profile_secrets disable trigger trg_guard_profile_secret;   -- owner-only, rolled back: simulate a corrupted row
insert into public.profile_secrets (profile_id, restaurant_id, pin_hash, must_change_pin) values ((select admin from _f), (select a from _f), 'x', true);
alter table public.profile_secrets enable trigger trg_guard_profile_secret;
select tests.authenticate_as((select admin from _f));
select ok(public.has_permission('users.manage'), 'even a corrupted flag on an admin row locks nobody out (has_permission)');
select ok(public.is_tenant_admin() and jsonb_array_length(public.fn_get_session_context() -> 'permissions') > 10 and (public.fn_get_session_context() ->> 'must_change_pin')::boolean = false, 'nor the session context');
select ok(cardinality(public.current_station_ids()) > 0, 'nor the station ids');
select tests.clear_auth();
delete from public.profile_secrets where profile_id = (select admin from _f);

-- ═════════ PIN verification still works while flagged; the change clears the flag ═════════
select tests.authenticate_as_service_role();
select public.fn_set_user_pin((select cashier from _f), tests.pin_digest('834921'));   -- unrelated user: only to prove the flag is per user
select tests.clear_auth();
update public.profile_secrets set pin_hash = extensions.crypt(tests.pin_digest('4829'), extensions.gen_salt('bf', 4)) where profile_id = (select waiter from _f);
select tests.authenticate_as_service_role();
select is(public.fn_verify_pin((select waiter from _f), tests.pin_digest('4829')) ->> 'status', 'ok', 'a flagged user can still verify the current PIN (pin-login / pin-change need it)');
select is((select must_change_pin from public.profile_secrets where profile_id = (select waiter from _f)), true, 'verifying does not clear the flag');
select tests.clear_auth();
-- admin lockout reset must not clear it
update public.profile_secrets set failed_attempts = 4, locked_until = now() + interval '1 hour' where profile_id = (select waiter from _f);
select tests.authenticate_as((select admin from _f));
select is((public.fn_reset_pin_lockout((select waiter from _f)) ->> 'reset')::boolean, true, 'tenant_admin resets the lockout');
select tests.clear_auth();
select is((select must_change_pin from public.profile_secrets where profile_id = (select waiter from _f)), true, 'the lockout reset did not clear must_change_pin');
select is((select failed_attempts from public.profile_secrets where profile_id = (select waiter from _f)), 0, '(but did reset the counter)');
select tests.authenticate_as_service_role();
select lives_ok(format($q$select public.fn_set_user_pin(%L, %L, 4)$q$, (select waiter from _f), tests.pin_digest('7391')), 'fn_set_user_pin (the PIN change)');
select tests.clear_auth();
select is((select must_change_pin from public.profile_secrets where profile_id = (select waiter from _f)), false, 'a new PIN clears must_change_pin');
select tests.authenticate_as((select waiter from _f));
select ok(public.has_permission('orders.create'), 'permissions are back immediately');
select is((public.fn_get_session_context() ->> 'must_change_pin')::boolean, false, 'and the session context says so');
select ok((select count(*) from public.menu_items) > 0, 'RLS reads work again');
select tests.clear_auth();

-- ═════════ Realtime ═════════
select is((select string_agg(a, ',' order by a) from pg_publication_tables pt, unnest(pt.attnames) a where pt.pubname = 'supabase_realtime' and pt.tablename = 'user_notifications'),
          'created_at,id,kind,payload,read_at,recipient_id,restaurant_id', 'published with an explicit column list');
select is((select c.relreplident::text from pg_class c where c.oid = 'public.user_notifications'::regclass), 'i', 'REPLICA IDENTITY USING INDEX');
select is((select string_agg(a.attname, ',' order by a.attname) from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey) where i.indrelid = 'public.user_notifications'::regclass and i.indisreplident), 'id,restaurant_id', 'on (restaurant_id, id)');

select * from finish();
rollback;
