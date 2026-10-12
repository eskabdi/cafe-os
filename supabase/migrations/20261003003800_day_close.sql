-- 0038  Phase 9 (Day Close), database layer (no new table: day_sessions (0005) already carries the close snapshot; RLS unchanged)
--
--  * fn_close_day_preview()   day_close.execute: the figures the close would freeze (no write), for the close sheet.
--  * fn_close_day(counted_cash, station_counts, note, idempotency_key)   day_close.execute
--      Atomic: locks the tenant's OPEN day FOR UPDATE (every order / payment command takes it FOR SHARE first, so nothing writes into the
--      day while it closes), refuses while orders of the day are still unpaid (day_close_blocked / unpaid_orders:<n>: an order of a
--      closed day can never be paid), expires the day's table / customer sessions and frees occupied tables, then snapshots:
--        gross_collected  = order + down + installment payments of the day - reversals of the day
--        cash_collected   = the same, cash-drawer methods only (method snapshot)
--        cash_expenses    = expenses of the day paid with a cash-drawer method;  expenses_total = all expenses of the day
--        expected_cash    = opening_float + cash_collected - cash_expenses;  cash_variance = counted_cash - expected_cash
--        net_profit       = gross_collected - expenses_total;  order_count = orders of the day not cancelled
--        payment_snapshot = per payment method (id + name snapshot): amount, count
--        expense_snapshot = per expense category (id + name snapshot): amount, count
--        station_snapshot = per station (id + name snapshot): expected / counted / variance and its ingredients (id, name, unit,
--                           expected = ledger stock, counted = the count given, default expected); inventory_variance = their sum
--      The count does NOT post stock corrections (a variance is a finding for the manager; corrections stay explicit ledger rows).
--      Once closed, the day and everything that belongs to it is frozen by the closed-day guards (0013 / 0019).
--  * fn_open_day(opening_float, idempotency_key)   day.open
--      Refused while a day is open; day_no = last + 1; resets the daily inventory counters (opening_stock = stock, received_today =
--      consumed_today = 0). Reopening a closed day does not exist: a new day is the only way forward (execution prompt §29).
--  * fn_list_days(limit)   reports.view or day_close.execute: history of days with their frozen figures.

create or replace function public.fn_day_figures(p_rid uuid, p_day uuid, p_station_counts jsonb)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  with pay as (
    select p.payment_method_id, p.method_name_snapshot, p.method_affects_drawer_snapshot drawer,
           case when p.kind = 'reversal' then -p.amount else p.amount end amt, p.kind
    from public.payments p where p.restaurant_id = p_rid and p.day_session_id = p_day),
  exp as (
    select e.expense_category_id, e.amount, coalesce(e.method_affects_drawer_snapshot, false) drawer,
           coalesce(e.category_name_snapshot,
                    (select c.name from public.expense_categories c where c.id = e.expense_category_id and c.restaurant_id = e.restaurant_id)) cat_name
    from public.expenses e where e.restaurant_id = p_rid and e.day_session_id = p_day),
  counts as (
    select (c ->> 'ingredient_id')::uuid ingredient_id, (c ->> 'counted')::numeric counted
    from jsonb_array_elements(case when jsonb_typeof(p_station_counts) = 'array' then p_station_counts else '[]'::jsonb end) c),
  ing as (
    select i.id, i.name, i.unit, i.station_id, i.stock expected, coalesce(k.counted, i.stock) counted
    from public.ingredients i left join counts k on k.ingredient_id = i.id
    where i.restaurant_id = p_rid and i.is_active),
  st as (
    select s.id, s.name,
           coalesce(sum(g.expected), 0) expected, coalesce(sum(g.counted), 0) counted,
           coalesce(jsonb_agg(jsonb_build_object('ingredient_id', g.id, 'name', g.name, 'unit', g.unit, 'expected', g.expected,
                                                 'counted', g.counted, 'variance', g.counted - g.expected) order by g.name)
                    filter (where g.id is not null), '[]'::jsonb) items
    from public.stations s left join ing g on g.station_id = s.id
    where s.restaurant_id = p_rid
    group by s.id, s.name, s.sort_order
    having count(g.id) > 0 or bool_or(s.is_active)),
  d as (select opening_float, day_no, opened_at from public.day_sessions where id = p_day and restaurant_id = p_rid)
  select jsonb_build_object(
    'day_id', p_day, 'day_no', d.day_no, 'opened_at', d.opened_at, 'opening_float', d.opening_float,
    'order_count', (select count(*)::int from public.orders o where o.restaurant_id = p_rid and o.day_session_id = p_day and o.status <> 'cancelled'),
    'unpaid_orders', (select count(*)::int from public.orders o where o.restaurant_id = p_rid and o.day_session_id = p_day
                        and o.status <> 'cancelled' and o.payment_status = 'unpaid' and o.total > 0),
    'gross_collected', (select coalesce(sum(amt), 0) from pay),
    'cash_collected', (select coalesce(sum(amt) filter (where drawer), 0) from pay),
    'cash_expenses', (select coalesce(sum(amount) filter (where drawer), 0) from exp),
    'expenses_total', (select coalesce(sum(amount), 0) from exp),
    'payment_snapshot', coalesce((select jsonb_agg(jsonb_build_object('payment_method_id', x.payment_method_id, 'name', x.name,
                                   'affects_cash_drawer', x.drawer, 'amount', x.amount, 'count', x.n) order by x.name)
                                  from (select payment_method_id, max(method_name_snapshot) name, bool_or(drawer) drawer, sum(amt) amount,
                                               count(*) filter (where kind <> 'reversal')::int n
                                        from pay group by payment_method_id) x), '[]'::jsonb),
    'expense_snapshot', coalesce((select jsonb_agg(jsonb_build_object('expense_category_id', x.expense_category_id, 'name', x.name,
                                   'amount', x.amount, 'count', x.n) order by x.name)
                                  from (select expense_category_id, max(cat_name) name, sum(amount) amount, count(*)::int n
                                        from exp group by expense_category_id) x), '[]'::jsonb),
    'station_snapshot', coalesce((select jsonb_agg(jsonb_build_object('station_id', st.id, 'name', st.name, 'expected', st.expected,
                                   'counted', st.counted, 'variance', st.counted - st.expected, 'items', st.items) order by st.name)
                                  from st), '[]'::jsonb),
    'inventory_variance', (select coalesce(sum(counted - expected), 0) from ing))
  from d
$$;
revoke all on function public.fn_day_figures(uuid, uuid, jsonb) from public, anon, authenticated, service_role;

create or replace function public.fn_close_day_preview()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_rid uuid := public.fn_tenant_status_guard(false);
  v_day uuid;
  v_f jsonb;
begin
  if not public.has_permission('day_close.execute') then perform public.fn_err('permission_denied'); end if;
  select d.id into v_day from public.day_sessions d where d.restaurant_id = v_rid and d.status = 'open';
  if v_day is null then perform public.fn_err('day_closed', 'no open business day'); end if;
  v_f := public.fn_day_figures(v_rid, v_day, '[]'::jsonb);
  return v_f || jsonb_build_object('expected_cash', (v_f ->> 'opening_float')::numeric + (v_f ->> 'cash_collected')::numeric
                                                    - (v_f ->> 'cash_expenses')::numeric);
end;
$$;

create or replace function public.fn_close_day(p_counted_cash numeric, p_station_counts jsonb, p_note text, p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rid uuid := public.fn_tenant_status_guard(true);
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_counts jsonb := coalesce(p_station_counts, '[]'::jsonb);
  v_hash text;
  v_replay jsonb;
  v_day public.day_sessions%rowtype;
  v_f jsonb;
  v_expected numeric;
  v_res jsonb;
begin
  if not public.has_permission('day_close.execute') then perform public.fn_err('permission_denied'); end if;
  perform public.fn_check_idempotency_key(p_idempotency_key);
  if p_counted_cash is null or p_counted_cash < 0 or p_counted_cash > 9999999999.99 or p_counted_cash <> round(p_counted_cash, 2) then
    perform public.fn_err('invalid_input', 'counted_cash');
  end if;
  if v_note is not null and (char_length(v_note) > 500 or v_note ~ '[[:cntrl:]]') then perform public.fn_err('invalid_input', 'note'); end if;
  if jsonb_typeof(v_counts) <> 'array' or jsonb_array_length(v_counts) > 2000
     or exists (select 1 from jsonb_array_elements(v_counts) c
                where jsonb_typeof(c) <> 'object'
                   or (c ->> 'ingredient_id') !~ '^[0-9a-fA-F-]{36}$'
                   or jsonb_typeof(c -> 'counted') <> 'number'
                   or (c ->> 'counted')::numeric < 0 or (c ->> 'counted')::numeric > 999999999.999
                   or (c ->> 'counted')::numeric <> round((c ->> 'counted')::numeric, 3))
     or (select count(*) <> count(distinct c ->> 'ingredient_id') from jsonb_array_elements(v_counts) c) then
    perform public.fn_err('invalid_input', 'station_counts');
  end if;

  v_hash := encode(extensions.digest(convert_to(format('%s|%s|%s|%s', (select auth.uid()), p_counted_cash, v_counts::text, coalesce(v_note, '')),
                                                'UTF8'), 'sha256'), 'hex');
  v_replay := public.fn_idempotency_begin(p_idempotency_key, 'day.close', v_hash);
  if v_replay is not null then
    if v_replay -> 'result' is null or jsonb_typeof(v_replay -> 'result') = 'null' then perform public.fn_err('invalid_state', 'idempotency_pending'); end if;
    return (v_replay -> 'result') || jsonb_build_object('replayed', true);
  end if;

  -- exclusive: order / payment / stock commands hold the open day FOR SHARE while they write
  select * into v_day from public.day_sessions d where d.restaurant_id = v_rid and d.status = 'open' for update;
  if not found then perform public.fn_err('day_closed', 'no open business day'); end if;
  -- counted ingredients must be this tenant's
  if exists (select 1 from jsonb_array_elements(v_counts) c
             where not exists (select 1 from public.ingredients i where i.id = (c ->> 'ingredient_id')::uuid and i.restaurant_id = v_rid)) then
    perform public.fn_err('invalid_input', 'station_counts');
  end if;

  v_f := public.fn_day_figures(v_rid, v_day.id, v_counts);
  if (v_f ->> 'unpaid_orders')::int > 0 then
    perform public.fn_err('day_close_blocked', 'unpaid_orders:' || (v_f ->> 'unpaid_orders'));
  end if;

  -- the day's table / customer sessions end with it; occupied tables become available for the next day
  update public.customer_sessions set status = 'expired' where restaurant_id = v_rid and status = 'active';
  update public.table_sessions set status = 'expired' where restaurant_id = v_rid and status = 'open';
  update public.tables set status = 'available' where restaurant_id = v_rid and status = 'occupied';

  v_expected := v_day.opening_float + (v_f ->> 'cash_collected')::numeric - (v_f ->> 'cash_expenses')::numeric;
  update public.day_sessions
     set status = 'closed', closed_at = now(), closed_by = (select auth.uid()),
         order_count = (v_f ->> 'order_count')::int,
         gross_collected = (v_f ->> 'gross_collected')::numeric, cash_collected = (v_f ->> 'cash_collected')::numeric,
         cash_expenses = (v_f ->> 'cash_expenses')::numeric, expenses_total = (v_f ->> 'expenses_total')::numeric,
         expected_cash = v_expected, counted_cash = p_counted_cash, cash_variance = p_counted_cash - v_expected,
         net_profit = (v_f ->> 'gross_collected')::numeric - (v_f ->> 'expenses_total')::numeric,
         inventory_variance = (v_f ->> 'inventory_variance')::numeric,
         station_snapshot = v_f -> 'station_snapshot', expense_snapshot = v_f -> 'expense_snapshot',
         payment_snapshot = v_f -> 'payment_snapshot', close_note = v_note
   where id = v_day.id and restaurant_id = v_rid;

  perform public.fn_write_audit('day.closed', jsonb_build_object('day_id', v_day.id, 'day_no', v_day.day_no, 'expected_cash', v_expected,
                                'counted_cash', p_counted_cash, 'cash_variance', p_counted_cash - v_expected,
                                'gross_collected', v_f -> 'gross_collected', 'inventory_variance', v_f -> 'inventory_variance'));
  v_res := public.fn_day_json(v_rid, v_day.id);
  perform public.fn_idempotency_complete(p_idempotency_key, 'day.close', v_res);
  return v_res || jsonb_build_object('replayed', false);
end;
$$;

create or replace function public.fn_day_json(p_rid uuid, p_day uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('id', d.id, 'day_no', d.day_no, 'status', d.status, 'opened_at', d.opened_at, 'opening_float', d.opening_float,
    'opened_by', (select pr.short_name from public.profiles pr where pr.id = d.opened_by and pr.restaurant_id = d.restaurant_id),
    'closed_at', d.closed_at,
    'closed_by', (select pr.short_name from public.profiles pr where pr.id = d.closed_by and pr.restaurant_id = d.restaurant_id),
    'order_count', d.order_count, 'gross_collected', d.gross_collected, 'cash_collected', d.cash_collected,
    'cash_expenses', d.cash_expenses, 'expenses_total', d.expenses_total, 'expected_cash', d.expected_cash,
    'counted_cash', d.counted_cash, 'cash_variance', d.cash_variance, 'net_profit', d.net_profit,
    'inventory_variance', d.inventory_variance, 'station_snapshot', d.station_snapshot, 'expense_snapshot', d.expense_snapshot,
    'payment_snapshot', d.payment_snapshot, 'close_note', d.close_note)
  from public.day_sessions d where d.id = p_day and d.restaurant_id = p_rid
$$;
revoke all on function public.fn_day_json(uuid, uuid) from public, anon, authenticated, service_role;

create or replace function public.fn_open_day(p_opening_float numeric, p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rid uuid := public.fn_tenant_status_guard(true);
  v_hash text;
  v_replay jsonb;
  v_no integer;
  v_id uuid;
  v_res jsonb;
begin
  if not public.has_permission('day.open') then perform public.fn_err('permission_denied'); end if;
  perform public.fn_check_idempotency_key(p_idempotency_key);
  if p_opening_float is null or p_opening_float < 0 or p_opening_float > 9999999999.99 or p_opening_float <> round(p_opening_float, 2) then
    perform public.fn_err('invalid_input', 'opening_float');
  end if;
  v_hash := encode(extensions.digest(convert_to(format('%s|%s', (select auth.uid()), p_opening_float), 'UTF8'), 'sha256'), 'hex');
  v_replay := public.fn_idempotency_begin(p_idempotency_key, 'day.open', v_hash);
  if v_replay is not null then
    if v_replay -> 'result' is null or jsonb_typeof(v_replay -> 'result') = 'null' then perform public.fn_err('invalid_state', 'idempotency_pending'); end if;
    return (v_replay -> 'result') || jsonb_build_object('replayed', true);
  end if;

  -- serialise openings of this tenant (the one-open-day unique index is the backstop)
  perform 1 from public.restaurants r where r.id = v_rid for update;
  if exists (select 1 from public.day_sessions d where d.restaurant_id = v_rid and d.status = 'open') then
    perform public.fn_err('invalid_state', 'day_open');
  end if;
  select coalesce(max(d.day_no), 0) + 1 into v_no from public.day_sessions d where d.restaurant_id = v_rid;
  insert into public.day_sessions (restaurant_id, day_no, opening_float, opened_by)
  values (v_rid, v_no, p_opening_float, (select auth.uid()))
  returning id into v_id;
  update public.ingredients set opening_stock = stock, received_today = 0, consumed_today = 0
   where restaurant_id = v_rid and (opening_stock <> stock or received_today <> 0 or consumed_today <> 0);

  perform public.fn_write_audit('day.opened', jsonb_build_object('day_id', v_id, 'day_no', v_no, 'opening_float', p_opening_float));
  v_res := public.fn_day_json(v_rid, v_id);
  perform public.fn_idempotency_complete(p_idempotency_key, 'day.open', v_res);
  return v_res || jsonb_build_object('replayed', false);
end;
$$;

create or replace function public.fn_list_days(p_limit integer default 60)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_rid uuid := public.fn_tenant_status_guard(false);
begin
  if not (public.has_permission('reports.view') or public.has_permission('day_close.execute')) then perform public.fn_err('permission_denied'); end if;
  if p_limit is null or p_limit not between 1 and 366 then perform public.fn_err('invalid_input', 'limit'); end if;
  return coalesce((select jsonb_agg(public.fn_day_json(v_rid, x.id) order by x.day_no desc)
                   from (select d.id, d.day_no from public.day_sessions d where d.restaurant_id = v_rid order by d.day_no desc limit p_limit) x),
                  '[]'::jsonb);
end;
$$;

revoke all on function public.fn_close_day_preview(), public.fn_close_day(numeric, jsonb, text, text), public.fn_open_day(numeric, text),
  public.fn_list_days(integer) from public, anon;
grant execute on function public.fn_close_day_preview(), public.fn_close_day(numeric, jsonb, text, text), public.fn_open_day(numeric, text),
  public.fn_list_days(integer) to authenticated;
