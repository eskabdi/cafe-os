-- 0037  Phase 8 (Dashboard and Reports), database layer. Read-only aggregations, computed in the database (one source of truth for
--  every figure; the client never adds money up).
--
--  * fn_report(p_from_day_no, p_to_day_no)   reports.view
--      Business days from..to (both null: the open day, or the last day when none is open; one bound null: open-ended; at most 367
--      days; invalid -> invalid_input|day_range). Money from payments (net of reversals, by the payment's day), sales from orders
--      (not cancelled, by the order's day). Also 'timezone' (restaurants.timezone) and 'days' [{id, day_no, status, opened_at,
--      closed_at}]:
--        kpis            order_count, items_sold, sales_total (order totals), avg_order_value, gross_collected, cash_collected,
--                        expenses_total, net_position (gross_collected - expenses_total), unpaid_total (unpaid, not cancelled orders),
--                        cancelled_count, vouchers_outstanding / vouchers_overdue (tenant-wide, now)
--        by_payment_method  [{payment_method_id, name, amount, count}]   (method name snapshot)
--        by_category        [{category_id, name, qty, amount}]           (the item's CURRENT category; name from the row)
--        by_waiter          [{user_id, name, orders, sales}]              (orders.created_by, name snapshot)
--        by_expense_category[{expense_category_id, name, amount, count}]
--        by_hour            [{hour, orders, sales}]                       (tenant local hour 0..23 of the order)
--        inventory          low_stock [{ingredient_id, name, unit, stock, min_level}], consumption [{ingredient_id, name, unit, qty}]
--  * fn_dashboard()   dashboard.view: the open day's counts by status (aggregate, whole floor) and recent activity (last 15 orders
--      the caller may see under the order-visibility rule fn_order_visible: orders.view + view_all / own / station); money figures
--      (order totals, KPIs, by_hour, by_payment_method) only with reports.view (a waiter with dashboard.view sees the floor, not the
--      till); low_stock_count only with inventory.view or reports.view (null otherwise).
--
--  reports.view is the umbrella for the aggregated figures (incl. expense and inventory aggregates), the same way 0017 lets
--  reports.view read day_sessions money columns. No plan_features gate: reports are part of every plan (only installments is
--  plan-gated, 0035/0036). Read-only: fn_tenant_status_guard(false), so a past_due tenant keeps its reports; suspended /
--  cancelled -> tenant_suspended. A platform admin has no profile -> permission_denied (the Super Admin never sees tenant data).
--
--  Category / waiter / method / expense-category NAMES come from rows or snapshots keyed by UUID: no name is known to the code.

create or replace function public.fn_report_days(p_rid uuid, p_from integer, p_to integer)
returns uuid[]
language sql stable security definer set search_path = ''
as $$
  select coalesce(array_agg(d.id), '{}')
  from public.day_sessions d
  where d.restaurant_id = p_rid
    and case when p_from is null and p_to is null
             then d.id = coalesce((select x.id from public.day_sessions x where x.restaurant_id = p_rid and x.status = 'open'),
                                  (select x.id from public.day_sessions x where x.restaurant_id = p_rid order by x.day_no desc limit 1))
             else d.day_no between coalesce(p_from, 1) and coalesce(p_to, 2147483647) end
$$;
revoke all on function public.fn_report_days(uuid, integer, integer) from public, anon, authenticated, service_role;

create or replace function public.fn_report(p_from_day_no integer default null, p_to_day_no integer default null)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_rid uuid := public.fn_tenant_status_guard(false);
  v_days uuid[];
  v_tz text;
begin
  if not public.has_permission('reports.view') then perform public.fn_err('permission_denied'); end if;
  if (p_from_day_no is not null and p_from_day_no < 1) or (p_to_day_no is not null and p_to_day_no < 1)
     or (p_from_day_no is not null and p_to_day_no is not null and (p_to_day_no < p_from_day_no or p_to_day_no - p_from_day_no > 366)) then
    perform public.fn_err('invalid_input', 'day_range');
  end if;
  v_days := public.fn_report_days(v_rid, p_from_day_no, p_to_day_no);
  select coalesce(r.timezone, 'Africa/Addis_Ababa') into v_tz from public.restaurants r where r.id = v_rid;

  return (
    with o as (select * from public.orders x where x.restaurant_id = v_rid and x.day_session_id = any (v_days)),
    oi as (select i.*, m.category_id from public.order_items i join o on o.id = i.order_id
           left join public.menu_items m on m.id = i.menu_item_id and m.restaurant_id = i.restaurant_id
           where i.restaurant_id = v_rid and o.status <> 'cancelled' and i.item_status <> 'cancelled'),
    p as (select x.payment_method_id, x.method_name_snapshot, x.method_affects_drawer_snapshot drawer, x.kind,
                 case when x.kind = 'reversal' then -x.amount else x.amount end amt
          from public.payments x where x.restaurant_id = v_rid and x.day_session_id = any (v_days)),
    e as (select x.* from public.expenses x where x.restaurant_id = v_rid and x.day_session_id = any (v_days)),
    sm as (select x.ingredient_id, -sum(x.qty_delta) qty from public.stock_movements x
           where x.restaurant_id = v_rid and x.day_session_id = any (v_days)
             and (x.reason = 'consumed' or (x.reason = 'reversal' and x.order_id is not null))
           group by x.ingredient_id),
    vch as (select public.fn_voucher_json(v.id, v_rid) j from public.vouchers v where v.restaurant_id = v_rid)
    select jsonb_build_object(
      'timezone', v_tz,
      'days', (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'day_no', d.day_no, 'status', d.status, 'opened_at', d.opened_at,
                                                            'closed_at', d.closed_at) order by d.day_no), '[]'::jsonb)
               from public.day_sessions d where d.id = any (v_days) and d.restaurant_id = v_rid),
      'kpis', jsonb_build_object(
        'order_count', (select count(*)::int from o where o.status <> 'cancelled'),
        'cancelled_count', (select count(*)::int from o where o.status = 'cancelled'),
        'items_sold', (select coalesce(sum(qty), 0)::int from oi),
        'sales_total', (select coalesce(sum(total), 0) from o where o.status <> 'cancelled'),
        'avg_order_value', (select coalesce(round(avg(total), 2), 0) from o where o.status <> 'cancelled'),
        'gross_collected', (select coalesce(sum(amt), 0) from p),
        'cash_collected', (select coalesce(sum(amt) filter (where drawer), 0) from p),
        'expenses_total', (select coalesce(sum(amount), 0) from e),
        'net_position', (select coalesce(sum(amt), 0) from p) - (select coalesce(sum(amount), 0) from e),
        'unpaid_total', (select coalesce(sum(total), 0) from o where o.status <> 'cancelled' and o.payment_status = 'unpaid'),
        'vouchers_outstanding', (select coalesce(sum((j ->> 'outstanding')::numeric), 0) from vch),
        'vouchers_overdue', (select count(*)::int from vch where j ->> 'status' = 'overdue')),
      'by_payment_method', (select coalesce(jsonb_agg(jsonb_build_object('payment_method_id', x.id, 'name', x.name, 'amount', x.amount,
                                                                         'count', x.n) order by x.amount desc, x.name), '[]'::jsonb)
                            from (select payment_method_id id, max(method_name_snapshot) name, sum(amt) amount,
                                         count(*) filter (where kind <> 'reversal')::int n from p group by payment_method_id) x),
      'by_category', (select coalesce(jsonb_agg(jsonb_build_object('category_id', x.category_id, 'name', x.name, 'qty', x.qty,
                                                                   'amount', x.amount) order by x.amount desc, x.name), '[]'::jsonb)
                      from (select oi.category_id, (select c.name from public.categories c where c.id = oi.category_id and c.restaurant_id = v_rid) name,
                                   sum(oi.qty)::int qty, sum(oi.qty * oi.price_snapshot) amount
                            from oi group by oi.category_id) x),
      'by_waiter', (select coalesce(jsonb_agg(jsonb_build_object('user_id', x.created_by, 'name', x.name, 'orders', x.n, 'sales', x.sales)
                                              order by x.sales desc, x.name), '[]'::jsonb)
                    from (select o.created_by, max(o.created_by_name_snapshot) name, count(*)::int n, sum(o.total) sales
                          from o where o.status <> 'cancelled' group by o.created_by) x),
      'by_expense_category', (select coalesce(jsonb_agg(jsonb_build_object('expense_category_id', x.id, 'name', x.name, 'amount', x.amount,
                                                                           'count', x.n) order by x.amount desc, x.name), '[]'::jsonb)
                              from (select e.expense_category_id id,
                                           (select c.name from public.expense_categories c where c.id = e.expense_category_id and c.restaurant_id = v_rid) name,
                                           sum(e.amount) amount, count(*)::int n
                                    from e group by e.expense_category_id) x),
      'by_hour', (select coalesce(jsonb_agg(jsonb_build_object('hour', h, 'orders', coalesce(x.n, 0), 'sales', coalesce(x.sales, 0)) order by h), '[]'::jsonb)
                  from generate_series(0, 23) h
                  left join (select extract(hour from o.created_at at time zone v_tz)::int hr, count(*)::int n, sum(o.total) sales
                             from o where o.status <> 'cancelled' group by 1) x on x.hr = h),
      'inventory', jsonb_build_object(
        'low_stock', (select coalesce(jsonb_agg(jsonb_build_object('ingredient_id', i.id, 'name', i.name, 'unit', i.unit, 'stock', i.stock,
                                                                   'min_level', i.min_level) order by i.stock / nullif(i.min_level, 0) nulls last, i.name), '[]'::jsonb)
                      from public.ingredients i where i.restaurant_id = v_rid and i.is_active and i.stock <= i.min_level),
        'consumption', (select coalesce(jsonb_agg(jsonb_build_object('ingredient_id', i.id, 'name', i.name, 'unit', i.unit, 'qty', sm.qty)
                                                  order by sm.qty desc, i.name), '[]'::jsonb)
                        from sm join public.ingredients i on i.id = sm.ingredient_id and i.restaurant_id = v_rid where sm.qty <> 0)))
  );
end;
$$;

create or replace function public.fn_dashboard()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_rid uuid := public.fn_tenant_status_guard(false);
  v_day uuid;
  v_money boolean;
  v_res jsonb;
  v_rep jsonb;
begin
  if not public.has_permission('dashboard.view') then perform public.fn_err('permission_denied'); end if;
  v_money := public.has_permission('reports.view');
  select d.id into v_day from public.day_sessions d where d.restaurant_id = v_rid and d.status = 'open';
  v_res := jsonb_build_object(
    'timezone', (select coalesce(r.timezone, 'Africa/Addis_Ababa') from public.restaurants r where r.id = v_rid),
    'open_day', (select jsonb_build_object('id', d.id, 'day_no', d.day_no, 'opened_at', d.opened_at) from public.day_sessions d where d.id = v_day),
    'orders_by_status', coalesce((select jsonb_object_agg(s, n) from (select o.status s, count(*)::int n from public.orders o
                                   where o.restaurant_id = v_rid and o.day_session_id = v_day group by o.status) x), '{}'::jsonb),
    'recent', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'order_no', o.order_no, 'status', o.status, 'payment_status', o.payment_status,
                                                            'table_label', o.table_label_snapshot, 'created_at', o.created_at,
                                                            'total', case when v_money then o.total end) order by o.created_at desc)
                        from (select * from public.orders o where o.restaurant_id = v_rid and o.day_session_id = v_day
                                and public.fn_order_visible(o.created_by, o.station_ids)
                              order by o.created_at desc limit 15) o), '[]'::jsonb),
    'low_stock_count', case when public.has_permission('inventory.view') or v_money
                            then (select count(*)::int from public.ingredients i where i.restaurant_id = v_rid and i.is_active and i.stock <= i.min_level) end);
  if v_money and v_day is not null then
    v_rep := public.fn_report();
    v_res := v_res || jsonb_build_object('money', v_rep -> 'kpis', 'by_hour', v_rep -> 'by_hour', 'by_payment_method', v_rep -> 'by_payment_method');
  end if;
  return v_res;
end;
$$;

revoke all on function public.fn_report(integer, integer), public.fn_dashboard() from public, anon;
grant execute on function public.fn_report(integer, integer), public.fn_dashboard() to authenticated;
