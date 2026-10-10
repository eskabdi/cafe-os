-- 0033  Phase 4 (Waiter POS), database layer: the canonical order pipeline and the order lifecycle commands
--
--  What this adds (orders / order_items exist since 0005; RLS since 0007 / 0012; Realtime since 0009 / 0019):
--   * fn_order_create        INTERNAL, the ONE order-creation pipeline (staff POS now, the QR / table-session entry point later calls the
--                            same function: validation, server pricing, VAT, totals, order number, idempotency, station routing, recipe
--                            consumption, table state, audit). The tenant is a parameter that only definer callers supply after they
--                            derived it from the identity (staff profile, later the QR credential); no client EXECUTE.
--   * fn_submit_order        orders.create; staff entry point (tenant + actor from auth.uid(), never from input)
--   * fn_cancel_order        orders.cancel; only while every item is pending and nothing is paid; compensating stock reversal
--   * fn_set_station_items_status   station operator: pending -> preparing ("start") / -> ready, per station, order rollup
--   * fn_serve_order         the waiter marks a READY order served
--   * order quotas are MONITOR ONLY (owner decision 2026-10-08): plans.max_orders_per_month is reported, never enforced here
--   * order_items.line_no    position of the line in the submitted cart (receipts / KDS keep the waiter's order)
--
--  WRITE PATH: clients hold only SELECT on orders / order_items (0009, asserted in 24_*); these RPCs are the only writers.
--
--  Lock order (deadlock-free, documented in rpc-conventions.md):
--    submit:  idempotency key row -> open day (FOR SHARE) -> table (FOR UPDATE) -> menu items (FOR SHARE, id order) -> tenant counter
--             -> every ingredient of every recipe of the cart (FOR UPDATE, ONE statement, ingredient-id order) -> ledger
--    cancel / station status / serve:  order row (FOR UPDATE) FIRST -> day (FOR SHARE) -> items -> ingredients (id order, reversal)
--  Two submits whose carts share ingredients therefore lock them in the same global order whatever the line order of the carts.
--
--  Money: numeric only. subtotal = sum(menu_items.price * qty) read under the FOR SHARE lock; VAT = round(subtotal * vat_rate / 100, 2)
--  (restaurants.vat_rate, snapshotted on the order); total = subtotal + VAT. Client prices / totals are never accepted (no parameter).

-- ── schema additions ────────────────────────────────────────────────────────
alter table public.order_items
  add column line_no integer
  constraint order_items_line_no_check check (line_no is null or line_no between 1 and 50);
create unique index order_items_order_line_idx on public.order_items (order_id, line_no) where line_no is not null;

-- ── internal: order JSON (optionally only one station's lines) ──────────────
create or replace function public.fn_order_json(p_order_id uuid, p_station_id uuid default null)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'id', o.id, 'order_no', o.order_no, 'source', o.source, 'order_type', o.order_type, 'status', o.status,
    'payment_status', o.payment_status, 'day_session_id', o.day_session_id, 'table_id', o.table_id,
    'table_label', o.table_label_snapshot, 'table_session_id', o.table_session_id, 'created_by', o.created_by,
    'created_by_name', o.created_by_name_snapshot, 'subtotal', o.subtotal, 'vat_rate', o.vat_rate_snapshot,
    'vat_amount', o.vat_amount, 'total', o.total, 'stock_consumed', o.stock_consumed, 'customer_note', o.customer_note,
    'created_at', o.created_at, 'ready_at', o.ready_at, 'served_at', o.served_at, 'cancelled_at', o.cancelled_at,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', oi.id, 'line_no', oi.line_no, 'menu_item_id', oi.menu_item_id, 'name', oi.name_snapshot,
               'price', oi.price_snapshot, 'qty', oi.qty, 'line_total', oi.price_snapshot * oi.qty, 'station_id', oi.station_id,
               'station_name', oi.station_name_snapshot, 'item_status', oi.item_status, 'note', oi.note)
             order by oi.line_no nulls last, oi.created_at, oi.id)
      from public.order_items oi
      where oi.order_id = o.id and oi.restaurant_id = o.restaurant_id
        and (p_station_id is null or oi.station_id = p_station_id)), '[]'::jsonb))
  from public.orders o where o.id = p_order_id
$$;

-- ── internal: the canonical order pipeline ──────────────────────────────────
-- p_rid / p_created_by / p_source / p_customer_session_id are trusted: they come from a definer caller that derived them from the
-- caller's identity. Everything else is client input and validated here.
-- p_items = [{"menu_item_id": uuid, "qty": integer 1..99, "note": string <= 200 | null}], 1..50 lines (a menu item may repeat with
-- a different note). Returns fn_order_json(order) || {"replayed": bool}.
create or replace function public.fn_order_create(
  p_rid uuid, p_source text, p_created_by uuid, p_items jsonb, p_idempotency_key text,
  p_order_type text default 'dine-in', p_table_id uuid default null, p_table_session_id uuid default null,
  p_customer_session_id uuid default null, p_customer_note text default null)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  c_max   constant numeric := 9999999999.99;   -- numeric(12,2)
  v_status text;
  v_el    jsonb;
  v_k     text;
  v_mids  uuid[] := '{}';
  v_qtys  integer[] := '{}';
  v_notes text[] := '{}';
  v_q     numeric;
  v_note  text;
  v_cnote text := nullif(btrim(coalesce(p_customer_note, '')), '');
  v_hash  text;
  v_idem  uuid;
  v_prev  public.idempotency_keys%rowtype;
  v_day   uuid;
  v_max   integer;
  v_table public.tables%rowtype;
  v_tsess uuid;
  v_n_found integer;
  v_bad   text;
  v_vat_rate numeric;
  v_auto  boolean;
  v_sub   numeric;
  v_vat   numeric;
  v_order uuid;
  v_no    text;
  v_name  text;
  v_mov   integer := 0;
  r       record;
  v_res   jsonb;
begin
  -- tenant state (the staff entry point checked it already; the QR entry point will rely on this one)
  select x.status, x.vat_rate, x.auto_consume_stock into v_status, v_vat_rate, v_auto from public.restaurants x where x.id = p_rid;
  if v_status is null then perform public.fn_err('not_found'); end if;
  if v_status in ('suspended', 'cancelled') then perform public.fn_err('tenant_suspended'); end if;
  if v_status = 'past_due' then perform public.fn_err('tenant_read_only'); end if;
  if p_source is null or p_source not in ('staff', 'qr') or (p_source = 'staff' and p_created_by is null) then
    perform public.fn_err('invalid_input', 'source');
  end if;

  -- ── input shape (before any lookup or lock) ──
  perform public.fn_check_idempotency_key(p_idempotency_key);
  if p_order_type is null or p_order_type not in ('dine-in', 'takeaway', 'delivery') then perform public.fn_err('invalid_input', 'order_type'); end if;
  if v_cnote is not null and char_length(v_cnote) > 300 then perform public.fn_err('invalid_input', 'customer_note'); end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 50 then
    perform public.fn_err('invalid_input', 'items');
  end if;
  for v_el in select e from jsonb_array_elements(p_items) e loop
    if jsonb_typeof(v_el) <> 'object' then perform public.fn_err('invalid_input', 'items'); end if;
    for v_k in select jsonb_object_keys(v_el) loop
      if v_k <> all (array['menu_item_id', 'qty', 'note']) then perform public.fn_err('invalid_input', 'items'); end if;
    end loop;
    if jsonb_typeof(v_el -> 'menu_item_id') is distinct from 'string'
       or (v_el ->> 'menu_item_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      perform public.fn_err('invalid_input', 'menu_item_id');
    end if;
    if jsonb_typeof(v_el -> 'qty') is distinct from 'number' then perform public.fn_err('invalid_input', 'qty'); end if;
    v_q := (v_el ->> 'qty')::numeric;
    if v_q <> trunc(v_q) or v_q < 1 or v_q > 99 then perform public.fn_err('invalid_input', 'qty'); end if;
    if v_el ? 'note' and jsonb_typeof(v_el -> 'note') not in ('string', 'null') then perform public.fn_err('invalid_input', 'note'); end if;
    v_note := nullif(btrim(coalesce(v_el ->> 'note', '')), '');
    if v_note is not null and char_length(v_note) > 200 then perform public.fn_err('invalid_input', 'note'); end if;
    v_mids := v_mids || (v_el ->> 'menu_item_id')::uuid;
    v_qtys := v_qtys || v_q::integer;
    v_notes := v_notes || v_note;
  end loop;

  -- ── idempotency (tenant-scoped; the fingerprint includes the actor, so another user's key is a conflict, never a replay) ──
  v_hash := encode(extensions.digest(convert_to(jsonb_build_array(
              p_source, p_created_by, p_customer_session_id, p_order_type, p_table_id, p_table_session_id, v_cnote,
              (select jsonb_agg(jsonb_build_array(t.m, t.q, t.n) order by t.o)
               from unnest(v_mids, v_qtys, v_notes) with ordinality t(m, q, n, o)))::text, 'UTF8'), 'sha256'), 'hex');
  insert into public.idempotency_keys (restaurant_id, key, command, request_hash, created_by)
  values (p_rid, p_idempotency_key, 'order.submit', v_hash, (select auth.uid()))
  on conflict (restaurant_id, key, command) do nothing
  returning id into v_idem;
  if v_idem is null then
    -- a concurrent first execution has committed by now (the INSERT waited for it); a rolled-back one leaves no row
    select * into v_prev from public.idempotency_keys k
    where k.restaurant_id = p_rid and k.key = p_idempotency_key and k.command = 'order.submit';
    if v_prev.request_hash is distinct from v_hash then perform public.fn_err('idempotency_conflict'); end if;
    if v_prev.result is null or (v_prev.result ->> 'order_id') is null then perform public.fn_err('invalid_state', 'idempotency_pending'); end if;
    return public.fn_order_json((v_prev.result ->> 'order_id')::uuid) || jsonb_build_object('replayed', true);
  end if;

  -- ── business day (FOR SHARE: a concurrent close waits for this order, or this order sees the close) ──
  select d.id into v_day from public.day_sessions d where d.restaurant_id = p_rid and d.status = 'open' for share;
  if v_day is null then perform public.fn_err('day_closed', 'no open business day'); end if;

  -- ── table (optional): an active table of this tenant, not out of service; joins its open table session ──
  if p_table_id is not null then
    select * into v_table from public.tables t where t.id = p_table_id and t.restaurant_id = p_rid and t.is_active for update;
    if not found then perform public.fn_err('invalid_input', 'table_id'); end if;
    if v_table.status = 'out_of_service' then perform public.fn_err('invalid_state', 'table_unavailable'); end if;
    if p_table_session_id is not null then
      select ts.id into v_tsess from public.table_sessions ts
      where ts.id = p_table_session_id and ts.restaurant_id = p_rid and ts.table_id = p_table_id and ts.status = 'open';
      if v_tsess is null then perform public.fn_err('invalid_input', 'table_session_id'); end if;
    else
      select ts.id into v_tsess from public.table_sessions ts
      where ts.table_id = p_table_id and ts.restaurant_id = p_rid and ts.status = 'open';
    end if;
  elsif p_table_session_id is not null then
    perform public.fn_err('invalid_input', 'table_session_id');
  end if;

  -- ── menu items: FOR SHARE in id order (price, station and recipe cannot change under this order) ──
  select count(*) into v_n_found from (
    select 1 from public.menu_items m
    where m.restaurant_id = p_rid and m.id = any (v_mids)
    order by m.id for share of m) x;
  if v_n_found <> (select count(distinct u) from unnest(v_mids) u) then
    perform public.fn_err('invalid_input', 'menu_item_id');   -- unknown and foreign ids are the same answer
  end if;
  -- on sale = item active AND its station active AND its category active (detail = the tenant's own item name)
  select m.name into v_bad
  from public.menu_items m
  join public.stations s on s.id = m.station_id and s.restaurant_id = m.restaurant_id
  join public.categories c on c.id = m.category_id and c.restaurant_id = m.restaurant_id
  where m.restaurant_id = p_rid and m.id = any (v_mids) and not (m.is_active and s.is_active and c.is_active)
  order by m.name limit 1;
  if v_bad is not null then perform public.fn_err('item_unavailable', v_bad); end if;

  -- ── server-side money ──
  select sum(m.price * t.q) into v_sub
  from unnest(v_mids, v_qtys) t(mid, q) join public.menu_items m on m.id = t.mid and m.restaurant_id = p_rid;
  v_vat := round(v_sub * v_vat_rate / 100, 2);
  if v_sub + v_vat > c_max then perform public.fn_err('invalid_input', 'total'); end if;

  -- ── create ──
  v_no := public.fn_next_number(p_rid, 'order', 'ORD-');
  if p_created_by is not null then
    select p.short_name into v_name from public.profiles p where p.id = p_created_by and p.restaurant_id = p_rid;
  end if;
  insert into public.orders (restaurant_id, day_session_id, order_no, source, order_type, table_id, table_label_snapshot,
                             table_session_id, customer_session_id, created_by, created_by_name_snapshot, subtotal,
                             vat_rate_snapshot, vat_amount, total, client_key, customer_note)
  values (p_rid, v_day, v_no, p_source, p_order_type, v_table.id, v_table.label, v_tsess, p_customer_session_id,
          p_created_by, left(v_name, 140), v_sub, v_vat_rate, v_vat, v_sub + v_vat, p_idempotency_key, v_cnote)
  returning id into v_order;
  -- per-line station routing: the line goes to the menu item's station (snapshot id + name); the 0012 trigger re-checks it
  insert into public.order_items (restaurant_id, order_id, menu_item_id, name_snapshot, price_snapshot, qty, station_id,
                                  station_name_snapshot, note, line_no)
  select p_rid, v_order, m.id, m.name, m.price, t.q, m.station_id, s.name, t.n, t.o::integer
  from unnest(v_mids, v_qtys, v_notes) with ordinality t(mid, q, n, o)
  join public.menu_items m on m.id = t.mid and m.restaurant_id = p_rid
  join public.stations s on s.id = m.station_id and s.restaurant_id = p_rid
  order by t.o;

  -- ── recipe consumption (restaurants.auto_consume_stock) ──
  if v_auto then
    -- every ingredient of the whole cart, ONE statement, ingredient-id order: two orders can never lock in opposite order
    perform 1 from public.ingredients i
    where i.restaurant_id = p_rid
      and i.id in (select rl.ingredient_id from public.recipe_lines rl where rl.restaurant_id = p_rid and rl.menu_item_id = any (v_mids))
    order by i.id for update;
    for r in select t.mid, t.q from unnest(v_mids, v_qtys) with ordinality t(mid, q, o) order by t.o loop
      v_mov := v_mov + public.fn_apply_recipe_consumption(v_order, r.mid, r.q);   -- insufficient_stock aborts the whole order
    end loop;
    update public.orders set stock_consumed = true where id = v_order and restaurant_id = p_rid;
  end if;

  -- ── table state ──
  if v_table.id is not null and v_table.status = 'available' then
    update public.tables set status = 'occupied' where id = v_table.id and restaurant_id = p_rid;
  end if;

  perform public.fn_write_audit('order.submitted', jsonb_build_object(
    'order_id', v_order, 'order_no', v_no, 'source', p_source, 'lines', cardinality(v_mids), 'subtotal', v_sub, 'vat_amount', v_vat,
    'total', v_sub + v_vat, 'stock_movements', v_mov, 'table_id', v_table.id), p_rid);
  update public.idempotency_keys set result = jsonb_build_object('order_id', v_order, 'order_no', v_no)
  where id = v_idem;
  v_res := public.fn_order_json(v_order) || jsonb_build_object('replayed', false);
  return v_res;
end;
$$;

-- ── staff entry point ───────────────────────────────────────────────────────
create or replace function public.fn_submit_order(
  p_items jsonb, p_idempotency_key text, p_order_type text default 'dine-in', p_table_id uuid default null,
  p_customer_note text default null)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_rid uuid := public.fn_tenant_status_guard(true);
begin
  if not public.has_permission('orders.create') then perform public.fn_err('permission_denied'); end if;
  return public.fn_order_create(v_rid, 'staff', (select auth.uid()), p_items, p_idempotency_key, p_order_type, p_table_id, null, null,
                                p_customer_note);
end;
$$;

-- ── visibility rule shared by the order commands (same predicate as the orders_select policy) ──
create or replace function public.fn_order_visible(p_created_by uuid, p_station_ids uuid[])
returns boolean
language sql stable security definer set search_path = ''
as $$
  select public.has_permission('orders.view')
     and (public.has_permission('orders.view_all')
          or p_created_by = (select auth.uid())
          or p_station_ids && public.current_station_ids())
$$;

-- ── cancel ──────────────────────────────────────────────────────────────────
-- Only while every item is still pending, the order is unpaid (no payment row at all) and its business day is open. Consumed stock is
-- given back with compensating 'reversal' rows (fn_reverse_order_consumption). A second call on a cancelled order is a no-op replay.
create or replace function public.fn_cancel_order(p_order_id uuid, p_reason text default null)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_rid uuid := public.fn_tenant_status_guard(true);
  v_o public.orders%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_day_status text;
  v_n integer := 0;
begin
  if not public.has_permission('orders.cancel') then perform public.fn_err('permission_denied'); end if;
  if p_order_id is null then perform public.fn_err('invalid_input', 'order_id'); end if;
  if v_reason is not null and char_length(v_reason) > 300 then perform public.fn_err('invalid_input', 'reason'); end if;
  -- the order row is locked FIRST (station start / serve / payment take the same lock first)
  select * into v_o from public.orders o where o.id = p_order_id and o.restaurant_id = v_rid for update;
  if not found or not public.fn_order_visible(v_o.created_by, v_o.station_ids) then perform public.fn_err('not_found'); end if;
  if v_o.status = 'cancelled' then
    return jsonb_build_object('order_id', v_o.id, 'order_no', v_o.order_no, 'status', v_o.status, 'reversed_movements', 0,
                              'already_cancelled', true);
  end if;
  select d.status into v_day_status from public.day_sessions d where d.id = v_o.day_session_id and d.restaurant_id = v_rid for share;
  if v_day_status is distinct from 'open' then perform public.fn_err('day_closed', 'order business day is closed'); end if;
  if v_o.payment_status <> 'unpaid'
     or exists (select 1 from public.payments p where p.order_id = v_o.id and p.restaurant_id = v_rid) then
    perform public.fn_err('order_not_cancellable', 'payment_recorded');
  end if;
  if v_o.status <> 'submitted'
     or exists (select 1 from public.order_items oi where oi.order_id = v_o.id and oi.restaurant_id = v_rid
                and oi.item_status not in ('pending', 'cancelled')) then
    perform public.fn_err('order_not_cancellable', 'in_preparation');
  end if;
  if v_o.stock_consumed then
    v_n := public.fn_reverse_order_consumption(v_o.id);
  end if;
  update public.order_items set item_status = 'cancelled'
  where order_id = v_o.id and restaurant_id = v_rid and item_status = 'pending';
  update public.orders
     set status = 'cancelled', cancelled_at = now(), cancelled_by = (select auth.uid()), cancel_reason = v_reason, stock_consumed = false
   where id = v_o.id and restaurant_id = v_rid;
  perform public.fn_write_audit('order.cancelled', jsonb_build_object('order_id', v_o.id, 'order_no', v_o.order_no, 'reason', v_reason,
                                'total', v_o.total, 'reversed_movements', v_n));
  return jsonb_build_object('order_id', v_o.id, 'order_no', v_o.order_no, 'status', 'cancelled', 'reversed_movements', v_n,
                            'already_cancelled', false);
end;
$$;

-- ── station workflow (KDS) ──────────────────────────────────────────────────
-- p_status 'preparing' ("start": that station's pending lines) or 'ready' (its pending / preparing lines). Authorisation is the station
-- itself: orders.view + access to p_station_id (role_station_access, the structured station:<uuid> grant; tenant_admin = every station).
-- A Kitchen operator naming the Bar station is permission_denied; an order without lines at the named station is not_found.
-- Rollup: start moves a submitted order to preparing; when no line is left pending / preparing the order becomes ready.
create or replace function public.fn_set_station_items_status(p_order_id uuid, p_station_id uuid, p_status text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_rid uuid := public.fn_tenant_status_guard(true);
  v_o public.orders%rowtype;
  v_day_status text;
  v_n integer;
  v_order_status text;
begin
  if not public.has_permission('orders.view') then perform public.fn_err('permission_denied'); end if;
  if p_order_id is null then perform public.fn_err('invalid_input', 'order_id'); end if;
  if p_status is null or p_status not in ('preparing', 'ready') then perform public.fn_err('invalid_input', 'status'); end if;
  if p_station_id is null or not public.has_station_access(p_station_id) then perform public.fn_err('permission_denied', 'station'); end if;
  select * into v_o from public.orders o where o.id = p_order_id and o.restaurant_id = v_rid for update;
  if not found or not exists (select 1 from public.order_items oi where oi.order_id = v_o.id and oi.restaurant_id = v_rid
                              and oi.station_id = p_station_id) then
    perform public.fn_err('not_found');
  end if;
  select d.status into v_day_status from public.day_sessions d where d.id = v_o.day_session_id and d.restaurant_id = v_rid for share;
  if v_day_status is distinct from 'open' then perform public.fn_err('day_closed', 'order business day is closed'); end if;
  if v_o.status in ('cancelled', 'served') then perform public.fn_err('invalid_state_transition', 'order_' || v_o.status); end if;
  if p_status = 'preparing' then
    update public.order_items set item_status = 'preparing', started_at = now()
    where order_id = v_o.id and restaurant_id = v_rid and station_id = p_station_id and item_status = 'pending';
  else
    update public.order_items set item_status = 'ready', ready_at = now(), started_at = coalesce(started_at, now())
    where order_id = v_o.id and restaurant_id = v_rid and station_id = p_station_id and item_status in ('pending', 'preparing');
  end if;
  get diagnostics v_n = row_count;
  if v_n = 0 then perform public.fn_err('invalid_state_transition', 'no_lines_to_' || p_status); end if;
  v_order_status := v_o.status;
  if not exists (select 1 from public.order_items oi where oi.order_id = v_o.id and oi.restaurant_id = v_rid
                 and oi.item_status in ('pending', 'preparing')) then
    v_order_status := 'ready';
    update public.orders set status = 'ready', ready_at = now() where id = v_o.id and restaurant_id = v_rid;
  elsif v_o.status = 'submitted' then
    v_order_status := 'preparing';
    update public.orders set status = 'preparing' where id = v_o.id and restaurant_id = v_rid;
  end if;
  perform public.fn_write_audit('order.station_status', jsonb_build_object('order_id', v_o.id, 'order_no', v_o.order_no,
                                'station_id', p_station_id, 'status', p_status, 'lines', v_n, 'order_status', v_order_status));
  return public.fn_order_json(v_o.id, p_station_id);
end;
$$;

-- ── serve ───────────────────────────────────────────────────────────────────
-- A READY order is handed to the guest: orders.create and (own order or orders.view_all).
create or replace function public.fn_serve_order(p_order_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_rid uuid := public.fn_tenant_status_guard(true);
  v_o public.orders%rowtype;
  v_day_status text;
begin
  if not public.has_permission('orders.create') then perform public.fn_err('permission_denied'); end if;
  if p_order_id is null then perform public.fn_err('invalid_input', 'order_id'); end if;
  select * into v_o from public.orders o where o.id = p_order_id and o.restaurant_id = v_rid for update;
  if not found or not (public.has_permission('orders.view')
                       and (public.has_permission('orders.view_all') or v_o.created_by = (select auth.uid()))) then
    perform public.fn_err('not_found');
  end if;
  select d.status into v_day_status from public.day_sessions d where d.id = v_o.day_session_id and d.restaurant_id = v_rid for share;
  if v_day_status is distinct from 'open' then perform public.fn_err('day_closed', 'order business day is closed'); end if;
  if v_o.status <> 'ready' then perform public.fn_err('invalid_state_transition', 'order_' || v_o.status); end if;
  update public.order_items set item_status = 'served', served_at = now()
  where order_id = v_o.id and restaurant_id = v_rid and item_status = 'ready';
  update public.orders set status = 'served', served_at = now() where id = v_o.id and restaurant_id = v_rid;
  perform public.fn_write_audit('order.served', jsonb_build_object('order_id', v_o.id, 'order_no', v_o.order_no));
  return public.fn_order_json(v_o.id);
end;
$$;

-- ── privileges ──────────────────────────────────────────────────────────────
revoke all on function
  public.fn_order_json(uuid, uuid),
  public.fn_order_create(uuid, text, uuid, jsonb, text, text, uuid, uuid, uuid, text),
  public.fn_order_visible(uuid, uuid[]),
  public.fn_submit_order(jsonb, text, text, uuid, text),
  public.fn_cancel_order(uuid, text),
  public.fn_set_station_items_status(uuid, uuid, text),
  public.fn_serve_order(uuid)
  from public, anon, authenticated, service_role;
grant execute on function
  public.fn_submit_order(jsonb, text, text, uuid, text),
  public.fn_cancel_order(uuid, text),
  public.fn_set_station_items_status(uuid, uuid, text),
  public.fn_serve_order(uuid)
  to authenticated;
-- orders / order_items: SELECT only for clients (0009). Re-assert: no client write privilege on the order tables.
revoke insert, update, delete, truncate on public.orders, public.order_items from anon, authenticated;

-- ── Realtime: orders (column list, 0019) and order_items (0009) are published; make sure (idempotent) ──
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public'
                     and tablename = 'order_items') then
    alter table public.order_items replica identity full;
    alter publication supabase_realtime add table public.order_items;
  end if;
end $$;
