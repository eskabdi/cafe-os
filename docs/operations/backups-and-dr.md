# Backups, disaster recovery and data retention

Scope: the production Supabase project (Postgres incl. `auth` and `storage` schemas, Storage objects, Edge Function code
and secrets) and the static site. The code itself is in git; the site is rebuilt from a tag.

## Targets

| | Target | How it is met |
|---|---|---|
| **RPO** (data loss) | **<= 5 minutes** for the database; **<= 24 h** for Storage objects (logos, menu images) | PITR (WAL archiving, typically ~2 min); daily Storage copy |
| **RTO** (back in service) | **<= 4 hours** for a full-project restore; **<= 1 hour** for a site or function rollback | PITR restore + verification; immutable site deploys |
| Logical backup age | <= 26 hours | daily `scripts/ops/logical-backup.sh` |
| Restore drill | quarterly, and before launch | procedure below |

Payments, audit logs and closed `day_sessions` are immutable, so a restore must never "fix" them by editing: any gap after a
restore is reconciled with compensating records, the same as in normal operation.

## 1. Point-in-time recovery (PITR)

- Enable the PITR add-on on production (Project Settings > Add-ons; needs Pro or above and a compute size that supports it).
  Choose a retention of **at least 7 days** (14 recommended for launch). Staging: daily backups are enough.
- PITR restores the **whole project in place** to a chosen second. Every write after that point is lost (orders, payments,
  audit rows), and Auth sessions issued after it become invalid. It does not restore Storage objects or function secrets.
- Supabase's daily physical backups remain as a second line (retention per plan). Record each in `platform_backup_runs` as
  `supabase_daily` / `supabase_pitr` checks if you want them on the platform portal's Backups screen.

## 2. Daily logical backups (off-site)

Physical backups live in the same provider. A daily logical dump gives a provider-independent copy and lets you restore a
single table into a scratch database.

```bash
export SUPABASE_DB_URL='postgresql://...'      # from the password manager; never in a file in the repo
scripts/ops/logical-backup.sh                  # dry run: prints host, schemas, output path; connects to nothing
scripts/ops/logical-backup.sh --execute        # asks you to type the host, then pg_dump -Fc of public, auth, storage
```

- Run it from a hardened ops host or a scheduled CI job in the `production` Environment (unattended: `CONFIRM_HOST=<host>`).
  `pg_dump` must be the server's major version or newer.
- Set `BACKUP_AGE_RECIPIENT` so the dump is encrypted with `age` before it leaves the host; keep the private key offline with two holders.
- Copy the result to off-site object storage in a different provider/region with object lock (WORM) and lifecycle:
  daily 35 days, monthly 12 months. The dump contains personal data and PIN hashes: treat it like the database.
- **Storage objects** are not in the dump. Copy both buckets (`tenant-branding`, `menu-images`) daily with an S3-compatible
  sync using the Storage S3 credentials (Project Settings > Storage), same retention, recorded as `storage_copy`.

### Recording runs

The Backups screen of the platform portal reads `public.platform_backup_runs` (service_role writes only; rows are immutable
once finished). After each job, insert the row the script prints, as service_role:

```sql
begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
insert into public.platform_backup_runs (kind, status, finished_at, size_bytes, location, checksum_sha256)
values ('logical_dump', 'succeeded', now(), <bytes>, '<bucket/path, no credentials or query string>', '<sha256>');
commit;
```

A failed job inserts `status = 'failed'` with an `error_code`. Alert if no `succeeded` row of each kind is younger than 26 h ([monitoring](monitoring.md)).

## 3. Restore drill (quarterly; required before launch)

Never restore into production for a drill. Use a scratch project or a local container.

1. Open a change record; note the dump file, its sha256 from `platform_backup_runs`, and the start time.
2. Fetch the dump, verify `sha256sum`, decrypt (`age -d -i <key> ...`).
3. Restore into a scratch database with the same Postgres major:
   `supabase start` in a throwaway checkout (empty, **no** `db reset`), then
   `pg_restore --no-owner --clean --if-exists -d "postgresql://postgres:postgres@127.0.0.1:54322/postgres" cafeos-<stamp>.dump`.
   Errors about Supabase-managed objects already present (extensions, `auth` internals) are expected; data errors are not.
4. Verify: row counts of `restaurants`, `orders`, `payments`, `audit_logs`, `admin_audit_log` match the source at dump time
   (record them in the backup job); the latest `payments.created_at` is within 24 h of the dump; `select count(*) from auth.users` matches;
   pick one tenant and check its last closed day's totals with the Reports query.
5. Separately, practise a **PITR restore on staging** to a timestamp 10 minutes in the past and time it end to end
   (Dashboard > Database > Backups > Point in time). This is the number to compare with the RTO.
6. Record `kind = 'restore_drill'` in `platform_backup_runs` with duration and outcome in `note`; destroy the scratch database
   and the decrypted file.

## 4. Real restore (incident)

1. Declare an incident ([monitoring](monitoring.md)); name the incident lead and a second approver.
2. Stop writes: suspend affected tenants from the platform portal or put the static site into maintenance mode.
3. Decide the target time from `audit_logs` / `admin_audit_log` (the last good event before the damage).
4. Export what will be lost after the target time (`pg_dump --data-only` of `orders`, `payments`, `audit_logs` rows created
   after it) so tenants can re-enter or reconcile them.
5. Restore via PITR (whole project) or, for a single tenant's data, restore the logical dump into a scratch database and
   copy back only that tenant's rows through a reviewed SQL script (never overwriting immutable rows; add compensating records instead).
6. Re-run the smoke tests (production-cutover.md section 10), lift the suspension, write the post-mortem.

## 5. Data retention and purge schedule

| Data | Retention | Mechanism | Schedule |
|---|---|---|---|
| Cancelled tenant (all tenant rows, its `audit_logs`, Auth users, Storage prefix) | 1 year after `cancelled_at` (owner decision; restore possible within it) | `public.fn_ops_purge_expired_cancelled_tenants(p_limit)` (service_role) + Auth Admin API + Storage API | **monthly**, 1st Sunday 02:00 Africa/Addis_Ababa (off-peak; the function takes exclusive locks per tenant) |
| `restaurants` row, `subscriptions`, `platform_invoices`, `admin_audit_log` of a purged tenant | kept (anonymised `restaurants` row; billing and platform trail) | none | n/a |
| `user_notifications` | 90 days | owner-run delete (rls-matrix.md) | **weekly** |
| Logical dumps | 35 daily, 12 monthly | object storage lifecycle | automatic |
| PITR / daily physical backups | per add-on / plan | Supabase | automatic |
| Platform logs | per plan ([monitoring](monitoring.md)) | Supabase / log drain | automatic |

**Monthly purge procedure** (two people; staging first the first time):

```sql
-- 1. preview (read-only): who is due
select id, slug, cancelled_at from public.restaurants
where status = 'cancelled' and purged_at is null and cancelled_at <= now() - interval '1 year' order by cancelled_at;
-- 2. take a logical backup (section 2) and note its sha256
-- 3. purge in small batches, as service_role
begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select public.fn_ops_purge_expired_cancelled_tenants(5);
commit;
```

The result lists, per tenant, `auth_user_ids` and `storage_prefix` (`restaurants/<id>/`). Then, with the service-role key from
a trusted terminal: delete each Auth user (`auth.admin.deleteUser(id)`) and remove every object under the prefix in **both** buckets
(`tenant-branding`, `menu-images`). Repeat until step 1 returns no rows. An `invalid_state` / `purge_blocked:<tables>` error means a
new table references the tenant and the function needs a migration; stop and fix forward. Each purged tenant writes `tenant.purged`
to `admin_audit_log`; reconcile that count with the Auth and Storage deletions in the change record.

**Weekly notification cleanup** (as the table owner, `postgres`):

```sql
delete from public.user_notifications where created_at < now() - interval '90 days';
```

Optional automation: a `pg_cron` job for the notification cleanup only. The tenant purge stays manual because its Auth and Storage half cannot run in SQL.
