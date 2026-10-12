-- 0042 Staff-specific dashboard KPIs (docs/note.md task 2), plus the fn_dashboard orders_by_status scoping fix (PR #35 review).
--
--  * fn_my_dashboard(p_from date, p_to date)   dashboard.view (Private, authenticated). The caller's OWN figures only:
--      period: business days whose opened_at falls, in the tenant's time zone, on a calendar date in [from, to] (the
--      fn_report_period rule); null bound, to < from, or more than 366 calendar days -> invalid_input|period.
--      'own_orders' (orders.view AND orders.create, else null): orders created by the caller in the period -
--                 order_count / sales_total / avg_order_value / unpaid_total (not cancelled), open_count, served_count,
--                 cancelled_count, served_rate (served / every order taken, %, 1 decimal; null with no order),
--                 avg_serve_minutes (created_at -> served_at of served orders), by_hour (own orders, tenant-local hour).
--      'stations' (orders.view AND at least one role_station_access row of the caller's role, else null): per station of the
--                 caller's role_station_access ONLY (never tenant_admin's implicit all-stations), active stations:
--                 queue / in_progress / ready = item quantities pending / preparing / ready on the OPEN day (the live board:
--                 orders not cancelled or served), completed = item quantities that reached ready in the period,
--                 avg_prep_minutes (started_at -> ready_at) and avg_wait_minutes (line created_at -> started_at) in the period.
--      Money is numeric (never float). No figure of another user, another station or another tenant is ever included.
--  * fn_dashboard() redefined: orders_by_status now counts with the SAME visibility predicate as 'recent'
--      (orders.view AND (orders.view_all OR created_by = me OR routed to one of my stations)); before, any dashboard.view holder
--      (a waiter) received the whole tenant's counts. Everything else is unchanged.
--
--  Which dashboard the web client shows is a PERMISSION rule (src/lib/domain/dashboard.ts), never a role or station name:
--  a caller holding reports.view or orders.view_all keeps the main (floor) dashboard; otherwise the waiter section shows with
--  orders.create and the station section with station access (both when both); with neither, the main dashboard.

create or replace function public.fn_my_dashboard(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_rid uuid := public.fn_tenant_status_guard(false);
  v_uid uuid := (select auth.uid());
  v_tz text;
  v_days uuid[];
  v_open uuid;
  v_view boolean;
  v_station_ids uuid[];
  v_waiter jsonb;
  v_stations jsonb;
begin
  if not public.has_permission('dashboard.view') then perform public.fn_err('permission_denied'); end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 365 then
    perform public.fn_err('invalid_input', 'period');
  end if;
  v_view := public.has_permission('orders.view');
  select coalesce(r.timezone, 'Africa/Addis_Ababa') into v_tz from public.restaurants r where r.id = v_rid;
  select coalesce(array_agg(d.id), '{}') into v_days
  from public.day_sessions d
  where d.restaurant_id = v_rid
    and d.opened_at >= (p_from::timestamp at time zone v_tz)
    and d.opened_at < ((p_to + 1)::timestamp at time zone v_tz);
  select d.id into v_open from public.day_sessions d where d.restaurant_id = v_rid and d.status = 'open';

  if v_view and public.has_permission('orders.create') then
    select jsonb_build_object(
             'order_count', count(*) filter (where o.status <> 'cancelled')::int,
             'sales_total', coalesce(sum(o.total) filter (where o.status <> 'cancelled'), 0),
             'avg_order_value', coalesce(round(avg(o.total) filter (where o.status <> 'cancelled'), 2), 0),
             'unpaid_total', coalesce(sum(o.total) filter (where o.status <> 'cancelled' and o.payment_status = 'unpaid'), 0),
             'open_count', count(*) filter (where o.status in ('submitted', 'preparing', 'ready'))::int,
             'served_count', count(*) filter (where o.status = 'served')::int,
             'cancelled_count', count(*) filter (where o.status = 'cancelled')::int,
             'served_rate', case when count(*) > 0
                                 then round(100.0 * count(*) filter (where o.status = 'served') / count(*), 1) end,
             'avg_serve_minutes', round((avg(extract(epoch from o.served_at - o.created_at))
                                           filter (where o.status = 'served' and o.served_at is not null) / 60)::numeric, 1))
      into v_waiter
    from public.orders o
    where o.restaurant_id = v_rid and o.created_by = v_uid and o.day_session_id = any (v_days);
    v_waiter := v_waiter || jsonb_build_object('by_hour', (
      select coalesce(jsonb_agg(jsonb_build_object('hour', h, 'orders', coalesce(x.n, 0), 'sales', coalesce(x.sales, 0)) order by h), '[]'::jsonb)
      from generate_series(0, 23) h
      left join (select extract(hour from o.created_at at time zone v_tz)::int hr, count(*)::int n, sum(o.total) sales
                 from public.orders o
                 where o.restaurant_id = v_rid and o.created_by = v_uid and o.day_session_id = any (v_days)
                   and o.status <> 'cancelled'
                 group by 1) x on x.hr = h));
  end if;

  if v_view then
    -- the caller's role_station_access only (an active profile and role of this tenant)
    select coalesce(array_agg(rsa.station_id), '{}') into v_station_ids
    from public.profiles p
    join public.roles ro on ro.id = p.role_id and ro.restaurant_id = p.restaurant_id and ro.is_active
    join public.role_station_access rsa on rsa.role_id = ro.id and rsa.restaurant_id = ro.restaurant_id
    where p.id = v_uid and p.restaurant_id = v_rid and p.is_active;
    if cardinality(v_station_ids) > 0 then
      select coalesce(jsonb_agg(jsonb_build_object(
               'station_id', s.id, 'name', s.name, 'color', s.color,
               'queue', coalesce(l.queue, 0), 'in_progress', coalesce(l.in_progress, 0), 'ready', coalesce(l.ready, 0),
               'completed', coalesce(p.completed, 0), 'avg_prep_minutes', p.avg_prep, 'avg_wait_minutes', p.avg_wait)
             order by s.sort_order, s.normalized_name), '[]'::jsonb)
        into v_stations
      from public.stations s
      left join lateral (
        select sum(i.qty) filter (where i.item_status = 'pending')::int queue,
               sum(i.qty) filter (where i.item_status = 'preparing')::int in_progress,
               sum(i.qty) filter (where i.item_status = 'ready')::int ready
        from public.order_items i
        join public.orders o on o.id = i.order_id and o.restaurant_id = i.restaurant_id
        where i.restaurant_id = v_rid and i.station_id = s.id and o.day_session_id = v_open
          and o.status not in ('cancelled', 'served') and i.item_status in ('pending', 'preparing', 'ready')) l on true
      left join lateral (
        select sum(i.qty) filter (where i.ready_at is not null)::int completed,
               round((avg(extract(epoch from i.ready_at - i.started_at))
                        filter (where i.ready_at is not null and i.started_at is not null) / 60)::numeric, 1) avg_prep,
               round((avg(extract(epoch from i.started_at - i.created_at)) filter (where i.started_at is not null) / 60)::numeric, 1) avg_wait
        from public.order_items i
        join public.orders o on o.id = i.order_id and o.restaurant_id = i.restaurant_id
        where i.restaurant_id = v_rid and i.station_id = s.id and o.day_session_id = any (v_days)
          and i.item_status <> 'cancelled') p on true
      where s.restaurant_id = v_rid and s.is_active and s.id = any (v_station_ids);
    end if;
  end if;

  return jsonb_build_object(
    'timezone', v_tz,
    'period', jsonb_build_object('from', p_from, 'to', p_to),
    'day_count', cardinality(v_days),
    'own_orders', v_waiter,
    'stations', v_stations);
end;
$$;
revoke all on function public.fn_my_dashboard(date, date) from public, anon;
grant execute on function public.fn_my_dashboard(date, date) to authenticated;

-- ── fn_dashboard: orders_by_status scoped like 'recent' ────────────────────────────────────────────────────────────────────
create or replace function public.fn_dashboard()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_rid uuid := public.fn_tenant_status_guard(false);
  v_uid uuid := (select auth.uid());
  v_day uuid;
  v_money boolean;
  v_inv boolean;
  v_inv_all boolean;
  v_view boolean;
  v_view_all boolean;
  v_stations uuid[];
  v_res jsonb;
  v_rep jsonb;
begin
  if not public.has_permission('dashboard.view') then perform public.fn_err('permission_denied'); end if;
  -- every permission is resolved ONCE here, never per row
  v_money := public.has_permission('reports.view') and public.has_permission('payments.view');
  v_inv := public.has_permission('inventory.view');
  v_inv_all := public.has_permission('inventory.adjust') or public.has_permission('inventory.receive');
  v_view := public.has_permission('orders.view');
  v_view_all := public.has_permission('orders.view_all');
  v_stations := public.current_station_ids();
  select d.id into v_day from public.day_sessions d where d.restaurant_id = v_rid and d.status = 'open';
  v_res := jsonb_build_object(
    'timezone', (select coalesce(r.timezone, 'Africa/Addis_Ababa') from public.restaurants r where r.id = v_rid),
    'open_day', (select jsonb_build_object('id', d.id, 'day_no', d.day_no, 'opened_at', d.opened_at) from public.day_sessions d
                 where d.id = v_day and d.restaurant_id = v_rid),
    -- the SAME visibility predicate as 'recent' (fn_order_visible / orders_select with the permissions hoisted out)
    'orders_by_status', coalesce((select jsonb_object_agg(s, n) from (select o.status s, count(*)::int n from public.orders o
                                   where o.restaurant_id = v_rid and o.day_session_id = v_day
                                     and v_view and (v_view_all or o.created_by = v_uid or o.station_ids && v_stations)
                                   group by o.status) x), '{}'::jsonb),
    'recent', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'order_no', o.order_no, 'status', o.status, 'payment_status', o.payment_status,
                                                            'table_label', o.table_label_snapshot, 'created_at', o.created_at,
                                                            'total', case when v_money then o.total end) order by o.created_at desc)
                        from (select * from public.orders o where o.restaurant_id = v_rid and o.day_session_id = v_day
                                and v_view and (v_view_all or o.created_by = v_uid or o.station_ids && v_stations)
                              order by o.created_at desc limit 15) o), '[]'::jsonb),
    -- station-scoped like ingredients_select
    'low_stock_count', case when v_inv then (select count(*)::int from public.ingredients i
                                             where i.restaurant_id = v_rid and i.is_active and i.stock <= i.min_level
                                               and (v_inv_all or i.station_id = any (v_stations))) end);
  if v_money and v_day is not null then
    v_rep := public.fn_report_light(v_rid, array[v_day]);
    v_res := v_res || jsonb_build_object('money', v_rep -> 'kpis', 'by_hour', v_rep -> 'by_hour', 'by_payment_method', v_rep -> 'by_payment_method');
  end if;
  return v_res;
end;
$$;
