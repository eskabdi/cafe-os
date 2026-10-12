-- 0037  Phase 8 (Dashboard and Reports), database layer. Read-only aggregations computed in the database (one source of truth for
--  every figure; the client never adds money up), plus the export audit.
--
--  Client RPCs (Private, authenticated):
--  * fn_report(p_from_day_no, p_to_day_no)   reports.view
--      Business days from..to by day number. Both null: the open day, or the last day when none is open. ONE bound null: that single
--      day (coalesce). from/to < 1, to < from, or more than 367 days -> invalid_input|day_range.
--  * fn_report_period(p_from date, p_to date)   reports.view
--      Business days whose opened_at, in the tenant's time zone (restaurants.timezone), falls on a calendar date within [from, to]
--      inclusive. null bound, to < from, or more than 366 calendar days -> invalid_input|period. Same document as fn_report plus
--      'period' {from, to}.
--  * fn_log_report_export(p_report, p_from, p_to, p_format)   reports.view AND reports.export (AND the section permission of that
--      report type): audit 'report.exported' {report, from, to, format}; returns {ok: true, exported_at}. A read action: past_due
--      (tenant_read_only) does NOT block it; suspended / cancelled -> tenant_suspended.
--  * fn_dashboard()   dashboard.view: the open day's floor (counts by status, last 15 visible orders), money figures with
--      reports.view AND payments.view, low_stock_count with inventory.view (station-scoped like ingredients_select).
--
--  Internal (no client EXECUTE): fn_report_days, fn_report_light (kpis / by_hour / by_payment_method: the dashboard's lighter
--  builder), fn_report_build (the full document shared by fn_report and fn_report_period), fn_order_item_category_snapshot (trigger).
--
--  Per-section gating (security findings M1/M2): reports.view is the floor (orders, sales, items, categories, hours, cancellations).
--  Every other section is withheld (JSON null, section key listed in 'restricted') unless the caller also holds:
--      payments      payments.view                     kpis.gross_collected, kpis.cash_collected, kpis.net_position, by_payment_method,
--                                                      by_day[].collected, reversals
--      expenses      expenses.view or expenses.manage  kpis.expenses_total, kpis.net_position, by_expense_category, by_day[].expenses
--      installments  vouchers.view                     kpis.vouchers_outstanding, kpis.vouchers_overdue, installments
--      inventory     inventory.view                    inventory {low_stock, consumption}, station-scoped exactly like the
--                                                      ingredients_select / stock_movements_select RLS predicates
--      staff         reports.staff                     by_waiter
--
--  Money from payments (net of reversals, by the payment's business day); sales from orders (not cancelled, by the order's day).
--  Names are the LATEST snapshot (payment method, waiter, item, category) or the row's name (expense category, ingredient), always
--  keyed by UUID: no name is known to the code. Category totals use order_items.category_id_snapshot (the item's category at order
--  time, set by trigger), not the item's current category.
--
--  No plan_features gate: reports are part of every plan. fn_tenant_status_guard(false) everywhere: a past_due tenant keeps its
--  reports; suspended / cancelled -> tenant_suspended. A platform admin has no profile -> permission_denied.

-- ── permissions (catalogue rows; tenant_admin of every existing tenant gets them through trg_grant_new_permission, new tenants
--    through fn_seed_tenant_defaults which grants the whole catalogue to tenant_admin; other roles via the matrix) ─────────────
insert into public.permissions (key, module, description, sort_order) values
  ('reports.staff',  'reports', 'See staff performance in reports (orders and sales per waiter)', 103),
  ('reports.export', 'reports', 'Export, print and download reports (CSV / PDF / print); every export is audited', 104)
on conflict (key) do nothing;

-- ── order_items: category snapshot (the item's category AT ORDER TIME) ─────────────────────────────────────────────────────────
-- Same convention as order_items.station_id + station_name_snapshot: a tenant-composite FK ON DELETE RESTRICT (categories are
-- soft-deactivated, never deleted while referenced) plus a name snapshot. Filled by a BEFORE INSERT trigger from menu_items /
-- categories (never client-supplied; clients hold no write privilege on order_items anyway) and frozen on UPDATE.
alter table public.order_items
  add column category_id_snapshot uuid,
  add column category_name_snapshot text
    constraint order_items_category_name_snapshot_check check (category_name_snapshot is null or char_length(category_name_snapshot) between 1 and 120);

-- backfill: existing lines get their menu item's current category (the best record available). The closed-day guard would refuse
-- the UPDATE of lines of closed days; this one-off structural backfill bypasses it for the duration of the statement only.
alter table public.order_items disable trigger trg_01_closed_day;
update public.order_items oi
   set category_id_snapshot = m.category_id, category_name_snapshot = c.name
  from public.menu_items m
  join public.categories c on c.id = m.category_id and c.restaurant_id = m.restaurant_id
 where m.id = oi.menu_item_id and m.restaurant_id = oi.restaurant_id;
alter table public.order_items enable trigger trg_01_closed_day;

alter table public.order_items
  alter column category_id_snapshot set not null,
  alter column category_name_snapshot set not null,
  add constraint order_items_category_fk foreign key (restaurant_id, category_id_snapshot)
    references public.categories (restaurant_id, id) on delete restrict;
create index order_items_category_idx on public.order_items (restaurant_id, category_id_snapshot);

create or replace function public.fn_order_item_category_snapshot()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    -- a snapshot is history: it never changes after insert
    new.category_id_snapshot := old.category_id_snapshot;
    new.category_name_snapshot := old.category_name_snapshot;
    return new;
  end if;
  select m.category_id, c.name into new.category_id_snapshot, new.category_name_snapshot
  from public.menu_items m
  join public.categories c on c.id = m.category_id and c.restaurant_id = m.restaurant_id
  where m.id = new.menu_item_id and m.restaurant_id = new.restaurant_id;
  return new;
end;
$$;
revoke all on function public.fn_order_item_category_snapshot() from public, anon, authenticated, service_role;
create trigger trg_order_item_category_snapshot before insert or update of category_id_snapshot, category_name_snapshot on public.order_items
  for each row execute function public.fn_order_item_category_snapshot();

-- ── supporting indexes ──────────────────────────────────────────────────────────────────────────────────────────────────────
-- period -> business days. Already present and reused: stock_movements_day_idx (0016) for consumption per day, and the partial
-- index installments_due_idx (restaurant_id, due_date) WHERE NOT paid (0005) for the set-based outstanding / overdue aggregate.
create index if not exists day_sessions_opened_idx on public.day_sessions (restaurant_id, opened_at);

-- ── internal: day range -> day ids ──────────────────────────────────────────────────────────────────────────────────────────
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
             else d.day_no between coalesce(p_from, p_to) and coalesce(p_to, p_from) end
$$;
revoke all on function public.fn_report_days(uuid, integer, integer) from public, anon, authenticated, service_role;

-- ── internal: the light builder (kpis, by_hour, by_payment_method) ──────────────────────────────────────────────────────────
-- p_rid is trusted (derived from the caller's identity by the client RPC). Section gating uses the CALLER's permissions.
create or replace function public.fn_report_light(p_rid uuid, p_days uuid[])
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_tz text;
  v_pay boolean := public.has_permission('payments.view');
  v_exp boolean := public.has_permission('expenses.view') or public.has_permission('expenses.manage');
  v_vch boolean := public.has_permission('vouchers.view');
  v_orders integer; v_cancelled integer; v_items integer;
  v_sales numeric; v_sub numeric; v_vat numeric; v_avg numeric; v_unpaid numeric;
  v_gross numeric; v_cash numeric; v_expenses numeric; v_v_out numeric; v_v_overdue integer;
  v_restricted text[] := '{}';
begin
  select coalesce(r.timezone, 'Africa/Addis_Ababa') into v_tz from public.restaurants r where r.id = p_rid;

  select count(*) filter (where o.status <> 'cancelled')::int, count(*) filter (where o.status = 'cancelled')::int,
         coalesce(sum(o.total) filter (where o.status <> 'cancelled'), 0),
         coalesce(sum(o.subtotal) filter (where o.status <> 'cancelled'), 0),
         coalesce(sum(o.vat_amount) filter (where o.status <> 'cancelled'), 0),
         coalesce(round(avg(o.total) filter (where o.status <> 'cancelled'), 2), 0),
         coalesce(sum(o.total) filter (where o.status <> 'cancelled' and o.payment_status = 'unpaid'), 0)
    into v_orders, v_cancelled, v_sales, v_sub, v_vat, v_avg, v_unpaid
  from public.orders o where o.restaurant_id = p_rid and o.day_session_id = any (p_days);

  select coalesce(sum(i.qty), 0)::int into v_items
  from public.order_items i join public.orders o on o.id = i.order_id and o.restaurant_id = i.restaurant_id
  where i.restaurant_id = p_rid and o.day_session_id = any (p_days) and o.status <> 'cancelled' and i.item_status <> 'cancelled';

  if v_pay then
    select coalesce(sum(case when p.kind = 'reversal' then -p.amount else p.amount end), 0),
           coalesce(sum(case when p.kind = 'reversal' then -p.amount else p.amount end) filter (where p.method_affects_drawer_snapshot), 0)
      into v_gross, v_cash
    from public.payments p where p.restaurant_id = p_rid and p.day_session_id = any (p_days);
  else
    v_restricted := array_append(v_restricted, 'payments');
  end if;
  if v_exp then
    select coalesce(sum(e.amount), 0) into v_expenses
    from public.expenses e where e.restaurant_id = p_rid and e.day_session_id = any (p_days);
  else
    v_restricted := array_append(v_restricted, 'expenses');
  end if;
  if v_vch then
    -- tenant-wide, as of now; set-based over the unpaid installments (overdue: an unpaid installment due before the tenant's
    -- local today, the same rule as fn_voucher_json's computed status)
    select coalesce(sum(i.amount), 0), count(distinct i.voucher_id) filter (where i.due_date < (now() at time zone v_tz)::date)::int
      into v_v_out, v_v_overdue
    from public.installments i where i.restaurant_id = p_rid and not i.paid;
  else
    v_restricted := array_append(v_restricted, 'installments');
  end if;

  return jsonb_build_object(
    'timezone', v_tz,
    'kpis', jsonb_build_object(
      'order_count', v_orders, 'cancelled_count', v_cancelled, 'items_sold', v_items,
      'sales_total', v_sales, 'subtotal_total', v_sub, 'vat_total', v_vat, 'avg_order_value', v_avg, 'unpaid_total', v_unpaid,
      'gross_collected', v_gross, 'cash_collected', v_cash,
      'expenses_total', v_expenses,
      'net_position', case when v_pay and v_exp then v_gross - v_expenses end,
      'vouchers_outstanding', v_v_out, 'vouchers_overdue', v_v_overdue),
    'by_hour', (select coalesce(jsonb_agg(jsonb_build_object('hour', h, 'orders', coalesce(x.n, 0), 'sales', coalesce(x.sales, 0)) order by h), '[]'::jsonb)
                from generate_series(0, 23) h
                left join (select extract(hour from o.created_at at time zone v_tz)::int hr, count(*)::int n, sum(o.total) sales
                           from public.orders o
                           where o.restaurant_id = p_rid and o.day_session_id = any (p_days) and o.status <> 'cancelled'
                           group by 1) x on x.hr = h),
    'by_payment_method', case when v_pay then (
      select coalesce(jsonb_agg(jsonb_build_object('payment_method_id', x.id, 'name', x.name, 'amount', x.amount, 'count', x.n)
                                order by x.amount desc, x.name), '[]'::jsonb)
      from (select p.payment_method_id id,
                   (array_agg(p.method_name_snapshot order by p.created_at desc, p.id desc))[1] name,
                   sum(case when p.kind = 'reversal' then -p.amount else p.amount end) amount,
                   -- live payments only: a reversal row and the payment it reversed are not counted
                   (count(*) filter (where p.kind <> 'reversal'
                                       and not exists (select 1 from public.payments r
                                                       where r.restaurant_id = p_rid and r.reversed_payment_id = p.id)))::int n
            from public.payments p where p.restaurant_id = p_rid and p.day_session_id = any (p_days)
            group by p.payment_method_id) x) end,
    'restricted', to_jsonb(v_restricted));
end;
$$;
revoke all on function public.fn_report_light(uuid, uuid[]) from public, anon, authenticated, service_role;

-- ── internal: the full report document ──────────────────────────────────────────────────────────────────────────────────────
create or replace function public.fn_report_build(p_rid uuid, p_days uuid[])
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_res jsonb := public.fn_report_light(p_rid, p_days);
  v_tz text := v_res ->> 'timezone';
  v_pay boolean := public.has_permission('payments.view');
  v_exp boolean := public.has_permission('expenses.view') or public.has_permission('expenses.manage');
  v_vch boolean := public.has_permission('vouchers.view');
  v_inv boolean := public.has_permission('inventory.view');
  -- the station scope of ingredients_select / stock_movements_select (0012), resolved once
  v_inv_all boolean := public.has_permission('inventory.adjust') or public.has_permission('inventory.receive');
  v_stations uuid[] := public.current_station_ids();
  v_staff boolean := public.has_permission('reports.staff');
  v_restricted text[];
begin
  select coalesce(array_agg(x order by x), '{}') into v_restricted
  from (select jsonb_array_elements_text(v_res -> 'restricted') x
        union select 'inventory' where not v_inv
        union select 'staff' where not v_staff) s;

  return v_res || jsonb_build_object(
    'days', (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'day_no', d.day_no, 'status', d.status, 'opened_at', d.opened_at,
                                                          'closed_at', d.closed_at) order by d.day_no), '[]'::jsonb)
             from public.day_sessions d where d.restaurant_id = p_rid and d.id = any (p_days)),
    'by_day', (select coalesce(jsonb_agg(jsonb_build_object(
                 'day_session_id', d.id, 'day_no', d.day_no, 'date', (d.opened_at at time zone v_tz)::date,
                 'orders', (select count(*)::int from public.orders o where o.restaurant_id = p_rid and o.day_session_id = d.id and o.status <> 'cancelled'),
                 'sales', (select coalesce(sum(o.total), 0) from public.orders o where o.restaurant_id = p_rid and o.day_session_id = d.id and o.status <> 'cancelled'),
                 'collected', case when v_pay then (select coalesce(sum(case when p.kind = 'reversal' then -p.amount else p.amount end), 0)
                                                    from public.payments p where p.restaurant_id = p_rid and p.day_session_id = d.id) end,
                 'expenses', case when v_exp then (select coalesce(sum(e.amount), 0) from public.expenses e
                                                   where e.restaurant_id = p_rid and e.day_session_id = d.id) end) order by d.day_no), '[]'::jsonb)
               from public.day_sessions d where d.restaurant_id = p_rid and d.id = any (p_days)),
    'by_category', (select coalesce(jsonb_agg(jsonb_build_object('category_id', x.id, 'name', x.name, 'qty', x.qty, 'amount', x.amount)
                                              order by x.amount desc, x.name), '[]'::jsonb)
                    from (select i.category_id_snapshot id,
                                 (array_agg(i.category_name_snapshot order by i.created_at desc, i.id desc))[1] name,
                                 sum(i.qty)::int qty, sum(i.qty * i.price_snapshot) amount
                          from public.order_items i join public.orders o on o.id = i.order_id and o.restaurant_id = i.restaurant_id
                          where i.restaurant_id = p_rid and o.day_session_id = any (p_days) and o.status <> 'cancelled' and i.item_status <> 'cancelled'
                          group by i.category_id_snapshot) x),
    'by_item', (select coalesce(jsonb_agg(jsonb_build_object('menu_item_id', x.id, 'name', x.name, 'qty', x.qty, 'amount', x.amount)
                                          order by x.amount desc, x.name), '[]'::jsonb)
                from (select i.menu_item_id id,
                             (array_agg(i.name_snapshot order by i.created_at desc, i.id desc))[1] name,
                             sum(i.qty)::int qty, sum(i.qty * i.price_snapshot) amount
                      from public.order_items i join public.orders o on o.id = i.order_id and o.restaurant_id = i.restaurant_id
                      where i.restaurant_id = p_rid and o.day_session_id = any (p_days) and o.status <> 'cancelled' and i.item_status <> 'cancelled'
                      group by i.menu_item_id
                      order by amount desc, name limit 100) x),
    'by_waiter', case when v_staff then (
      select coalesce(jsonb_agg(jsonb_build_object('user_id', x.created_by, 'name', x.name, 'orders', x.n, 'sales', x.sales)
                                order by x.sales desc, x.name), '[]'::jsonb)
      from (select o.created_by, (array_agg(o.created_by_name_snapshot order by o.created_at desc, o.id desc))[1] name,
                   count(*)::int n, sum(o.total) sales
            from public.orders o where o.restaurant_id = p_rid and o.day_session_id = any (p_days) and o.status <> 'cancelled'
            group by o.created_by) x) end,
    'by_expense_category', case when v_exp then (
      select coalesce(jsonb_agg(jsonb_build_object('expense_category_id', x.id, 'name', x.name, 'amount', x.amount, 'count', x.n)
                                order by x.amount desc, x.name), '[]'::jsonb)
      from (select e.expense_category_id id,
                   (select c.name from public.expense_categories c where c.id = e.expense_category_id and c.restaurant_id = p_rid) name,
                   sum(e.amount) amount, count(*)::int n
            from public.expenses e where e.restaurant_id = p_rid and e.day_session_id = any (p_days)
            group by e.expense_category_id) x) end,
    'inventory', case when v_inv then jsonb_build_object(
      'low_stock', (select coalesce(jsonb_agg(jsonb_build_object('ingredient_id', i.id, 'name', i.name, 'unit', i.unit, 'stock', i.stock,
                                                                 'min_level', i.min_level) order by i.stock / nullif(i.min_level, 0) nulls last, i.name), '[]'::jsonb)
                    from public.ingredients i
                    where i.restaurant_id = p_rid and i.is_active and i.stock <= i.min_level
                      and (v_inv_all or i.station_id = any (v_stations))),
      'consumption', (select coalesce(jsonb_agg(jsonb_build_object('ingredient_id', i.id, 'name', i.name, 'unit', i.unit, 'qty', sm.qty)
                                                order by sm.qty desc, i.name), '[]'::jsonb)
                      from (select m.ingredient_id, -sum(m.qty_delta) qty from public.stock_movements m
                            where m.restaurant_id = p_rid and m.day_session_id = any (p_days)
                              and (m.reason = 'consumed' or (m.reason = 'reversal' and m.order_id is not null))
                              and (v_inv_all or m.station_id = any (v_stations))
                            group by m.ingredient_id) sm
                      join public.ingredients i on i.id = sm.ingredient_id and i.restaurant_id = p_rid
                      where sm.qty <> 0)) end,
    'cancellations', (select jsonb_build_object(
                        'count', count(*)::int, 'amount', coalesce(sum(o.total), 0),
                        'items', coalesce((select jsonb_agg(jsonb_build_object('order_no', c.order_no, 'total', c.total, 'reason', c.cancel_reason,
                                                                               'cancelled_at', c.cancelled_at, 'by_name', c.by_name)
                                                            order by c.cancelled_at desc, c.order_no)
                                           from (select o2.order_no, o2.total, o2.cancel_reason, o2.cancelled_at,
                                                        (select pr.short_name from public.profiles pr where pr.id = o2.cancelled_by and pr.restaurant_id = p_rid) by_name
                                                 from public.orders o2
                                                 where o2.restaurant_id = p_rid and o2.day_session_id = any (p_days) and o2.status = 'cancelled'
                                                 order by o2.cancelled_at desc, o2.order_no limit 200) c), '[]'::jsonb))
                      from public.orders o where o.restaurant_id = p_rid and o.day_session_id = any (p_days) and o.status = 'cancelled'),
    'reversals', case when v_pay then (
      select jsonb_build_object(
        'count', count(*)::int, 'amount', coalesce(sum(p.amount), 0),
        'items', coalesce((select jsonb_agg(jsonb_build_object('receipt_no', r.receipt_no, 'amount', r.amount, 'method', r.method_name_snapshot,
                                                               'created_at', r.created_at, 'by_name', r.by_name) order by r.created_at desc, r.receipt_no)
                           from (select p2.receipt_no, p2.amount, p2.method_name_snapshot, p2.created_at,
                                        (select pr.short_name from public.profiles pr where pr.id = p2.created_by and pr.restaurant_id = p_rid) by_name
                                 from public.payments p2
                                 where p2.restaurant_id = p_rid and p2.day_session_id = any (p_days) and p2.kind = 'reversal'
                                 order by p2.created_at desc, p2.receipt_no limit 200) r), '[]'::jsonb))
      from public.payments p where p.restaurant_id = p_rid and p.day_session_id = any (p_days) and p.kind = 'reversal') end,
    'installments', case when v_vch then jsonb_build_object(
      -- vouchers issued on the covered days (by their order's business day)
      'issued_count', (select count(*)::int from public.vouchers v join public.orders o on o.id = v.order_id and o.restaurant_id = v.restaurant_id
                       where v.restaurant_id = p_rid and o.day_session_id = any (p_days)),
      'issued_total', (select coalesce(sum(v.total), 0) from public.vouchers v join public.orders o on o.id = v.order_id and o.restaurant_id = v.restaurant_id
                       where v.restaurant_id = p_rid and o.day_session_id = any (p_days)),
      'down_total', (select coalesce(sum(v.down_payment), 0) from public.vouchers v join public.orders o on o.id = v.order_id and o.restaurant_id = v.restaurant_id
                     where v.restaurant_id = p_rid and o.day_session_id = any (p_days)),
      -- installments collected on the covered days (by the payment's business day)
      'collected_total', (select coalesce(sum(p.amount), 0) from public.payments p
                          where p.restaurant_id = p_rid and p.day_session_id = any (p_days) and p.kind = 'installment_payment'),
      -- tenant-wide, as of now (= kpis.vouchers_outstanding / vouchers_overdue)
      'outstanding_total', v_res -> 'kpis' -> 'vouchers_outstanding',
      'overdue_count', v_res -> 'kpis' -> 'vouchers_overdue') end,
    'restricted', to_jsonb(v_restricted));
end;
$$;
revoke all on function public.fn_report_build(uuid, uuid[]) from public, anon, authenticated, service_role;

-- ── fn_report: by business-day number ───────────────────────────────────────────────────────────────────────────────────────
create or replace function public.fn_report(p_from_day_no integer default null, p_to_day_no integer default null)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_rid uuid := public.fn_tenant_status_guard(false);
  v_from integer := coalesce(p_from_day_no, p_to_day_no);
  v_to integer := coalesce(p_to_day_no, p_from_day_no);
begin
  if not public.has_permission('reports.view') then perform public.fn_err('permission_denied'); end if;
  -- one bound null = that single day; at most 367 days
  if v_from is not null and (v_from < 1 or v_to < 1 or v_to < v_from or v_to - v_from > 366) then
    perform public.fn_err('invalid_input', 'day_range');
  end if;
  return public.fn_report_build(v_rid, public.fn_report_days(v_rid, v_from, v_to));
end;
$$;

-- ── fn_report_period: by tenant-local calendar dates ────────────────────────────────────────────────────────────────────────
create or replace function public.fn_report_period(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_rid uuid := public.fn_tenant_status_guard(false);
  v_tz text;
  v_days uuid[];
begin
  if not public.has_permission('reports.view') then perform public.fn_err('permission_denied'); end if;
  -- at most 366 calendar days (a leap year), inclusive
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 365 then
    perform public.fn_err('invalid_input', 'period');
  end if;
  select coalesce(r.timezone, 'Africa/Addis_Ababa') into v_tz from public.restaurants r where r.id = v_rid;
  select coalesce(array_agg(d.id), '{}') into v_days
  from public.day_sessions d
  where d.restaurant_id = v_rid and (d.opened_at at time zone v_tz)::date between p_from and p_to;
  return public.fn_report_build(v_rid, v_days) || jsonb_build_object('period', jsonb_build_object('from', p_from, 'to', p_to));
end;
$$;

-- ── fn_log_report_export: the export / print audit ──────────────────────────────────────────────────────────────────────────
create or replace function public.fn_log_report_export(p_report text, p_from date, p_to date, p_format text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_rid uuid := public.fn_tenant_status_guard(false);   -- a read action: past_due may still export; suspended may not
  v_now timestamptz := now();
  v_section_ok boolean;
begin
  if not (public.has_permission('reports.view') and public.has_permission('reports.export')) then
    perform public.fn_err('permission_denied');
  end if;
  if p_report is null or p_report not in ('summary', 'revenue', 'expenses', 'inventory', 'payments', 'staff', 'items', 'installments',
                                          'cancellations', 'hourly') then
    perform public.fn_err('invalid_input', 'report');
  end if;
  if p_format is null or p_format not in ('csv', 'pdf', 'print') then perform public.fn_err('invalid_input', 'format'); end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 365 then perform public.fn_err('invalid_input', 'period'); end if;
  -- a report type whose section the caller may not see cannot be exported either (the section would be withheld anyway)
  v_section_ok := case p_report
                    when 'expenses' then public.has_permission('expenses.view') or public.has_permission('expenses.manage')
                    when 'inventory' then public.has_permission('inventory.view')
                    when 'payments' then public.has_permission('payments.view')
                    when 'staff' then public.has_permission('reports.staff')
                    when 'installments' then public.has_permission('vouchers.view')
                    else true end;
  if not v_section_ok then perform public.fn_err('permission_denied'); end if;
  perform public.fn_write_audit('report.exported', jsonb_build_object('report', p_report, 'from', p_from, 'to', p_to, 'format', p_format));
  return jsonb_build_object('ok', true, 'exported_at', v_now);
end;
$$;

-- ── fn_dashboard ────────────────────────────────────────────────────────────────────────────────────────────────────────────
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
    'orders_by_status', coalesce((select jsonb_object_agg(s, n) from (select o.status s, count(*)::int n from public.orders o
                                   where o.restaurant_id = v_rid and o.day_session_id = v_day group by o.status) x), '{}'::jsonb),
    -- the order-visibility rule of fn_order_visible / orders_select, with the permissions hoisted out of the row predicate
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

revoke all on function public.fn_report(integer, integer), public.fn_report_period(date, date), public.fn_log_report_export(text, date, date, text),
  public.fn_dashboard() from public, anon;
grant execute on function public.fn_report(integer, integer), public.fn_report_period(date, date), public.fn_log_report_export(text, date, date, text),
  public.fn_dashboard() to authenticated;
