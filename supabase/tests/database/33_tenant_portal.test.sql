-- Phase 3B, Tenant Portal administration RPCs (migration 0031): roles, station access, users, PIN reset preparation,
-- restaurant profile / business settings / branding (+ tenant-branding Storage policies), own subscription usage.
-- Functional + validation + audit + replay + cross-tenant + escalation. Platform-side separation: 34_portal_separation.
begin;
select plan(89);

create temp table _f on commit drop as
select tests.tenant_id('central-cafe') a, tests.tenant_id('second-cafe') b,
       tests.user_id('selam', 'central-cafe') admin, tests.user_id('dawit', 'central-cafe') admin2,
       tests.user_id('yonas', 'central-cafe') waiter, tests.user_id('meron', 'central-cafe') meron,
       tests.user_id('hanna', 'central-cafe') cashier, tests.user_id('abebe', 'central-cafe') kitchen,
       tests.user_id('waiter', 'second-cafe') b_waiter,
       tests.admin_role_id('central-cafe') admin_role, tests.role_id('Cashier', 'central-cafe') cashier_role,
       tests.role_id('Waiter', 'central-cafe') waiter_role, tests.role_id('Kitchen', 'central-cafe') kitchen_role,
       tests.role_id('Waiter', 'second-cafe') b_waiter_role,
       (select id from public.stations where restaurant_id = tests.tenant_id('central-cafe') and name = 'Kitchen') st_kitchen,
       (select id from public.stations where restaurant_id = tests.tenant_id('central-cafe') and name = 'Bar') st_bar,
       (select id from public.stations where restaurant_id = tests.tenant_id('second-cafe') and name = 'Kitchen') b_station;
grant all on _f to public;
create temp table _c (k text primary key, v text);
grant all on _c to public;

-- ═════════ roles ═════════
select tests.aal2((select admin from _f));
select is(tests.run($q$select public.fn_create_role('{"name": "Runner", "color": "red"}')$q$), 'P0001|invalid_input|color', 'colour must be #rrggbb');
select is(tests.run($q$select public.fn_create_role('{"name": "Runner", "icon": "<svg>"}')$q$), 'P0001|invalid_input|icon', 'icon is a safe slug');
select is(tests.run($q$select public.fn_create_role('{"name": "Runner", "system_key": "tenant_admin"}')$q$), 'P0001|invalid_input|patch', 'closed key list: system_key / is_system can never be passed');
select is(tests.run($q$select public.fn_create_role('{"name": "   "}')$q$), 'P0001|invalid_input|name', 'name required');
select is(tests.run($q$select public.fn_create_role('{"name": " waiter "}')$q$), 'P0001|duplicate_name|waiter', 'names are unique per tenant after normalisation');
insert into _c select 'runner', public.fn_create_role('{"name": "Runner", "color": "#AABBCC", "icon": "footprints", "sort_order": 70}') ->> 'id';
select is((select color from public.roles where id = (select v::uuid from _c where k = 'runner')), '#aabbcc', 'colour stored lower-case');
select is((select is_system from public.roles where id = (select v::uuid from _c where k = 'runner')), false, 'a created role is never a system role');
select is((select count(*)::int from public.role_permissions where role_id = (select v::uuid from _c where k = 'runner')), 0, 'and starts with no permission');
select is((select count(*)::int from public.audit_logs where event = 'role.created' and actor_id = (select admin from _f)), 1, 'role.created audited with the real actor');
select is((select public.fn_update_role((select v::uuid from _c where k = 'runner'), '{"name": "Food Runner", "description": "brings plates"}') ->> 'name'), 'Food Runner', 'rename + describe');
select is((select public.fn_update_role((select v::uuid from _c where k = 'runner'), '{"name": "Food Runner"}') ->> 'name'), 'Food Runner', 'replay of the same patch');
select is((select count(*)::int from public.audit_logs where event = 'role.updated'), 1, 'a no-op update writes no event');
select is(tests.run(format($q$select public.fn_update_role(%L, '{"name": "Boss"}')$q$, (select admin_role from _f))), 'P0001|system_role_protected|', 'tenant_admin role cannot be renamed');
select is(tests.run(format($q$select public.fn_set_role_active(%L, false)$q$, (select admin_role from _f))), 'P0001|system_role_protected|', 'nor disabled');
select is(tests.run(format($q$select public.fn_delete_role(%L)$q$, (select admin_role from _f))), 'P0001|system_role_protected|', 'nor deleted');
select is(tests.run(format($q$select public.fn_update_role(%L, '{"name": "x"}')$q$, (select b_waiter_role from _f))), 'P0001|not_found|', 'another tenant''s role: not_found');
-- station access
select is((select public.fn_set_role_station_access((select v::uuid from _c where k = 'runner'), array[(select st_kitchen from _f)]) -> 'stations_added' ->> 0),
          (select st_kitchen::text from _f), 'station access granted');
select lives_ok(format($q$select public.fn_update_role_permissions(%L, array['orders.view'], array[%L]::uuid[])$q$, (select v from _c where k = 'runner'), (select st_kitchen from _f)), 'matrix set');
select is((select public.fn_set_role_station_access((select v::uuid from _c where k = 'runner'), array[(select st_bar from _f)]) -> 'stations_removed' ->> 0),
          (select st_kitchen::text from _f), 'station access replaced');
select is((select count(*)::int from public.role_permissions rp join public.permissions p on p.id = rp.permission_id
           where rp.role_id = (select v::uuid from _c where k = 'runner') and p.key = 'orders.view'), 1, 'station access never touches the permission keys');
select is(tests.run(format($q$select public.fn_set_role_station_access(%L, array[%L]::uuid[])$q$, (select v from _c where k = 'runner'), (select b_station from _f))), 'P0001|invalid_station|', 'another tenant''s station: invalid_station');
select is(tests.run(format($q$select public.fn_set_role_station_access(%L, '{}')$q$, (select admin_role from _f))), 'P0001|system_role_protected|', 'tenant_admin station access is implicit (all) and immutable');
-- deactivation dependency guard
select is(tests.run(format($q$select public.fn_set_role_active(%L, false)$q$, (select cashier_role from _f))), 'P0001|role_in_use|active_users:1', 'a role with active users cannot be deactivated');
select is((select public.fn_set_role_active((select v::uuid from _c where k = 'runner'), false) ->> 'changed'), 'true', 'an unused role can');
select is((select public.fn_set_role_active((select v::uuid from _c where k = 'runner'), false) ->> 'changed'), 'false', 'replay: no-op');
select is(tests.run(format($q$select public.fn_change_user_role(%L, %L)$q$, (select meron from _f), (select v from _c where k = 'runner'))), 'P0001|invalid_role|', 'an inactive role cannot be assigned');
select is((select public.fn_set_role_active((select v::uuid from _c where k = 'runner'), true) ->> 'is_active'), 'true', 'reactivate');
select is(tests.run(format($q$select public.fn_change_user_role(%L, %L)$q$, (select meron from _f), (select v from _c where k = 'runner'))), 'ok:1', 'assign it');
select is(tests.run(format($q$select public.fn_delete_role(%L)$q$, (select v from _c where k = 'runner'))), 'P0001|role_in_use|users:1', 'a role ever held by someone cannot be deleted');
select is((select (r ->> 'active_users')::int from jsonb_array_elements(public.fn_list_roles()) r where (r ->> 'id')::uuid = (select v::uuid from _c where k = 'runner')), 1, 'fn_list_roles carries user counts');
select is((select jsonb_array_length(r -> 'permission_keys') = (select count(*)::int from public.permissions) from jsonb_array_elements(public.fn_list_roles()) r where r ->> 'system_key' = 'tenant_admin'), true,
          'fn_list_roles shows tenant_admin with every permission');
insert into _c select 'temp', public.fn_create_role('{"name": "Temp"}') ->> 'id';
select lives_ok(format($q$select public.fn_update_role_permissions(%L, array['menu.view'], array[%L]::uuid[])$q$, (select v from _c where k = 'temp'), (select st_bar from _f)), 'temp role gets a matrix');
select is((select public.fn_delete_role((select v::uuid from _c where k = 'temp')) ->> 'deleted'), 'true', 'an unused role is deleted with its matrix');
select is(tests.run(format($q$select public.fn_delete_role(%L)$q$, (select v from _c where k = 'temp'))), 'P0001|not_found|', 'replay: not_found');
select tests.clear_auth();
select is((select count(*)::int from public.audit_logs where event in ('role.deactivated', 'role.reactivated', 'role.deleted')), 3, 'deactivate / reactivate / delete are audited (no-ops are not)');

-- step-up: an enrolled admin on aal1
select tests.add_verified_factor((select admin2 from _f));
select tests.authenticate_as((select admin2 from _f));
select is(tests.run($q$select public.fn_create_role('{"name": "Stepless"}')$q$), 'P0001|mfa_required|', 'enrolled admin on aal1: role commands need the TOTP step-up');
select is(tests.run(format($q$select public.fn_set_user_active(%L, false)$q$, (select waiter from _f))), 'P0001|mfa_required|', '... and so do account-state changes');
select tests.clear_auth();

-- a plain waiter: no roles.manage / users.manage / settings.manage
select tests.authenticate_as((select waiter from _f));
select is(tests.run($q$select public.fn_list_roles()$q$) || tests.run($q$select public.fn_create_role('{"name": "Mine"}')$q$)
          || tests.run(format($q$select public.fn_set_role_active(%L, false)$q$, (select kitchen_role from _f))),
          'P0001|permission_denied|P0001|permission_denied|P0001|permission_denied|', 'waiter: every role command is permission_denied');
select is(tests.run('select public.fn_list_users()') || tests.run(format($q$select public.fn_update_user(%L, '{"first_name": "X"}')$q$, (select meron from _f))),
          'P0001|permission_denied|P0001|permission_denied|', 'waiter: user listing / editing denied');
select is(tests.run('select public.fn_get_restaurant_profile()') || tests.run($q$select public.fn_update_restaurant_profile('{"name": "Mine"}')$q$)
          || tests.run('select public.fn_get_subscription_usage()'),
          'P0001|permission_denied|P0001|permission_denied|P0001|permission_denied|', 'waiter: restaurant settings and usage denied');
select tests.clear_auth();

-- ═════════ users ═════════
select tests.aal2((select admin from _f));
create temp table _users on commit drop as select public.fn_list_users() u;
grant all on _users to public;
select is((select jsonb_array_length(u) from _users), 8, 'every staff account of the tenant');
select is((select count(*)::int from _users, jsonb_array_elements(u) e where e ->> 'email' like '%.invalid'), 0, 'synthetic staff identities are never shown');
select is((select e ->> 'email' from _users, jsonb_array_elements(u) e where (e ->> 'id')::uuid = (select admin from _f)), 'selam@centralcafe.example.com', 'admins'' real e-mail is shown');
select is((select e -> 'pin' ->> 'length' from _users, jsonb_array_elements(u) e where (e ->> 'id')::uuid = (select cashier from _f)), '6', 'PIN status (never the hash) for users.manage');
select ok(not ((select u::text from _users) ~* '(pin_hash|\$2[aby]\$)'), 'no secret in the listing');
select is(tests.run(format($q$select public.fn_update_user(%L, '{"username": "hijack"}')$q$, (select meron from _f))), 'P0001|invalid_input|patch', 'username is not editable (synthetic identity)');
select is(tests.run(format($q$select public.fn_update_user(%L, '{"first_name": ""}')$q$, (select meron from _f))), 'P0001|invalid_input|first_name', 'first name required');
select is((select public.fn_update_user((select meron from _f), '{"middle_name": "Haile", "last_name": null}') ->> 'short_name'), 'Meron Haile', 'names edited (short = First + Middle)');
select is((select count(*)::int from public.audit_logs where event = 'user.updated' and actor_id = (select admin from _f)), 1, 'user.updated audited');
select is(tests.run(format($q$select public.fn_update_user(%L, '{"first_name": "x"}')$q$, (select b_waiter from _f))), 'P0001|not_found|', 'another tenant''s user: not_found');
select is((select public.fn_set_user_active((select waiter from _f), false) ->> 'changed'), 'true', 'deactivate a user');
select is((select public.fn_set_user_active((select waiter from _f), false) ->> 'changed'), 'false', 'replay: no-op');
select is(tests.run(format($q$select public.fn_set_user_active(%L, false)$q$, (select admin from _f))), 'P0001|permission_denied|cannot change your own account state', 'never yourself');
select lives_ok(format($q$select public.fn_set_user_active(%L, true)$q$, (select waiter from _f)), 'reactivate');
select tests.clear_auth();
select is((select count(*)::int from public.audit_logs where event in ('user.deactivated', 'user.reactivated')), 2, 'account-state changes audited once each');
-- reactivation rules: an inactive role, the plan's staff cap
update public.roles set is_active = false where id = (select kitchen_role from _f);   -- owner path (the RPC would refuse: abebe is active)
update public.profiles set is_active = false where id = (select kitchen from _f);
select tests.aal2((select admin from _f));
select is(tests.run(format($q$select public.fn_set_user_active(%L, true)$q$, (select kitchen from _f))), 'P0001|invalid_role|role is inactive', 'reactivation needs an active role');
select tests.clear_auth();
update public.roles set is_active = true where id = (select kitchen_role from _f);
update public.plans set max_staff = (select count(*) from public.profiles where restaurant_id = (select a from _f) and is_active) where name = 'Growth';
select tests.aal2((select admin from _f));
select is(tests.run(format($q$select public.fn_set_user_active(%L, true)$q$, (select kitchen from _f))), 'P0001|staff_limit_reached|', 'reactivation respects the plan''s staff cap');
select tests.clear_auth();
update public.plans set max_staff = 25 where name = 'Growth';

-- PIN reset preparation (step 1 of the staff-pin-reset Edge Function)
select tests.aal2((select admin from _f));
select is((select public.fn_prepare_pin_reset((select cashier from _f)) ->> 'pin_length'), '6', 'Cashier: 6-digit PIN');
select is((select public.fn_prepare_pin_reset((select meron from _f)) ->> 'pin_length'), '4', 'other roles: 4 digits');
select is(tests.run(format($q$select public.fn_prepare_pin_reset(%L)$q$, (select admin2 from _f))), 'P0001|pin_not_allowed|', 'a tenant_admin never gets a PIN');
select is(tests.run(format($q$select public.fn_prepare_pin_reset(%L)$q$, (select kitchen from _f))), 'P0001|invalid_state|inactive', 'an inactive account gets no PIN');
select is(tests.run(format($q$select public.fn_prepare_pin_reset(%L)$q$, (select b_waiter from _f))), 'P0001|not_found|', 'another tenant''s staff: not_found');
select is(tests.run('select public.fn_set_user_pin(gen_random_uuid(), repeat($$a$$, 64))'), '42501|permission denied for function fn_set_user_pin|', 'step 2 (the hash write) is service_role only');
select tests.clear_auth();
select is((select count(*)::int from public.audit_logs where event = 'auth.pin_reset_requested' and actor_id = (select admin from _f)), 2, 'each prepared reset is audited with the real actor');

-- ═════════ restaurant profile / business settings / branding ═════════
delete from auth.mfa_factors where user_id = (select admin from _f);   -- back to a factor-less admin for the aal1 checks below
select tests.authenticate_as((select admin from _f));
select is((select public.fn_get_restaurant_profile() ->> 'slug'), 'central-cafe', 'profile of the own tenant');
select is(tests.run($q$select public.fn_update_restaurant_profile('{"slug": "hijack"}')$q$), 'P0001|invalid_input|patch', 'slug / status / tenant id are never patchable');
select is(tests.run($q$select public.fn_update_restaurant_profile('{"phone": "call me"}')$q$), 'P0001|invalid_input|phone', 'phone format');
select is((select public.fn_update_restaurant_profile('{"name": "Central Cafe Bole", "phone": "+251 911 223344", "address": null, "timezone": "Africa/Addis_Ababa"}') ->> 'name'), 'Central Cafe Bole', 'profile updated');
select is((select count(*)::int from public.audit_logs where event = 'settings.restaurant_profile_updated'), 1, 'audited with old / new');
select is(tests.run('select public.fn_update_business_settings($${"vat_rate": 15.5}$$)'), 'P0001|mfa_required|', 'business (money) settings need aal2');
select tests.aal2((select admin from _f));
select is((select public.fn_update_business_settings('{"vat_rate": 15.5, "opening_float": 3000, "auto_consume_stock": false, "tin": "0032918475"}') ->> 'vat_rate'), '15.50', 'business settings on aal2');
select is(tests.run($q$select public.fn_update_business_settings('{"vat_rate": 100.001}')$q$), 'P0001|invalid_input|vat_rate', 'vat 0..100, 2 decimals');
select is(tests.run($q$select public.fn_update_business_settings('{"opening_float": -1}')$q$), 'P0001|invalid_input|opening_float', 'no negative float');
select is(tests.run($q$select public.fn_update_business_settings('{"auto_consume_stock": "yes"}')$q$), 'P0001|invalid_input|auto_consume_stock', 'boolean only');
-- branding
select is(tests.run($q$select public.fn_update_restaurant_branding('red', '#000000', null)$q$), 'P0001|invalid_input|primary_color', 'strict #rrggbb (primary)');
select is(tests.run($q$select public.fn_update_restaurant_branding('#112233', '#12345', null)$q$), 'P0001|invalid_input|accent_color', 'strict #rrggbb (accent)');
select is(tests.run(format($q$select public.fn_update_restaurant_branding('#112233', '#445566', 'restaurants/%s/branding/logo.png')$q$, (select a from _f))), 'P0001|invalid_input|logo_path', 'the logo object must really be uploaded');
select is(tests.run(format($q$insert into storage.objects (bucket_id, name) values ('tenant-branding', 'restaurants/%s/branding/logo.png')$q$, (select a from _f))), 'ok:1', 'settings.manage uploads into the own branding prefix');
select is(tests.run(format($q$insert into storage.objects (bucket_id, name) values ('tenant-branding', 'restaurants/%s/branding/logo.svg')$q$, (select a from _f))),
          '42501|new row violates row-level security policy for table "objects"|', 'SVG (script-capable) is refused');
select is(tests.run(format($q$insert into storage.objects (bucket_id, name) values ('tenant-branding', 'restaurants/%s/branding/logo.png')$q$, (select b from _f))),
          '42501|new row violates row-level security policy for table "objects"|', 'another tenant''s prefix is refused');
select is((select public.fn_update_restaurant_branding('#ABCDEF', '#445566', format('restaurants/%s/branding/logo.png', (select a from _f))) -> 'branding' ->> 'primary_color'), '#abcdef', 'branding set (colours lower-cased)');
-- real Supabase Storage refuses every direct DELETE (42501, Storage API only); the shim lets the policy decide (0 rows)
select matches(tests.run(format($q$delete from storage.objects where bucket_id = 'tenant-branding' and name = 'restaurants/%s/branding/logo.png'$q$, (select a from _f))),
               '^(ok:0|42501\|Direct deletion from storage tables is not allowed\. Use the Storage API instead\.\|)$', 'the current logo cannot be deleted while in use');
select is((select public.fn_update_restaurant_branding('#abcdef', '#445566', null) -> 'branding' ->> 'logo_path'), null, 'logo removed');
select is((select count(*)::int from public.audit_logs where event = 'settings.branding_updated'), 2, 'branding changes audited');
select ok((select public.fn_get_subscription_usage() ?& array['usage', 'limits', 'over_quota', 'subscription']), 'own subscription + usage for settings.manage');
select tests.clear_auth();
select tests.authenticate_as((select waiter from _f));
select is((select count(*)::int from storage.objects where bucket_id = 'tenant-branding'), 1, 'every member of the tenant can read the own branding objects (the shell shows the logo)');
select is(tests.run(format($q$insert into storage.objects (bucket_id, name) values ('tenant-branding', 'restaurants/%s/branding/mine.png')$q$, (select a from _f))),
          '42501|new row violates row-level security policy for table "objects"|', 'without settings.manage: no upload');
select tests.clear_auth();
select tests.authenticate_as(tests.user_id('owner', 'second-cafe'));
select is((select count(*)::int from storage.objects where bucket_id = 'tenant-branding'), 0, 'another tenant reads none of them');
select is(tests.run(format($q$select public.fn_update_restaurant_branding('#112233', '#445566', 'restaurants/%s/branding/logo.png')$q$, (select a from _f))), 'P0001|invalid_input|logo_path', 'nor can it point its logo at them');
select tests.clear_auth();

select * from finish();
rollback;
