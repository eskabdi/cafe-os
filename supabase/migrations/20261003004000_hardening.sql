-- Phase 11 hardening (docs/security/hardening-report.md). Index hygiene found by the catalog audit; no behaviour change.
--
-- H-PERF-1 (medium): day_sessions carried two btree indexes on the same key: day_sessions_tenant_opened_idx
--   (restaurant_id, opened_at desc, 0005) and day_sessions_opened_idx (restaurant_id, opened_at, 0037). A btree is scanned in
--   either direction, so the second one only doubled the write cost of every day open/close. Keep the one the report docs and
--   fn_report_period's range filter name (day_sessions_opened_idx); fn_list_days' "order by opened_at desc" uses it backwards.
drop index if exists public.day_sessions_tenant_opened_idx;

-- H-PERF-2 (low): profile_secrets was the only tenant table without an index leading with restaurant_id. Its PK is
--   profile_id, so the restaurant-scoped delete of the tenant purge (fn_ops_purge_expired_cancelled_tenants) and the
--   (restaurant_id, profile_id) composite FK check scanned the whole table.
create index if not exists profile_secrets_restaurant_idx on public.profile_secrets (restaurant_id, profile_id);
