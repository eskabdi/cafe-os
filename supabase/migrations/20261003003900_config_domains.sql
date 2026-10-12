-- 0039  Phase 10 (Settings, roles and dynamic configuration), database layer
--
--  The dynamic tenant domains (stations, categories, payment methods, table areas, expense categories; roles are Phase 3B) plus the
--  restaurant tables stay relational rows keyed by UUID. Create / edit / (de)activate stay direct writes under the existing RLS
--  (config.manage, tables.manage for tables) and the existing row audit. This migration adds the DEPENDENCY GUARDS the settings
--  screens explain to the user:
--
--  * Deactivation stays the supported, always-available path even while rows depend on it (Phases 3–5 rely on it: the order
--    pipeline answers item_unavailable for an inactive item / station / category, a station board still finishes its open tickets,
--    history keeps snapshots). One exception, fn_guard_payment_method_deactivation (BEFORE UPDATE OF is_active): the tenant's LAST
--    active payment method cannot be deactivated (in_use / 'last_active_method'), or the cashier could take no money at all.
--  * fn_config_usage(domain, id): every reference (active or historical) as counts, so the UI can say WHY a delete is refused.
--  * fn_delete_config_row(domain, id): the delete path the UI uses. Refused with in_use / '<what>:<n>,...' while anything refers to
--      the row (the FKs are ON DELETE RESTRICT anyway; this turns a raw 23503 into a structured, explainable answer). Audited.
--
--  The domain argument is one of six TABLE identifiers (a closed list checked before any dynamic SQL), never tenant data, and
--  nothing here knows a row by its name. The tenant is always fn_tenant_status_guard()'s, never a caller-supplied id.

-- ── usage counts (internal) ──────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.fn_config_usage_counts(p_rid uuid, p_domain text, p_id uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select case p_domain
    when 'stations' then jsonb_build_object(
      'menu_items', (select count(*) from public.menu_items x where x.restaurant_id = p_rid and x.station_id = p_id),
      'active_menu_items', (select count(*) from public.menu_items x where x.restaurant_id = p_rid and x.station_id = p_id and x.is_active),
      'ingredients', (select count(*) from public.ingredients x where x.restaurant_id = p_rid and x.station_id = p_id),
      'active_ingredients', (select count(*) from public.ingredients x where x.restaurant_id = p_rid and x.station_id = p_id and x.is_active),
      'order_items', (select count(*) from public.order_items x where x.restaurant_id = p_rid and x.station_id = p_id),
      'active_open_order_items', (select count(*) from public.order_items x where x.restaurant_id = p_rid and x.station_id = p_id
                                    and x.item_status in ('pending', 'preparing', 'ready')),
      'stock_movements', (select count(*) from public.stock_movements x where x.restaurant_id = p_rid and x.station_id = p_id),
      'role_access', (select count(*) from public.role_station_access x where x.restaurant_id = p_rid and x.station_id = p_id))
    when 'categories' then jsonb_build_object(
      'menu_items', (select count(*) from public.menu_items x where x.restaurant_id = p_rid and x.category_id = p_id),
      'active_menu_items', (select count(*) from public.menu_items x where x.restaurant_id = p_rid and x.category_id = p_id and x.is_active),
      'order_items', (select count(*) from public.order_items x where x.restaurant_id = p_rid and x.category_id_snapshot = p_id))
    when 'payment_methods' then jsonb_build_object(
      'payments', (select count(*) from public.payments x where x.restaurant_id = p_rid and x.payment_method_id = p_id),
      'expenses', (select count(*) from public.expenses x where x.restaurant_id = p_rid and x.payment_method_id = p_id),
      'vouchers', (select count(*) from public.vouchers x where x.restaurant_id = p_rid and x.down_payment_method_id = p_id))
    when 'table_areas' then jsonb_build_object(
      'tables', (select count(*) from public.tables x where x.restaurant_id = p_rid and x.table_area_id = p_id),
      'active_tables', (select count(*) from public.tables x where x.restaurant_id = p_rid and x.table_area_id = p_id and x.is_active))
    when 'expense_categories' then jsonb_build_object(
      'expenses', (select count(*) from public.expenses x where x.restaurant_id = p_rid and x.expense_category_id = p_id))
    when 'tables' then jsonb_build_object(
      'orders', (select count(*) from public.orders x where x.restaurant_id = p_rid and x.table_id = p_id),
      'table_sessions', (select count(*) from public.table_sessions x where x.restaurant_id = p_rid and x.table_id = p_id),
      'qr_credentials', (select count(*) from public.qr_credentials x where x.restaurant_id = p_rid and x.table_id = p_id))
  end
$$;
revoke all on function public.fn_config_usage_counts(uuid, text, uuid) from public, anon, authenticated, service_role;

-- ── deactivation guard (trigger): the last active payment method ──────────────────────────────────────────────────────────
create or replace function public.fn_guard_payment_method_deactivation()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if old.is_active and not new.is_active
     and not exists (select 1 from public.payment_methods m where m.restaurant_id = new.restaurant_id and m.is_active and m.id <> new.id) then
    perform public.fn_err('in_use', 'last_active_method');
  end if;
  return new;
end;
$$;
revoke all on function public.fn_guard_payment_method_deactivation() from public, anon, authenticated, service_role;
create trigger trg_guard_deactivation before update of is_active on public.payment_methods
  for each row execute function public.fn_guard_payment_method_deactivation();

-- ── domain → permission (internal; closed list) ──────────────────────────────────────────────────────────────────────────────
create or replace function public.fn_config_domain_check(p_domain text)
returns void
language plpgsql stable security definer set search_path = ''
as $$
begin
  if p_domain is null or p_domain not in ('stations', 'categories', 'payment_methods', 'table_areas', 'expense_categories', 'tables') then
    perform public.fn_err('invalid_input', 'domain');
  end if;
  if not public.has_permission(case when p_domain = 'tables' then 'tables.manage' else 'config.manage' end) then
    perform public.fn_err('permission_denied');
  end if;
end;
$$;
revoke all on function public.fn_config_domain_check(text) from public, anon, authenticated, service_role;

-- ── fn_config_usage (read) ───────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.fn_config_usage(p_domain text, p_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_rid uuid := public.fn_tenant_status_guard(false);
  v_found boolean;
begin
  perform public.fn_config_domain_check(p_domain);
  if p_id is null then perform public.fn_err('invalid_input', 'id'); end if;
  -- another tenant's id is indistinguishable from a missing one
  execute format('select exists (select 1 from public.%I where id = $1 and restaurant_id = $2)', p_domain) into v_found using p_id, v_rid;
  if not v_found then perform public.fn_err('not_found'); end if;
  return (select jsonb_object_agg(k.key, k.value::int) from jsonb_each_text(public.fn_config_usage_counts(v_rid, p_domain, p_id)) k);
end;
$$;

-- ── fn_delete_config_row (write) ─────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.fn_delete_config_row(p_domain text, p_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_rid uuid := public.fn_tenant_status_guard(true);
  v_name text;
  v_detail text;
begin
  perform public.fn_config_domain_check(p_domain);
  if p_id is null then perform public.fn_err('invalid_input', 'id'); end if;
  execute format('select coalesce(to_jsonb(t) ->> ''name'', to_jsonb(t) ->> ''label'') from public.%I t where t.id = $1 and t.restaurant_id = $2 for update',
                 p_domain) into v_name using p_id, v_rid;
  if v_name is null then perform public.fn_err('not_found'); end if;
  select string_agg(k.key || ':' || k.value, ',' order by k.key) into v_detail
    from jsonb_each_text(public.fn_config_usage_counts(v_rid, p_domain, p_id)) k
   where k.key not like 'active\_%' and k.value::int > 0;
  if v_detail is not null then perform public.fn_err('in_use', v_detail); end if;
  if p_domain = 'payment_methods'
     and not exists (select 1 from public.payment_methods m where m.restaurant_id = v_rid and m.is_active and m.id <> p_id) then
    perform public.fn_err('in_use', 'last_active_method');
  end if;
  begin
    execute format('delete from public.%I where id = $1 and restaurant_id = $2', p_domain) using p_id, v_rid;
  exception when foreign_key_violation then
    -- a reference appeared between the count and the delete (or a table this list does not count): still a structured answer
    perform public.fn_err('in_use', 'references');
  end;
  perform public.fn_write_audit('config.row_deleted', jsonb_build_object('domain', p_domain, 'id', p_id, 'name', v_name));
  return jsonb_build_object('deleted', true, 'domain', p_domain, 'id', p_id);
end;
$$;

revoke all on function public.fn_config_usage(text, uuid), public.fn_delete_config_row(text, uuid) from public, anon, service_role;
grant execute on function public.fn_config_usage(text, uuid), public.fn_delete_config_row(text, uuid) to authenticated;
