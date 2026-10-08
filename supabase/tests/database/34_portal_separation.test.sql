-- Phase 3B / §34A: the two portals are separated at the DATABASE layer.
--   * a platform super admin (aal2, verified factor) reads ZERO rows of every tenant operational table and cannot run any tenant RPC;
--   * tenant users (tenant_admin on aal2 included) cannot run any platform RPC and read no platform-only table;
--   * every platform RPC refuses aal1, a factor-less aal2 claim and an inactive admin;
--   * the platform tenant detail carries metadata + aggregate counters only (no operational row content);
--   * an auth user is never both a platform admin and a tenant profile (every path).
-- The RPC sweeps are generic (catalog driven): a NEW tenant or platform RPC is covered without editing this file.
begin;
select plan(28);

create temp table _f on commit drop as
select tests.tenant_id('central-cafe') a, tests.tenant_id('second-cafe') b,
       '00000000-0000-4000-8000-0000000000c1'::uuid su,
       tests.user_id('selam', 'central-cafe') a_admin, tests.user_id('yonas', 'central-cafe') a_waiter,
       tests.user_id('owner', 'second-cafe') b_admin, tests.user_id('waiter', 'second-cafe') b_waiter,
       (select id from public.stations where restaurant_id = tests.tenant_id('second-cafe') and name = 'Kitchen') b_station,
       (select id from public.payment_methods where restaurant_id = tests.tenant_id('second-cafe') and name = 'Cash') b_method,
       (select id from public.expense_categories where restaurant_id = tests.tenant_id('second-cafe') and name = 'Rent') b_expcat,
       (select id from public.menu_items where restaurant_id = tests.tenant_id('second-cafe') limit 1) b_menu,
       (select id from public.tables where restaurant_id = tests.tenant_id('second-cafe') limit 1) b_table,
       (select id from public.day_sessions where restaurant_id = tests.tenant_id('second-cafe') and status = 'open') b_day,
       (select id from public.subscriptions where restaurant_id = tests.tenant_id('second-cafe')) b_sub;
grant all on _f to public;

-- ── fixtures: tenant B owns at least one row in EVERY tenant table (same shape as 10_idor_bola) ──
insert into public.ingredients (restaurant_id, name, station_id, unit, stock) select b, 'Secret Flour B', b_station, 'kg', 5 from _f;
insert into public.recipe_lines (restaurant_id, menu_item_id, ingredient_id, qty_per_serving)
  select f.b, f.b_menu, i.id, 1 from _f f join public.ingredients i on i.restaurant_id = f.b;
insert into public.stock_movements (restaurant_id, ingredient_id, station_id, qty_delta, reason, day_session_id)
  select f.b, i.id, i.station_id, 5, 'opening', f.b_day from _f f join public.ingredients i on i.restaurant_id = f.b;
insert into public.table_sessions (restaurant_id, table_id, day_session_id) select b, b_table, b_day from _f;
insert into public.qr_credentials (restaurant_id, table_id, token_hash) select b, b_table, repeat('b', 64) from _f;
insert into public.kiosk_devices (restaurant_id, name, token_hash, created_by) select b, 'B floor terminal', repeat('c', 64), b_admin from _f;
insert into public.user_notifications (restaurant_id, recipient_id, kind, payload) select b, b_waiter, 'security.concurrent_login_blocked', '{}'::jsonb from _f;
insert into public.customer_sessions (restaurant_id, table_session_id, qr_credential_id, session_token_hash, expires_at)
  select f.b, ts.id, q.id, repeat('c', 64), now() + interval '1 hour'
  from _f f join public.table_sessions ts on ts.restaurant_id = f.b join public.qr_credentials q on q.restaurant_id = f.b;
insert into public.orders (restaurant_id, day_session_id, order_no, created_by, subtotal, vat_rate_snapshot, vat_amount, total)
  select b, b_day, 'ORD-7777', b_waiter, 100, 15, 15, 115 from _f;
insert into public.order_items (restaurant_id, order_id, menu_item_id, name_snapshot, price_snapshot, qty, station_id, station_name_snapshot)
  select f.b, o.id, f.b_menu, 'Secret Special', 100, 1, f.b_station, 'Kitchen' from _f f join public.orders o on o.restaurant_id = f.b;
insert into public.vouchers (restaurant_id, voucher_no, order_id, customer_name, total, installment_count, interval_days)
  select f.b, 'VCH-0001', o.id, 'Secret Customer', 115, 2, 30 from _f f join public.orders o on o.restaurant_id = f.b;
insert into public.installments (restaurant_id, voucher_id, no, due_date, amount)
  select f.b, v.id, 1, current_date + 30, 57.5 from _f f join public.vouchers v on v.restaurant_id = f.b;
insert into public.payments (restaurant_id, day_session_id, order_id, kind, amount, payment_method_id, method_name_snapshot, method_affects_drawer_snapshot, receipt_no)
  select f.b, f.b_day, o.id, 'order_payment', 115, f.b_method, 'Cash', true, 'RCT-0001' from _f f join public.orders o on o.restaurant_id = f.b;
insert into public.expenses (restaurant_id, expense_category_id, payment_method_id, amount) select b, b_expcat, b_method, 10 from _f;
insert into public.idempotency_keys (restaurant_id, key, command) select b, 'idem-key-000001', 'test' from _f;
insert into public.tenant_counters (restaurant_id, counter_key, last_value) select b, 'order', 1 from _f on conflict do nothing;
insert into public.platform_invoices (restaurant_id, subscription_id, amount, period_start, period_end, status)
  select b, b_sub, 990, current_date, current_date + 30, 'pending' from _f;
insert into public.tenant_admin_invitations (restaurant_id, email, first_name, username, invited_by, invited_by_type, expires_at)
  select b, 'invitee@secondcafe.example.com', 'Invitee', 'invitee', b_admin, 'tenant_admin', now() + interval '7 days' from _f;
insert into public.platform_backup_runs (kind, status, finished_at, size_bytes) values ('supabase_daily', 'succeeded', now(), 1024);
insert into storage.objects (bucket_id, name, metadata) select 'menu-images', 'restaurants/' || b || '/menu/secret.png', '{"size": 2048}'::jsonb from _f;
insert into storage.objects (bucket_id, name, metadata) select 'tenant-branding', 'restaurants/' || b || '/branding/logo.png', '{"size": 512}'::jsonb from _f;

create function tests.empty_tenant_tables_34(p_tenant uuid) returns text language plpgsql as $$
declare t text; n bigint; o text := '';
begin
  for t in select tests.tenant_tables() loop
    execute format('select count(*) from public.%I where restaurant_id = $1', t) into n using p_tenant;
    if n = 0 then o := o || t || ' '; end if;
  end loop;
  return o;
end $$;
select is(tests.empty_tenant_tables_34((select b from _f)), '', 'fixture: tenant B owns rows in every tenant table (the zero-row proof below is not vacuous)');

-- platform-owned tables that legitimately carry a restaurant_id (billing / platform audit / invitations): not "operational"
create function tests.operational_tables() returns setof text language sql stable as $$
  select t from tests.tenant_tables() t
  where t not in ('subscriptions', 'platform_invoices', 'admin_audit_log', 'tenant_admin_invitations') $$;

-- what the CURRENT role can see of a table: 'ok:<rows>' or the error (a privilege error is a denial too)
create function tests.visible(p_table text) returns text language plpgsql as $$
begin
  return tests.run(format('select 1 from public.%I', p_table));
end $$;

-- call a function with all-NULL arguments as the CURRENT role; returns tests.run's outcome string
create function tests.null_call(p_oid oid) returns text language plpgsql as $$
declare v_sql text;
begin
  select format('select public.%I(%s)', (select proname from pg_proc where oid = p_oid),
                coalesce(string_agg('null::' || format_type(u.t, null), ', ' order by u.o), ''))
    into v_sql
  from unnest((select proargtypes::oid[] from pg_proc where oid = p_oid)) with ordinality u(t, o);
  return tests.run(v_sql);
end $$;

-- the platform RPC surface and the tenant RPC surface, from the catalog
create function tests.platform_rpcs() returns setof oid language sql stable as $$
  select p.oid from pg_proc p
  where p.pronamespace = 'public'::regnamespace and has_function_privilege('authenticated', p.oid, 'execute')
    and (p.proname like 'fn\_platform\_%' or p.proname in ('fn_suspend_tenant', 'fn_reactivate_tenant', 'fn_provision_tenant')) $$;
create function tests.tenant_rpcs() returns setof oid language sql stable as $$
  select p.oid from pg_proc p
  where p.pronamespace = 'public'::regnamespace and has_function_privilege('authenticated', p.oid, 'execute')
    and p.proname like 'fn\_%'
    and p.oid not in (select tests.platform_rpcs())
    -- neutral surface: error helper, pre-auth resolver, session bootstrap, the invitee's own functions, the dual-actor invitation RPCs
    and p.proname not in ('fn_err', 'fn_resolve_tenant_slug', 'fn_get_session_context', 'fn_get_my_invitation', 'fn_accept_tenant_admin_invitation',
                          'fn_prepare_tenant_admin_invitation', 'fn_prepare_tenant_admin_invitation_resend', 'fn_revoke_tenant_admin_invitation') $$;
-- every outcome of p_rpcs (as the current role) that does NOT match p_expected
create function tests.rpc_sweep(p_rpcs text, p_expected text) returns text language plpgsql as $$
declare v_oid oid; v_out text; v_bad text := '';
begin
  for v_oid in execute format('select oid from tests.%I() oid order by 1', p_rpcs) loop
    v_out := tests.null_call(v_oid);
    if v_out !~ p_expected then
      v_bad := v_bad || (select proname from pg_proc where oid = v_oid) || '=' || v_out || '; ';
    end if;
  end loop;
  return nullif(v_bad, '');
end $$;
grant execute on all functions in schema tests to public;

select cmp_ok((select count(*)::int from tests.platform_rpcs()), '>=', 20, 'the platform RPC surface is non-trivial (sweep is not vacuous)');
select cmp_ok((select count(*)::int from tests.tenant_rpcs()), '>=', 40, 'the tenant RPC surface is non-trivial (sweep is not vacuous)');

-- ═════════ the Super Admin (aal2 + verified factor) versus tenant data ═════════
select tests.aal2((select su from _f));
select ok(public.is_platform_super_admin(), 'control: a fully authenticated super admin');
select is((select string_agg(t || '=' || tests.visible(t), ', ' order by t) from tests.operational_tables() t
           where tests.visible(t) !~ '^(ok:0|42501\|)'), null,
          'the super admin reads ZERO rows of EVERY tenant operational table (orders, order_items, payments, menu_items, ingredients, stock_movements, profiles, day_sessions, expenses, installments, vouchers, tables, ...)');
select is(tests.visible('tenant_admin_invitations'), '42501|permission denied for table tenant_admin_invitations|', 'invitations are RPC-only, also for the super admin');
select is((select count(*)::int from storage.objects where name like 'restaurants/%'), 0, 'the super admin reads no tenant Storage object (menu images, branding)');
select is(tests.rpc_sweep('tenant_rpcs', '^P0001\|permission_denied\|'), null, 'the super admin is refused (permission_denied) by EVERY tenant RPC');
select ok(not public.has_permission('orders.view') and public.current_restaurant_id() is null and not public.is_tenant_admin(), 'the super admin holds no tenant identity or permission');
-- the platform tenant detail: metadata + aggregates only
create temp table _detail on commit drop as select public.fn_platform_get_tenant((select b from _f)) d;
select is((select string_agg(k, ',' order by k) from _detail, jsonb_object_keys(d) k),
          'address,created_at,custom_domain,id,invitations,limits,name,onboarded_at,over_quota,phone,recent_invoices,slug,status,subscription,suspended_at,suspension_reason,timezone,tin,updated_at,usage',
          'fn_platform_get_tenant returns exactly the metadata / subscription / usage / invitation / invoice keys');
select ok(not ((select d::text from _detail) ~* '(ORD-7777|Secret|RCT-0001|VCH-0001|waiter|opening_float|vat_rate)'),
          'and no operational content: no order / receipt / voucher number, item, customer, ingredient or staff name, no money settings');
select ok((select (d -> 'usage' ->> 'orders_last_30_days')::int >= 1 and (d -> 'usage' ->> 'storage_bytes')::bigint >= 2560 from _detail),
          'usage counters are aggregates computed from the hidden rows (orders, storage bytes in the tenant prefix)');
select tests.clear_auth();

-- ═════════ aal / account state on the platform side ═════════
select tests.authenticate_as((select su from _f));    -- the factor exists (added above), the token is aal1
select is(tests.rpc_sweep('platform_rpcs', '^P0001\|mfa_required\|'), null, 'aal1 (verified factor, no TOTP step this session): EVERY platform RPC answers mfa_required');
select tests.clear_auth();
delete from auth.mfa_factors where user_id = (select su from _f);
select tests.aal2_token((select su from _f));
select is(tests.rpc_sweep('platform_rpcs', '^P0001\|mfa_required\|'), null, 'an aal2 claim with no verified factor behind it: EVERY platform RPC answers mfa_required');
select tests.clear_auth();
do $$ begin perform tests.create_auth_user('00000000-0000-4000-8000-0000000000c9', 'retired.super@cafeos.example.com'); end $$;
insert into public.platform_admins (id, full_name, role, is_active) values ('00000000-0000-4000-8000-0000000000c9', 'Retired Super', 'platform_super_admin', false);
select tests.aal2('00000000-0000-4000-8000-0000000000c9');
select is(tests.rpc_sweep('platform_rpcs', '^P0001\|permission_denied\|'), null, 'an INACTIVE super admin on aal2: EVERY platform RPC answers permission_denied');
select tests.clear_auth();

-- ═════════ tenant users versus the platform ═════════
select tests.aal2((select a_admin from _f));
select ok(public.is_tenant_admin(), 'control: tenant_admin on aal2 with a verified factor');
select is(tests.rpc_sweep('platform_rpcs', '^P0001\|permission_denied\|'), null, 'a tenant_admin (aal2) is refused (permission_denied) by EVERY platform RPC');
select is((select count(*)::int from public.admin_audit_log) + (select count(*)::int from public.platform_admins), 0, 'tenant_admin reads no platform audit row and no platform admin');
select is(tests.visible('platform_backup_runs'), '42501|permission denied for table platform_backup_runs|', 'tenant_admin cannot read backup runs');
select is(tests.visible('tenant_admin_invitations'), '42501|permission denied for table tenant_admin_invitations|', 'tenant_admin cannot read invitations directly (own ones only via fn_list_tenant_admin_invitations)');
select is((select count(*)::int from public.subscriptions) * 10 + (select count(*)::int from public.platform_invoices where restaurant_id <> (select a from _f)), 10,
          'tenant_admin sees exactly its own subscription and no other tenant''s invoice (unchanged pre-3B exposure)');
select tests.clear_auth();
select tests.authenticate_as((select a_waiter from _f));
select is(tests.rpc_sweep('platform_rpcs', '^P0001\|permission_denied\|'), null, 'a PIN waiter is refused by EVERY platform RPC');
select is((select count(*)::int from public.subscriptions) + (select count(*)::int from public.platform_invoices) + (select count(*)::int from public.admin_audit_log), 0,
          'a waiter reads no subscription, invoice or platform audit row');
select tests.clear_auth();
select tests.as_anon();
select is(tests.rpc_sweep('platform_rpcs', '^42501\|permission denied for function'), null, 'anon cannot even execute a platform RPC');
select tests.clear_auth();

-- ═════════ one account, one portal ═════════
select is(tests.run(format($q$insert into public.profiles (id, restaurant_id, first_name, username, role_id, auth_method) values (%L, %L, 'Dual', 'dual', %L, 'password')$q$,
                           (select su from _f), (select a from _f), tests.admin_role_id('central-cafe'))),
          'P0001|auth_method_mismatch|platform admins cannot hold a tenant profile', 'a platform admin can never get a tenant profile (owner path included)');
select is(tests.run(format($q$insert into public.platform_admins (id, full_name, role) values (%L, 'Dual', 'platform_super_admin')$q$, (select a_admin from _f))),
          'P0001|auth_method_mismatch|tenant staff cannot become platform admins', 'a tenant_admin can never become a platform admin (owner path included)');
select tests.authenticate_as_service_role();
select is(tests.run(format($q$select public.fn_ops_register_platform_admin(%L, 'Dual')$q$, (select a_admin from _f))), 'P0001|owner_already_assigned|',
          'ops registration refuses a tenant account');
select tests.clear_auth();
select ok(exists (select 1 from pg_trigger where tgrelid = 'public.profiles'::regclass and tgname = 'trg_00_identity_disjoint')
          and (select prosrc ~ 'fn_identity_lock' from pg_proc where proname = 'fn_guard_platform_admin'),
          'both directions take the same per-user advisory lock before checking (no concurrent dual identity)');

select * from finish();
rollback;
