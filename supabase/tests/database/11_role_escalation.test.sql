-- Adversarial: privilege / role escalation inside a tenant and across tenants.
-- Actors: a PIN waiter (no admin rights), a delegated "Supervisor" (users.manage + roles.manage, NOT admin),
-- the tenant_admin, and tenant B's admin.
begin;
select plan(77);

create temp table _f on commit drop as
select tests.tenant_id('central-cafe') a, tests.tenant_id('second-cafe') b,
       tests.user_id('selam', 'central-cafe') admin1, tests.user_id('dawit', 'central-cafe') admin2,
       tests.user_id('yonas', 'central-cafe') waiter, tests.user_id('meron', 'central-cafe') supervisor,
       tests.user_id('hanna', 'central-cafe') cashier, tests.user_id('abebe', 'central-cafe') kitchen,
       tests.user_id('owner', 'second-cafe') b_admin, tests.user_id('waiter', 'second-cafe') b_waiter,
       tests.admin_role_id('central-cafe') admin_role, tests.admin_role_id('second-cafe') b_admin_role,
       tests.role_id('Waiter', 'central-cafe') waiter_role, tests.role_id('Cashier', 'central-cafe') cashier_role,
       tests.role_id('Kitchen', 'central-cafe') kitchen_role, tests.role_id('Waiter', 'second-cafe') b_waiter_role,
       (select id from public.stations where restaurant_id = tests.tenant_id('central-cafe') and name = 'Kitchen') st_kitchen,
       (select id from public.stations where restaurant_id = tests.tenant_id('central-cafe') and name = 'Bar') st_bar,
       (select id from public.permissions where key = 'settings.manage') perm_settings;
grant all on _f to public;
create temp table _ctx (supervisor_role uuid);
grant all on _ctx to public;

-- the admin delegates: creates the Supervisor role (users.manage + users.view + roles.manage + a few view rights)
select tests.aal2((select admin1 from _f));
insert into _ctx select (public.fn_create_role('{"name": "Supervisor", "description": "delegated staff management"}') ->> 'id')::uuid;
select lives_ok(format($q$select public.fn_update_role_permissions(%L, array['users.manage','users.view','roles.manage','menu.view','orders.view','dashboard.view'], array[%L]::uuid[])$q$,
                       (select supervisor_role from _ctx), (select st_kitchen from _f)),
                'admin builds a delegated role (users.manage + roles.manage + kitchen station)');
select lives_ok(format($q$select public.fn_change_user_role(%L, %L)$q$, (select supervisor from _f), (select supervisor_role from _ctx)),
                'admin assigns the delegated role to a staff member');
select tests.clear_auth();

-- ═════════ a plain waiter ═════════
select tests.authenticate_as((select waiter from _f));
select is(tests.run(format($q$select public.fn_change_user_role(%L, %L)$q$, (select waiter from _f), (select admin_role from _f))),
          'P0001|permission_denied|', 'waiter -> tenant_admin via fn_change_user_role (self) is denied');
select is(tests.run(format($q$select public.fn_change_user_role(%L, %L)$q$, (select cashier from _f), (select admin_role from _f))),
          'P0001|permission_denied|', 'waiter promoting someone else to tenant_admin is denied');
select is(tests.run(format($q$update public.profiles set role_id = %L where id = %L$q$, (select admin_role from _f), (select waiter from _f))),
          '42501|permission denied for table profiles|', 'waiter: direct UPDATE profiles.role_id denied (column grant)');
select is(tests.run(format($q$update public.profiles set auth_method = 'password' where id = %L$q$, (select waiter from _f))),
          '42501|permission denied for table profiles|', 'waiter: direct UPDATE profiles.auth_method denied');
select is(tests.run(format($q$update public.profiles set restaurant_id = %L where id = %L$q$, (select b from _f), (select waiter from _f))),
          '42501|permission denied for table profiles|', 'waiter: direct UPDATE profiles.restaurant_id denied');
select is(tests.run(format($q$update public.profiles set is_active = true where id = %L$q$, (select waiter from _f))),
          '42501|permission denied for table profiles|', 'waiter: no client UPDATE on profiles at all (0031)');
select is(tests.run(format($q$select public.fn_update_role_permissions(%L, array['settings.manage'], '{}')$q$, (select waiter_role from _f))),
          'P0001|permission_denied|', 'waiter cannot edit the matrix (even of its own role)');
select is(tests.run(format($q$insert into public.role_permissions (role_id, permission_id, restaurant_id) values (%L, %L, %L)$q$,
                           (select waiter_role from _f), (select perm_settings from _f), (select a from _f))),
          '42501|permission denied for table role_permissions|', 'waiter: direct INSERT role_permissions denied');
select is(tests.run(format($q$insert into public.role_station_access (role_id, station_id, restaurant_id) values (%L, %L, %L)$q$,
                           (select waiter_role from _f), (select st_bar from _f), (select a from _f))),
          '42501|permission denied for table role_station_access|', 'waiter: direct INSERT role_station_access denied');
select is(tests.run($q$insert into public.permissions (key, module, description) values ('god.mode', 'x', 'x')$q$),
          '42501|permission denied for table permissions|', 'waiter cannot extend the permission catalog');
select is(tests.run($q$update public.permissions set key = 'orders.view' where key = 'users.manage'$q$),
          '42501|permission denied for table permissions|', 'waiter cannot rewrite the permission catalog');
select tests.clear_auth();

-- ═════════ delegated Supervisor (users.manage + roles.manage, not admin) ═════════
select tests.aal2((select supervisor from _f));
select ok(public.has_permission('users.manage') and public.has_permission('roles.manage'), 'supervisor holds the delegated rights');
select ok(not public.is_tenant_admin(), 'supervisor is not a tenant_admin');
select is(tests.run(format($q$select public.fn_change_user_role(%L, %L)$q$, (select waiter from _f), (select admin_role from _f))),
          'P0001|permission_denied|tenant_admin assignment requires tenant_admin', 'supervisor cannot assign the tenant_admin role');
select is(tests.run(format($q$select public.fn_change_user_role(%L, %L)$q$, (select admin2 from _f), (select waiter_role from _f))),
          'P0001|permission_denied|tenant_admin assignment requires tenant_admin', 'supervisor cannot demote a tenant_admin');
select is(tests.run(format($q$select public.fn_change_user_role(%L, %L)$q$, (select supervisor from _f), (select cashier_role from _f))),
          'P0001|permission_denied|cannot change your own role', 'supervisor cannot change its own role');
select is(tests.run(format($q$select public.fn_change_user_role(%L, %L)$q$, (select waiter from _f), (select cashier_role from _f))),
          'P0001|permission_escalation|', 'supervisor cannot assign a role holding rights it lacks (Cashier)');
select is(tests.run(format($q$select public.fn_update_role_permissions(%L, array['payments.create'], '{}')$q$, (select waiter_role from _f))),
          'P0001|permission_escalation|payments.create', 'supervisor cannot grant a permission it does not hold');
select is(tests.run(format($q$select public.fn_update_role_permissions(%L, array['orders.view','settings.manage'], '{}')$q$, (select waiter_role from _f))),
          'P0001|permission_escalation|settings.manage', 'supervisor cannot smuggle one forbidden key among allowed ones');
select is(tests.run(format($q$select public.fn_update_role_permissions(%L, array['orders.view'], array[%L]::uuid[])$q$, (select waiter_role from _f), (select st_bar from _f))),
          'P0001|permission_escalation|station', 'supervisor cannot grant station access it lacks');
select is(tests.run(format($q$select public.fn_update_role_permissions(%L, '{}', '{}')$q$, (select supervisor_role from _ctx))),
          'P0001|permission_denied|cannot edit your own role', 'supervisor cannot edit its own role matrix');
select is(tests.run(format($q$select public.fn_update_role_permissions(%L, '{}', '{}')$q$, (select admin_role from _f))),
          'P0001|system_role_protected|', 'supervisor cannot edit the tenant_admin matrix');
select is(tests.run(format($q$select public.fn_update_role_permissions(%L, array['orders.view','menu.view'], array[%L]::uuid[])$q$, (select kitchen_role from _f), (select st_kitchen from _f))),
          'ok:1', 'delegation works within the supervisor''s own rights');
-- direct table writes
select is(tests.run(format($q$update public.profiles set role_id = %L where id = %L$q$, (select admin_role from _f), (select supervisor from _f))),
          '42501|permission denied for table profiles|', 'supervisor: direct role_id update denied (must go through the RPC)');
select is(tests.run(format($q$update public.profiles set auth_method = 'password' where id = %L$q$, (select supervisor from _f))),
          '42501|permission denied for table profiles|', 'supervisor: direct auth_method update denied');
select is(tests.run(format($q$update public.profiles set restaurant_id = %L where id = %L$q$, (select b from _f), (select waiter from _f))),
          '42501|permission denied for table profiles|', 'supervisor: moving staff to another tenant denied');
select is(tests.run(format($q$select public.fn_set_user_active(%L, false)$q$, (select admin1 from _f))),
          'P0001|permission_denied|tenant_admin accounts require tenant_admin', 'supervisor cannot deactivate a tenant_admin');
select is(tests.run(format($q$select public.fn_update_user(%L, '{"first_name": "Pwned"}')$q$, (select admin2 from _f))),
          'P0001|permission_denied|tenant_admin accounts require tenant_admin', 'supervisor cannot edit a tenant_admin profile');
select is(tests.run(format($q$select public.fn_update_user(%L, %L::jsonb)$q$, (select waiter from _f),
                           jsonb_build_object('first_name', (select first_name from public.profiles where id = (select waiter from _f))))),
          'ok:1', 'supervisor can edit ordinary staff (control; an unchanged name needs no coverage)');
select is(tests.run(format($q$insert into public.roles (restaurant_id, name, is_system, system_key) values (%L, 'Shadow Admin', true, 'tenant_admin')$q$, (select a from _f))),
          '42501|permission denied for table roles|', 'supervisor cannot create a role with system_key / is_system');
select is(tests.run(format($q$insert into public.roles (restaurant_id, name, is_system) values (%L, 'Shadow Admin', true)$q$, (select a from _f))),
          '42501|permission denied for table roles|', 'supervisor cannot create a role with is_system');
select is(tests.run($q$select public.fn_create_role('{"name": "Barista Trainee"}')$q$),
          'ok:1', 'supervisor can create an ordinary role through the RPC (control)');
select is(tests.run($q$update public.roles set system_key = 'tenant_admin' where name = 'Kitchen'$q$),
          '42501|permission denied for table roles|', 'supervisor cannot promote a role to system role');
select is(tests.run(format($q$select public.fn_update_role(%L, '{"name": "x"}')$q$, (select admin_role from _f))),
          'P0001|system_role_protected|', 'supervisor cannot rename the tenant_admin role');
select is(tests.run(format($q$select public.fn_set_role_active(%L, false)$q$, (select admin_role from _f))),
          'P0001|system_role_protected|', 'supervisor cannot deactivate the tenant_admin role');
select is(tests.run(format($q$select public.fn_delete_role(%L)$q$, (select admin_role from _f))), 'P0001|system_role_protected|', 'supervisor cannot delete the tenant_admin role');
select is(tests.run(format($q$select public.fn_update_role(%L, '{"name": "Head Cashier"}')$q$, (select cashier_role from _f))),
          'P0001|permission_escalation|', 'supervisor cannot rename a role holding rights it lacks');
select is(tests.run(format($q$select public.fn_set_role_active(%L, false)$q$, (select supervisor_role from _ctx))),
          'P0001|permission_denied|cannot edit your own role', 'supervisor cannot deactivate its own role');
select is(tests.run(format($q$insert into public.role_permissions (role_id, permission_id, restaurant_id) values (%L, %L, %L)$q$,
                           (select supervisor_role from _ctx), (select perm_settings from _f), (select a from _f))),
          '42501|permission denied for table role_permissions|', 'supervisor cannot self-grant through a direct matrix insert');
select is(tests.run(format($q$delete from public.role_permissions where role_id = %L$q$, (select waiter_role from _f))),
          '42501|permission denied for table role_permissions|', 'supervisor cannot strip a matrix through a direct delete');
-- cross-tenant
select is(tests.oracle($q$select public.fn_update_role_permissions({id}, array['orders.view'], '{}')$q$, (select b_waiter_role from _f)),
          'P0001|not_found|', 'supervisor: B role edit is not_found (same as unknown)');
select is(tests.oracle(format($q$select public.fn_change_user_role({id}, %L)$q$, (select cashier_role from _f)), (select b_waiter from _f)),
          'P0001|not_found|', 'supervisor: B profile role change is not_found');
select is(tests.run(format($q$insert into public.role_permissions (role_id, permission_id, restaurant_id) values (%L, %L, %L)$q$,
                           (select b_waiter_role from _f), (select perm_settings from _f), (select b from _f))),
          '42501|permission denied for table role_permissions|', 'supervisor: matrix insert into B denied');
select tests.clear_auth();
select is((select first_name from public.profiles where id = (select admin1 from _f)), 'Selam', 'tenant_admin profile unchanged by the supervisor');
select ok((select is_active from public.profiles where id = (select admin1 from _f)), 'tenant_admin still active');
select is((select count(*)::int from public.roles where system_key is not null and restaurant_id = (select a from _f)), 1, 'still exactly one system role');

-- ═════════ tenant_admin ═════════
select tests.aal2((select admin1 from _f));
select is(tests.run(format($q$insert into public.roles (restaurant_id, name, is_system, system_key) values (%L, 'Admin Clone', true, 'tenant_admin')$q$, (select a from _f))),
          '42501|permission denied for table roles|', 'even tenant_admin cannot create another system role');
select is(tests.run($q$update public.roles set is_active = false where system_key = 'tenant_admin'$q$), '42501|permission denied for table roles|', 'no client UPDATE on roles (0031)');
select is(tests.run(format($q$select public.fn_set_role_active(%L, false)$q$, (select admin_role from _f))), 'P0001|system_role_protected|', 'tenant_admin cannot deactivate its own system role');
select is(tests.run(format($q$select public.fn_update_role_permissions(%L, '{}', '{}')$q$, (select admin_role from _f))),
          'P0001|system_role_protected|', 'tenant_admin matrix is immutable');
select is(tests.run(format($q$select public.fn_change_user_role(%L, %L)$q$, (select waiter from _f), (select b_admin_role from _f))),
          'P0001|invalid_role|', 'cannot assign another tenant''s tenant_admin role');
select is(tests.run(format($q$select public.fn_change_user_role(%L, %L)$q$, (select b_waiter from _f), (select admin_role from _f))),
          'P0001|not_found|', 'cannot promote another tenant''s staff');
select is(tests.run(format($q$insert into public.role_permissions (role_id, permission_id, restaurant_id) values (%L, %L, %L)$q$,
                           (select waiter_role from _f), (select perm_settings from _f), (select a from _f))),
          '42501|permission denied for table role_permissions|', 'tenant_admin cannot write the matrix directly either');
select is(tests.run(format($q$select public.fn_update_role_permissions(%L, array['orders.view'], '{}')$q$, (select b_waiter_role from _f))),
          'P0001|not_found|', 'tenant_admin cannot edit another tenant''s role');
select is(tests.run(format($q$select public.fn_update_role_permissions(%L, array['platform.root'], '{}')$q$, (select waiter_role from _f))),
          'P0001|invalid_permission|platform.root', 'unknown permission keys are rejected');
-- inactive role: cannot be assigned, and it grants nothing
select lives_ok($q$select public.fn_set_role_active((select id from public.roles where name = 'Barista Trainee'), false)$q$, 'admin deactivates a custom role');
select is(tests.run(format($q$select public.fn_change_user_role(%L, (select id from public.roles where name = 'Barista Trainee' and restaurant_id = %L))$q$, (select waiter from _f), (select a from _f))),
          'P0001|invalid_role|', 'an inactive role cannot be assigned');
-- last-admin protection (admin2 is the only other admin)
select lives_ok(format($q$select public.fn_change_user_role(%L, %L)$q$, (select admin2 from _f), (select waiter_role from _f)), 'one of two admins can be demoted');
select is(tests.run(format($q$select public.fn_change_user_role(%L, %L)$q$, (select admin1 from _f), (select waiter_role from _f))),
          'P0001|last_tenant_admin|', 'the last admin cannot demote itself');
select is(tests.run(format($q$select public.fn_set_user_active(%L, false)$q$, (select admin1 from _f))),
          'P0001|permission_denied|cannot change your own account state', 'nobody deactivates itself through the RPC');
select tests.clear_auth();
select is(tests.run(format($q$update public.profiles set is_active = false where id = %L$q$, (select admin1 from _f))),
          'P0001|last_tenant_admin|', 'the last admin cannot be deactivated on any path (owner, trigger)');
select tests.clear_auth();
select is((select count(*)::int from public.profiles p join public.roles r on r.id = p.role_id
           where p.restaurant_id = (select a from _f) and r.system_key = 'tenant_admin' and p.is_active), 1, 'exactly one active tenant_admin remains');

-- ═════════ deactivated users and deactivated roles lose everything ═════════
select tests.aal2((select admin1 from _f));
select lives_ok(format($q$select public.fn_set_user_active(%L, false)$q$, (select supervisor from _f)), 'admin deactivates the supervisor');
select tests.clear_auth();
select tests.authenticate_as((select supervisor from _f));
select ok(not public.has_permission('users.manage'), 'deactivated user holds no permission');
select is((select public.current_restaurant_id()), null::uuid, 'deactivated user resolves to no tenant');
select is(tests.run(format($q$select public.fn_change_user_role(%L, %L)$q$, (select waiter from _f), (select kitchen_role from _f))),
          'P0001|permission_denied|', 'deactivated user is refused by RPCs');
select is((select count(*)::int from public.profiles), 0, 'deactivated user reads no profile');
select tests.clear_auth();
update public.profiles set is_active = true where id = (select supervisor from _f);
select tests.aal2((select admin1 from _f));
select is(tests.run(format($q$select public.fn_set_role_active(%L, false)$q$, (select supervisor_role from _ctx))),
          'P0001|role_in_use|active_users:1', 'a role still held by an active user cannot be deactivated (dependency guard)');
select tests.clear_auth();
update public.roles set is_active = false where id = (select supervisor_role from _ctx);   -- owner path: what an inactive role means
select tests.authenticate_as((select supervisor from _f));
select ok(not public.has_permission('users.manage'), 'a deactivated role grants nothing');
select ok(not public.has_station_access((select st_kitchen from _f)), 'a deactivated role grants no station access');
select tests.clear_auth();

-- ═════════ platform-level escalation attempts by tenant staff ═════════
select tests.aal2((select admin1 from _f));
select is(tests.run(format($q$insert into public.platform_admins (id, full_name, role) values (%L, 'Me', 'platform_super_admin')$q$, (select admin1 from _f))),
          '42501|permission denied for table platform_admins|', 'tenant_admin cannot register itself as platform admin');
select is(tests.run($q$select public.fn_provision_tenant('Evil', 'evil-cafe', gen_random_uuid(), 'e@e.example.com', 'E', null, null, gen_random_uuid(), null)$q$),
          'P0001|permission_denied|', 'tenant_admin cannot provision tenants');
select ok(not ((select public.fn_get_session_context()) ? 'platform_role'), 'session context grants no platform role to a tenant admin');
select tests.clear_auth();

-- ═════════ everything the attackers did was audited with the real actor, nothing was forged ═════════
select is((select count(*)::int from public.audit_logs where event = 'user.role_changed' and actor_id = (select admin1 from _f)), 2, 'role changes are audited with the real actor');
select is((select count(*)::int from public.audit_logs where event = 'user.role_changed' and actor_id = (select supervisor from _f)), 0, 'denied attempts left no success audit row');

select * from finish();
rollback;
