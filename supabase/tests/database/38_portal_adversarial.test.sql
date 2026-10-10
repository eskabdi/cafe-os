-- Phase 3B adversarial gaps (migrations 0031 tenant-branding Storage, 0032 trusted devices):
--   * Storage UPDATE / move of another tenant's tenant-branding object (33 covers insert / select / delete only)
--   * device ids: a foreign id and an unknown id answer the same for PIN staff and aal1 callers (no existence oracle)
--   * a tenant admin cannot read, forge or edit trusted_devices / session_device_attestations rows directly
-- Real Supabase Storage refuses direct DML on storage.objects (42501, Storage API only); the local shim lets the policies decide.
begin;
select plan(41);

create temp table _f on commit drop as
select tests.tenant_id('central-cafe') a, tests.tenant_id('second-cafe') b,
       '00000000-0000-4000-8000-0000000000c1'::uuid su,
       tests.user_id('selam', 'central-cafe') a_admin, tests.user_id('dawit', 'central-cafe') a_admin2,
       tests.user_id('yonas', 'central-cafe') a_waiter,
       tests.user_id('owner', 'second-cafe') b_admin, tests.user_id('waiter', 'second-cafe') b_waiter;
grant all on _f to public;
create temp table _c (k text primary key, v text);
grant all on _c to public;

-- ═════════ fixtures (owner role) ═════════
select tests.add_verified_factor(a_admin) from _f where tests.n_factors(a_admin, 'verified') = 0;
select tests.add_verified_factor(b_admin) from _f where tests.n_factors(b_admin, 'verified') = 0;
select tests.add_verified_factor(su) from _f where tests.n_factors(su, 'verified') = 0;
insert into storage.objects (bucket_id, name) select 'tenant-branding', 'restaurants/' || a || '/branding/a-logo.png' from _f;
insert into storage.objects (bucket_id, name) select 'tenant-branding', 'restaurants/' || a || '/branding/a-spare.png' from _f;
insert into storage.objects (bucket_id, name) select 'tenant-branding', 'restaurants/' || b || '/branding/b-logo.png' from _f;
insert into _c select 'snap_storage', string_agg(bucket_id || ':' || name || ':' || coalesce(metadata::text, ''), ',' order by name)
  from storage.objects where bucket_id = 'tenant-branding';
-- one live device per account (tenant B admin, tenant A second admin, platform super admin)
-- (factor_id: the account's verified factor when it has one; these rows are only probed, never used to attest a session)
insert into public.trusted_devices (user_id, scope, factor_id, token_hash, label, expires_at)
select u, s, coalesce((select f.id from auth.mfa_factors f where f.user_id = u and f.status = 'verified' limit 1), gen_random_uuid()),
       h, l, now() + interval '30 days'
from _f, lateral (values (b_admin, 'tenant', repeat('b', 64), 'B admin laptop'),
                         (a_admin2, 'tenant', repeat('c', 64), 'A admin2 laptop'),
                         (su, 'platform', repeat('d', 64), 'Super laptop')) v(u, s, h, l);
insert into _c select 'dev_b', id::text from public.trusted_devices where token_hash = repeat('b', 64);
insert into _c select 'dev_a2', id::text from public.trusted_devices where token_hash = repeat('c', 64);
insert into _c select 'dev_su', id::text from public.trusted_devices where token_hash = repeat('d', 64);
select is((select count(*)::int from _c where k like 'dev_%'), 3, 'fixture: three devices');

-- ═════════ Storage: UPDATE / move across tenants (tenant-branding) ═════════
select tests.authenticate_as((select b_admin from _f));
select matches(tests.run(format($q$update storage.objects set name = 'restaurants/%s/branding/stolen.png' where bucket_id = 'tenant-branding' and name = 'restaurants/%s/branding/a-logo.png'$q$,
                                (select b from _f), (select a from _f))),
               '^(ok:0|42501\|.*)$', 'B admin cannot move A''s branding object into its own prefix (0 rows or refused)');
select matches(tests.run(format($q$update storage.objects set name = 'restaurants/%s/branding/renamed.png' where bucket_id = 'tenant-branding' and name = 'restaurants/%s/branding/a-spare.png'$q$,
                                (select a from _f), (select a from _f))),
               '^(ok:0|42501\|.*)$', 'B admin cannot rename A''s branding object inside A''s prefix');
select matches(tests.run(format($q$update storage.objects set metadata = '{"size": 1}' where bucket_id = 'tenant-branding' and name like 'restaurants/%s/%%'$q$, (select a from _f))),
               '^(ok:0|42501\|.*)$', 'B admin cannot edit A''s branding object metadata');
select matches(tests.run(format($q$update storage.objects set bucket_id = 'menu-images' where bucket_id = 'tenant-branding' and name like 'restaurants/%s/%%'$q$, (select a from _f))),
               '^(ok:0|42501\|.*)$', 'B admin cannot move A''s branding object to another bucket');
select matches(tests.run(format($q$update storage.objects set name = 'restaurants/%s/branding/planted.png' where bucket_id = 'tenant-branding' and name = 'restaurants/%s/branding/b-logo.png'$q$,
                                (select a from _f), (select b from _f))),
               '^42501\|', 'B admin cannot move its own branding object under A''s prefix (WITH CHECK)');
select matches(tests.run(format($q$update storage.objects set bucket_id = 'tenant-branding', name = 'restaurants/%s/branding/x.png' where bucket_id = 'tenant-branding' and name = 'restaurants/%s/branding/b-logo.png'$q$,
                                (select a from _f), (select b from _f))),
               '^42501\|', 'nor by a combined bucket + name rewrite');
select tests.clear_auth();

select tests.authenticate_as((select a_admin from _f));
select matches(tests.run(format($q$update storage.objects set name = 'restaurants/%s/branding/mine.png' where bucket_id = 'tenant-branding' and name = 'restaurants/%s/branding/a-spare.png'$q$,
                                (select b from _f), (select a from _f))),
               '^42501\|', 'A admin cannot push its own branding object into B''s prefix (WITH CHECK)');
select matches(tests.run(format($q$update storage.objects set name = 'restaurants/%s/branding/a-spare.svg' where bucket_id = 'tenant-branding' and name = 'restaurants/%s/branding/a-spare.png'$q$,
                                (select a from _f), (select a from _f))),
               '^42501\|', 'nor rename it to a script-capable SVG');
select matches(tests.run(format($q$update storage.objects set name = 'restaurants/%s/branding/../../%s/branding/x.png' where bucket_id = 'tenant-branding' and name = 'restaurants/%s/branding/a-spare.png'$q$,
                                (select a from _f), (select b from _f), (select a from _f))),
               '^42501\|', 'nor a path-traversal name');
select tests.clear_auth();

select tests.authenticate_as((select a_waiter from _f));
select matches(tests.run(format($q$update storage.objects set name = 'restaurants/%s/branding/w.png' where bucket_id = 'tenant-branding' and name = 'restaurants/%s/branding/a-spare.png'$q$,
                                (select a from _f), (select a from _f))),
               '^(ok:0|42501\|.*)$', 'staff without settings.manage cannot rename the own tenant''s branding objects');
select tests.clear_auth();

select tests.aal2((select su from _f));
select matches(tests.run($q$update storage.objects set name = name || '.png' where bucket_id = 'tenant-branding'$q$),
               '^(ok:0|42501\|.*)$', 'the super admin cannot rename any tenant branding object');
select matches(tests.run($q$delete from storage.objects where bucket_id = 'tenant-branding'$q$),
               '^(ok:0|42501\|.*)$', 'nor delete one');
select tests.clear_auth();

select tests.as_anon();
select matches(tests.run($q$update storage.objects set name = name || '.png' where bucket_id = 'tenant-branding'$q$),
               '^(ok:0|42501\|.*)$', 'anon cannot rename branding objects');
select tests.clear_auth();

select is((select string_agg(bucket_id || ':' || name || ':' || coalesce(metadata::text, ''), ',' order by name) from storage.objects where bucket_id = 'tenant-branding'),
          (select v from _c where k = 'snap_storage'), 'no branding object changed (names, buckets, metadata)');

-- ═════════ device ids: foreign == unknown (PIN staff) ═════════
select tests.authenticate_as((select a_waiter from _f));
select is(tests.oracle('select public.fn_revoke_trusted_device({id})', (select v::uuid from _c where k = 'dev_b')), 'P0001|not_found|',
          'staff: another tenant''s device id answers like an unknown id (revoke)');
select is(tests.oracle('select public.fn_revoke_trusted_device({id})', (select v::uuid from _c where k = 'dev_su')), 'P0001|not_found|',
          'staff: a platform admin''s device id answers like an unknown id (revoke)');
select matches(tests.oracle('select public.fn_list_user_trusted_devices({id})', (select b_admin from _f)), '^P0001\|(not_found|permission_denied)\|$',
               'staff: another tenant''s user id answers like an unknown id (list)');
select matches(tests.oracle('select public.fn_list_user_trusted_devices({id})', (select a_admin2 from _f)), '^P0001\|(not_found|permission_denied)\|$',
               'staff: an own-tenant admin''s user id answers like an unknown id (list)');
select matches(tests.oracle('select public.fn_revoke_all_trusted_devices({id})', (select b_admin from _f)), '^P0001\|(not_found|permission_denied)\|$',
               'staff: another tenant''s user id answers like an unknown id (revoke all)');
select matches(tests.oracle('select public.fn_revoke_all_trusted_devices({id})', (select su from _f)), '^P0001\|(not_found|permission_denied)\|$',
               'staff: a platform admin''s user id answers like an unknown id (revoke all)');
select tests.clear_auth();

-- ═════════ device ids: foreign == unknown (aal1 tenant admin, no trusted session) ═════════
select tests.authenticate_as((select a_admin from _f));
select doesnt_match(tests.oracle('select public.fn_revoke_trusted_device({id})', (select v::uuid from _c where k = 'dev_b')), '^LEAK',
              'aal1 tenant admin: another tenant''s device id answers like an unknown id (revoke)');
select doesnt_match(tests.oracle('select public.fn_revoke_trusted_device({id})', (select v::uuid from _c where k = 'dev_su')), '^LEAK',
              'aal1 tenant admin: a platform admin''s device id answers like an unknown id (revoke)');
select doesnt_match(tests.oracle('select public.fn_list_user_trusted_devices({id})', (select b_admin from _f)), '^LEAK',
              'aal1 tenant admin: another tenant''s user id answers like an unknown id (list)');
select doesnt_match(tests.oracle('select public.fn_revoke_all_trusted_devices({id})', (select b_admin from _f)), '^LEAK',
              'aal1 tenant admin: another tenant''s user id answers like an unknown id (revoke all)');
select tests.clear_auth();

-- ═════════ device ids: foreign == unknown (aal1 platform super admin, no trusted session) ═════════
select tests.authenticate_as((select su from _f));
select doesnt_match(tests.oracle('select public.fn_revoke_trusted_device({id})', (select v::uuid from _c where k = 'dev_b')), '^LEAK',
              'aal1 super admin: a tenant device id answers like an unknown id (revoke)');
select doesnt_match(tests.oracle('select public.fn_list_user_trusted_devices({id})', (select b_admin from _f)), '^LEAK',
              'aal1 super admin: a tenant user id answers like an unknown id (list)');
select doesnt_match(tests.oracle('select public.fn_revoke_all_trusted_devices({id})', (select b_admin from _f)), '^LEAK',
              'aal1 super admin: a tenant user id answers like an unknown id (revoke all)');
select tests.clear_auth();

-- ═════════ device ids: aal2 cross-tenant / cross-portal ═════════
select tests.aal2((select a_admin from _f));
select is(tests.oracle('select public.fn_revoke_trusted_device({id})', (select v::uuid from _c where k = 'dev_b')), 'P0001|not_found|',
          'aal2 tenant admin: another tenant''s device is not_found, exactly like an unknown id');
select is(tests.oracle('select public.fn_revoke_trusted_device({id})', (select v::uuid from _c where k = 'dev_su')), 'P0001|not_found|',
          'aal2 tenant admin: a platform admin''s device is not_found (cross-portal)');
select is(tests.oracle('select public.fn_revoke_all_trusted_devices({id})', (select b_admin from _f)), 'P0001|not_found|',
          'aal2 tenant admin: revoke-all on another tenant''s user is not_found');
select is(tests.oracle('select public.fn_list_user_trusted_devices({id})', (select su from _f)), 'P0001|not_found|',
          'aal2 tenant admin: listing a platform admin''s devices is not_found (cross-portal)');
select tests.clear_auth();
select tests.aal2((select su from _f));
select is(tests.oracle('select public.fn_list_user_trusted_devices({id})', (select b_admin from _f)), 'P0001|not_found|',
          'aal2 super admin: listing a tenant user''s devices is not_found (cross-portal)');
select tests.clear_auth();

-- ═════════ direct table access: no read, no forge, no edit ═════════
select tests.aal2((select a_admin from _f));
select is(tests.run(format($q$select count(*) from public.trusted_devices where user_id = %L$q$, (select a_admin2 from _f))),
          '42501|permission denied for table trusted_devices|', 'tenant admin cannot read another user''s trusted_devices rows directly');
select is(tests.run('select count(*) from public.session_device_attestations'),
          '42501|permission denied for table session_device_attestations|', 'nor session attestations');
select is(tests.run(format($q$insert into public.trusted_devices (user_id, scope, factor_id, token_hash, expires_at) values (%L, 'tenant', gen_random_uuid(), repeat('e', 64), now() + interval '1 day')$q$, (select a_admin from _f))),
          '42501|permission denied for table trusted_devices|', 'nor forge a trusted device for itself');
select is(tests.run(format($q$insert into public.session_device_attestations (session_id, user_id, device_id, expires_at) values (gen_random_uuid(), %L, %L, now() + interval '1 day')$q$,
                           (select a_admin from _f), (select v from _c where k = 'dev_a2'))),
          '42501|permission denied for table session_device_attestations|', 'nor attest a session with another user''s device');
select is(tests.run($q$update public.trusted_devices set revoked_at = null, revoke_reason = null$q$),
          '42501|permission denied for table trusted_devices|', 'nor un-revoke / edit devices');
select tests.clear_auth();

-- defence in depth: even if a table privilege were granted by mistake, RLS shows only the caller's own rows
grant select on public.trusted_devices, public.session_device_attestations to authenticated;
select tests.aal2((select a_admin from _f));
select is((select count(*)::int from public.trusted_devices where user_id <> (select a_admin from _f)), 0,
          'with a stray SELECT grant, RLS still hides every other user''s device (own tenant, other tenant, platform)');
select is((select count(*)::int from public.session_device_attestations), 0, 'and every attestation (no policy at all)');
select tests.clear_auth();

select is((select count(*)::int from public.trusted_devices where id in (select v::uuid from _c where k like 'dev_%') and revoked_at is null), 3,
          'every probed device is still live (no denied call changed anything)');

select * from finish();
rollback;
