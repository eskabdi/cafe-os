-- Structural invariants + seed sanity
begin;
select * from no_plan();

select is((select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity),
          0, 'RLS enabled on every public table');
select is((select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'r' and not c.relforcerowsecurity),
          0, 'RLS forced on every public table');
select is((select count(*)::int from pg_type t join pg_namespace n on n.oid = t.typnamespace
           where n.nspname = 'public' and t.typtype = 'e'),
          0, 'no enum types in public (six dynamic domains are rows)');
select is((select count(*)::int from pg_constraint c join pg_namespace n on n.oid = c.connamespace
           where n.nspname = 'public' and c.contype = 'f' and c.confdeltype = 'c'),
          0, 'no ON DELETE CASCADE foreign keys');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.prosecdef
             and not coalesce(p.proconfig @> array['search_path='], false)),
          0, 'every SECURITY DEFINER function pins search_path to empty');

select is((select count(*)::int from public.restaurants), 2, 'two seeded tenants');
select is((select count(*)::int from public.roles where system_key = 'tenant_admin'), 2, 'one tenant_admin role per tenant');
select is((select count(*)::int from public.menu_items where restaurant_id = tests.tenant_id('central-cafe')), 22, 'demo menu seeded');
select is((select count(*)::int from public.ingredients where restaurant_id = tests.tenant_id('central-cafe')), 30, 'demo ingredients seeded');
select is((select count(*)::int from public.tables where restaurant_id = tests.tenant_id('central-cafe')), 12, 'demo tables seeded');
select is((select count(*)::int from public.qr_credentials where restaurant_id = tests.tenant_id('central-cafe') and status = 'active'), 6, 'demo QR credentials seeded');
select is((select count(*)::int from public.day_sessions where status = 'open'), 2, 'each tenant has an open day 1');
select is((select count(*)::int from public.profile_secrets ps join public.profiles p on p.id = ps.profile_id where p.auth_method = 'password'),
          0, 'no PIN secrets for password-auth (admin) profiles');
select ok((select count(*) from public.permissions) >= 29, 'permission catalog present');
select ok((select affects_cash_drawer from public.payment_methods
           where restaurant_id = tests.tenant_id('central-cafe') and normalized_name = 'cash'), 'cash drawer is a data flag');

select * from finish();
rollback;
