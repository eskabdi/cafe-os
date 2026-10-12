# Monitoring, alerting and incident response

Sources: Supabase dashboard (Reports, Logs Explorer: `edge_logs` for API/PostgREST, `postgres_logs`, `auth_logs`,
`function_edge_logs`/`function_logs`, `realtime_logs`, `storage_logs`), the Prometheus-compatible metrics endpoint
(`https://<ref>.supabase.co/customer/v1/privileged/metrics`, basic auth with the service-role key: scrape only from the
monitoring backend, never a browser), and the application's own trails `public.audit_logs` (per tenant) and
`public.admin_audit_log` (platform). Alerts go to one on-call channel plus a pager for "page" severity.

All signals carry fixed error codes only (RPCs raise `P0001` with a code such as `permission_denied`; Edge Functions log
fixed codes). Never add personal data, PINs or tokens to logs or alert payloads.

## What to monitor and thresholds

| Signal | Source / query | Warn | Page |
|---|---|---|---|
| **PIN failures** | `audit_logs` `event = 'auth.pin_failed'` per 5 min, platform-wide and per tenant | > 50 / 5 min platform, > 20 / 5 min one tenant | > 200 / 5 min platform (credential stuffing) |
| **Lockouts** | `audit_logs` `event = 'auth.account_locked'` | > 5 / 15 min one tenant | > 30 / 15 min platform |
| Concurrent-login blocks | `event = 'auth.concurrent_login_blocked'` | > 10 / h one tenant | n/a |
| Password sign-in failures (admins) | `auth_logs` 400/401/429 on `/token?grant_type=password` | > 20 / 5 min | > 100 / 5 min or any 429 burst |
| MFA | `auth_logs` failed `/factors/*/verify`; `admin_audit_log` `auth.mfa_reset_by_platform` | > 10 failed verifications / 15 min one user | any MFA reset outside a ticket |
| Auth rate limits | `auth_logs` 429; `token_verifications` near its limit (deploy-checklist 16) | any 429 on PIN login path | sustained 429 > 2 min (staff cannot sign in) |
| **RPC error rate** | `edge_logs` `/rest/v1/rpc/*` status >= 400 / all RPC calls, 5 min | 4xx > 5 %, 5xx > 0.5 % | 5xx > 2 % for 5 min |
| `permission_denied`, `permission_escalation`, `mfa_required` | `postgres_logs` / `edge_logs` error message codes | > 20 / 5 min one tenant | any `permission_escalation` spike > 5 / 5 min (probing) |
| **`rate_limited` / `invite_rate_limited`** | RPC error codes (reports export, invitations) | > 10 / h one tenant | n/a |
| Edge Functions | `function_edge_logs` status >= 500, 503 (= env missing/unsafe, function disabled), boot errors | any 503 | 5xx > 1 % for 5 min on `pin-login` |
| Tenant resolver abuse | `edge_logs` calls to `fn_resolve_tenant_slug` per IP | > 60 / min one IP | WAF not blocking |
| **Realtime** | `realtime_logs` errors, concurrent connections and channel joins vs plan quota | connections > 70 % of quota; error rate > 1 % | connections > 90 %; KDS reports "offline" from > 1 tenant |
| **Storage** | `storage_logs` 4xx/5xx, bucket size, upload rejects | 5xx > 1 %; total size > 70 % of plan | 5xx > 5 % |
| **DB CPU** | metrics `node_cpu_*` / dashboard | > 70 % for 15 min | > 90 % for 5 min |
| **DB connections** | `pg_stat_activity` count vs `max_connections`; pooler saturation | > 70 % | > 90 % or pooler queueing |
| Memory / disk / IO budget | metrics; disk usage | disk > 75 %, IO budget depleting | disk > 90 % |
| **Slow queries** | `pg_stat_statements` (Dashboard > Query performance): mean > 200 ms or total time top 10 | new entry in top 10 after a deploy | any RPC p95 > 2 s for 10 min |
| Lock waits / long transactions | `pg_stat_activity` `wait_event_type = 'Lock'`, `xact_start` older than 5 min | > 1 min | > 5 min (purge job excepted) |
| Replication / PITR | dashboard backup status; `platform_backup_runs` | latest `succeeded` logical dump > 26 h old | PITR disabled or WAL archiving failing |
| TLS / DNS | external uptime monitor on `platform.<app>`, a tenant host and `<ref>.supabase.co` | cert expiry < 14 days | site down 2 checks in a row |
| Headers | weekly `curl -sI` check of CSP/HSTS | missing header | CSP wildcard back |

Example queries (run as the owner in the SQL editor or by the monitoring job with a read-only role):

```sql
-- PIN failures and lockouts per tenant, last 15 minutes
select restaurant_id, event, count(*) from public.audit_logs
where created_at > now() - interval '15 minutes' and event in ('auth.pin_failed', 'auth.account_locked', 'auth.concurrent_login_blocked')
group by 1, 2 order by 3 desc;

-- slowest statements
select calls, round(mean_exec_time::numeric, 1) as mean_ms, left(query, 120) from pg_stat_statements
order by mean_exec_time desc limit 10;

-- connections by state
select state, count(*) from pg_stat_activity group by 1;
```

## Log retention

| Log | Retention | Action |
|---|---|---|
| Supabase platform logs (API, Postgres, Auth, Functions, Realtime, Storage) | depends on the plan (short on Pro; longer on Team/Enterprise; check the current plan page) | for >= 90 days, use a log drain (Team+) to your SIEM, or export daily; keep 1 year for security events |
| `audit_logs` (tenant) | life of the tenant + 1 year after cancellation (then purged with it) | immutable; never edited |
| `admin_audit_log` (platform) | permanent | immutable |
| `user_notifications` | 90 days | weekly cleanup (backups-and-dr.md) |
| GitHub Actions logs / artifacts | 90 days / site artifact 30 days | default |

## Incident response

Severity: **SEV1** data exposure across tenants, payment integrity, or full outage; **SEV2** one tenant down, auth broken for a
role, backups failing; **SEV3** degraded performance.

1. **Detect and declare.** Whoever is paged opens an incident record (time, alert, severity) and names an incident lead.
2. **Contain.**
   - Compromised staff account: deactivate it (Tenant Admin), force PIN reset; for a tenant admin, a Super Admin MFA reset.
   - Compromised kiosk: revoke the device (kiosk-terminals.md).
   - Abusive tenant or suspected cross-tenant probing: suspend the tenant from the platform portal (writes `admin_audit_log`).
   - Leaked secret: rotate it immediately ([secrets.md](secrets.md)); rotating the JWT secret signs everyone out.
   - Platform-wide: put the static site in maintenance; block abusive IPs at the edge/WAF.
3. **Investigate with the audit trails** (they are append-only, so they are evidence; export before any restore):
   ```sql
   -- what an actor did
   select created_at, restaurant_id, event, action, table_name, record_id from public.audit_logs
   where actor_id = '<user id>' and created_at > now() - interval '7 days' order by created_at;
   -- platform actions (suspension, MFA reset, admin changes, purges)
   select created_at, platform_admin_id, restaurant_id, action, detail from public.admin_audit_log
   where created_at > now() - interval '7 days' order by created_at desc;
   ```
   Correlate with `auth_logs` (sign-ins, IPs), `edge_logs` (RPC calls, status) and `function_edge_logs` by time window.
   Cross-tenant suspicion: check `permission_denied` bursts for the actor, then confirm no row of another `restaurant_id` was returned
   (RLS is the boundary; a confirmed leak is SEV1 and triggers notification duties).
4. **Recover.** Fix forward (migration or function redeploy through `deploy.yml`), or restore ([backups-and-dr.md](backups-and-dr.md)).
   Financial corrections are compensating records (payment reversal, stock reversal), never edits.
5. **Notify.** Affected tenants within 24 h for SEV1/SEV2; regulators/data subjects as required by Ethiopian data-protection law
   (owner/counsel decide; keep the timeline).
6. **Post-mortem** within 5 working days: timeline from the audit logs, root cause, new alert or test (pgTAP / E2E) that would have caught it.
