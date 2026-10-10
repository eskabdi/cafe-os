-- 0034  Phase 6 (Cashier and Payments), database layer
--
--  * fn_confirm_payment(order, payment_method, reference, idempotency_key, tendered)   payments.create
--      Pays an order IN FULL with one tenant payment method (a DB row, never a name): amount = orders.total (server-side; the client
--      never sends an amount), receipt number RCT-nnnn, method name / cash-drawer snapshots, orders.payment_status -> 'paid'. Cash
--      (affects_cash_drawer) may pass the tendered amount: it must cover the total and the change is returned (not stored).
--  * fn_reverse_payment(payment, reason, idempotency_key)   payments.reverse + step-up
--      A confirmed order payment is never edited or deleted: a compensating 'reversal' row (same amount / method / order, its own
--      receipt number) is appended and the order goes back to 'unpaid'. One reversal per payment (unique index, 0005).
--  * fn_get_receipt(payment)   payments.view (any) or payments.create (own receipts only): the receipt document (restaurant identity, lines, VAT, totals,
--      payment) as JSON for the printable receipt; fn_receipt_json is the internal builder.
--
--  Every command: tenant from identity, permission, open business day (FOR SHARE; payments land in the OPEN day), idempotency with a
--  payload fingerprint (incl. the actor), lock order  key -> day -> order (FOR UPDATE) -> payment method (FOR SHARE) -> counter, audit row.
--  The order must belong to the OPEN day: an order (or a payment) of a closed day is refused with day_closed / 'order business day is
--  closed' (a closed day is frozen; its corrections belong to the day-close phase).
--  * LOCK ORDER RULE (every order command, Phase 9 fn_close_day included): the tenant's open day FOR SHARE first, then the order FOR
--    UPDATE. fn_cancel_order / fn_set_station_items_status / fn_serve_order are redefined below to follow it (0033 locked the order
--    first), and fn_cancel_order now looks at the NET payment (a reversed payment no longer blocks the cancellation).
--  Clients keep SELECT only on payments (RLS payments_select: payments.view); these RPCs are the only writers.

-- ── internal: the receipt document ──────────────────────────────────────────
create or replace function public.fn_receipt_json(p_payment_id uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'payment_id', p.id, 'receipt_no', p.receipt_no, 'kind', p.kind, 'amount', p.amount, 'created_at', p.created_at,
    'method', p.method_name_snapshot, 'affects_cash_drawer', p.method_affects_drawer_snapshot, 'reference', p.reference,
    'reversed_payment_id', p.reversed_payment_id,
    'reversed', exists (select 1 from public.payments r where r.reversed_payment_id = p.id),
    'received_by', (select pr.short_name from public.profiles pr where pr.id = p.created_by and pr.restaurant_id = p.restaurant_id),
    'restaurant', (select jsonb_build_object('name', r.name, 'phone', r.phone, 'address', r.address, 'tin', r.tin, 'timezone', r.timezone)
                   from public.restaurants r where r.id = p.restaurant_id),
    'order', (select jsonb_build_object(
                'id', o.id, 'order_no', o.order_no, 'order_type', o.order_type, 'table_label', o.table_label_snapshot,
                'taken_by', o.created_by_name_snapshot, 'created_at', o.created_at,
                'subtotal', o.subtotal, 'vat_rate', o.vat_rate_snapshot, 'vat_amount', o.vat_amount, 'total', o.total,
                'items', coalesce((select jsonb_agg(jsonb_build_object('name', oi.name_snapshot, 'qty', oi.qty, 'price', oi.price_snapshot,
                                                                       'line_total', oi.price_snapshot * oi.qty)
                                                    order by oi.line_no nulls last, oi.created_at, oi.id)
                                   from public.order_items oi where oi.order_id = o.id and oi.restaurant_id = o.restaurant_id
                                     and oi.item_status <> 'cancelled'), '[]'::jsonb))
              from public.orders o where o.id = p.order_id and o.restaurant_id = p.restaurant_id))
  from public.payments p where p.id = p_payment_id
$$;
revoke all on function public.fn_receipt_json(uuid) from public, anon, authenticated, service_role;

-- ── confirm (pay in full) ───────────────────────────────────────────────────
create or replace function public.fn_confirm_payment(
  p_order_id uuid, p_payment_method_id uuid, p_reference text, p_idempotency_key text, p_tendered numeric default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rid uuid := public.fn_tenant_status_guard(true);
  v_ref text := nullif(btrim(coalesce(p_reference, '')), '');
  v_hash text;
  v_replay jsonb;
  v_day uuid;
  v_o public.orders%rowtype;
  v_m public.payment_methods%rowtype;
  v_pay uuid;
  v_no text;
  v_res jsonb;
begin
  if not public.has_permission('payments.create') then perform public.fn_err('permission_denied'); end if;
  perform public.fn_check_idempotency_key(p_idempotency_key);
  if p_order_id is null then perform public.fn_err('invalid_input', 'order_id'); end if;
  if p_payment_method_id is null then perform public.fn_err('invalid_input', 'payment_method_id'); end if;
  if v_ref is not null and (char_length(v_ref) > 120 or v_ref ~ '[[:cntrl:]]') then perform public.fn_err('invalid_input', 'reference'); end if;
  if p_tendered is not null and (p_tendered <= 0 or p_tendered > 9999999999.99 or p_tendered <> round(p_tendered, 2)) then
    perform public.fn_err('invalid_input', 'tendered');
  end if;

  v_hash := encode(extensions.digest(convert_to(format('%s|%s|%s|%s|%s', (select auth.uid()), p_order_id, p_payment_method_id,
                                                      coalesce(v_ref, ''), coalesce(p_tendered::text, '')), 'UTF8'), 'sha256'), 'hex');
  v_replay := public.fn_idempotency_begin(p_idempotency_key, 'payment.confirm', v_hash);
  if v_replay is not null then
    if v_replay -> 'result' is null or jsonb_typeof(v_replay -> 'result') = 'null' then perform public.fn_err('invalid_state', 'idempotency_pending'); end if;
    -- the receipt is rebuilt (current 'reversed' flag); tendered / change come from the stored first answer
    return public.fn_receipt_json((v_replay -> 'result' ->> 'payment_id')::uuid)
           || jsonb_build_object('tendered', v_replay -> 'result' -> 'tendered', 'change', v_replay -> 'result' -> 'change', 'replayed', true);
  end if;

  select d.id into v_day from public.day_sessions d where d.restaurant_id = v_rid and d.status = 'open' for share;
  if v_day is null then perform public.fn_err('day_closed', 'no open business day'); end if;

  select * into v_o from public.orders o where o.id = p_order_id and o.restaurant_id = v_rid for update;
  if not found then perform public.fn_err('not_found'); end if;
  if v_o.day_session_id is distinct from v_day then perform public.fn_err('day_closed', 'order business day is closed'); end if;
  if v_o.status = 'cancelled' then perform public.fn_err('order_not_payable', 'cancelled'); end if;
  if v_o.payment_status <> 'unpaid' then perform public.fn_err('order_not_payable', v_o.payment_status); end if;
  if v_o.total <= 0 then perform public.fn_err('order_not_payable', 'zero_total'); end if;

  select * into v_m from public.payment_methods m where m.id = p_payment_method_id and m.restaurant_id = v_rid for share;
  if not found or not v_m.is_active then perform public.fn_err('invalid_input', 'payment_method_id'); end if;
  if v_m.requires_reference and v_ref is null then perform public.fn_err('invalid_input', 'reference'); end if;
  if p_tendered is not null then
    if not v_m.affects_cash_drawer then perform public.fn_err('invalid_input', 'tendered'); end if;
    if p_tendered < v_o.total then perform public.fn_err('insufficient_tendered'); end if;
  end if;

  v_no := public.fn_next_number(v_rid, 'receipt', 'RCT-');
  insert into public.payments (restaurant_id, day_session_id, order_id, kind, amount, payment_method_id, method_name_snapshot,
                               method_affects_drawer_snapshot, reference, receipt_no, created_by)
  values (v_rid, v_day, v_o.id, 'order_payment', v_o.total, v_m.id, v_m.name, v_m.affects_cash_drawer, v_ref, v_no, (select auth.uid()))
  returning id into v_pay;
  update public.orders set payment_status = 'paid' where id = v_o.id and restaurant_id = v_rid;

  perform public.fn_write_audit('payment.confirmed', jsonb_build_object('payment_id', v_pay, 'order_id', v_o.id, 'order_no', v_o.order_no,
                                'receipt_no', v_no, 'amount', v_o.total, 'payment_method_id', v_m.id));
  v_res := public.fn_receipt_json(v_pay)
           || jsonb_build_object('tendered', p_tendered, 'change', case when p_tendered is null then null else p_tendered - v_o.total end);
  perform public.fn_idempotency_complete(p_idempotency_key, 'payment.confirm', v_res);
  return v_res || jsonb_build_object('replayed', false);
end;
$$;

-- ── reverse (compensating record) ───────────────────────────────────────────
create or replace function public.fn_reverse_payment(p_payment_id uuid, p_reason text, p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rid uuid := public.fn_tenant_status_guard(true);
  v_reason text := btrim(coalesce(p_reason, ''));
  v_hash text;
  v_replay jsonb;
  v_day uuid;
  v_p public.payments%rowtype;
  v_o public.orders%rowtype;
  v_rev uuid;
  v_no text;
  v_res jsonb;
begin
  if not public.has_permission('payments.reverse') then perform public.fn_err('permission_denied'); end if;
  perform public.fn_require_step_up();
  perform public.fn_check_idempotency_key(p_idempotency_key);
  if p_payment_id is null then perform public.fn_err('invalid_input', 'payment_id'); end if;
  if char_length(v_reason) not between 3 and 300 or v_reason ~ '[[:cntrl:]]' then perform public.fn_err('invalid_input', 'reason'); end if;

  v_hash := encode(extensions.digest(convert_to(format('%s|%s|%s', (select auth.uid()), p_payment_id, v_reason), 'UTF8'), 'sha256'), 'hex');
  v_replay := public.fn_idempotency_begin(p_idempotency_key, 'payment.reverse', v_hash);
  if v_replay is not null then
    if v_replay -> 'result' is null or jsonb_typeof(v_replay -> 'result') = 'null' then perform public.fn_err('invalid_state', 'idempotency_pending'); end if;
    return public.fn_receipt_json((v_replay -> 'result' ->> 'payment_id')::uuid) || jsonb_build_object('replayed', true);
  end if;

  select d.id into v_day from public.day_sessions d where d.restaurant_id = v_rid and d.status = 'open' for share;
  if v_day is null then perform public.fn_err('day_closed', 'no open business day'); end if;

  -- day (above), then the order, then the payment: the lock order of every order command
  select p.* into v_p from public.payments p where p.id = p_payment_id and p.restaurant_id = v_rid;
  if not found then perform public.fn_err('not_found'); end if;
  if v_p.kind <> 'order_payment' then perform public.fn_err('invalid_state', 'not_an_order_payment'); end if;
  select * into v_o from public.orders o where o.id = v_p.order_id and o.restaurant_id = v_rid for update;
  if not found then perform public.fn_err('not_found'); end if;
  -- a payment of a closed business day is frozen with its day (its order cannot change any more)
  if v_p.day_session_id is distinct from v_day or v_o.day_session_id is distinct from v_day then
    perform public.fn_err('day_closed', 'payment business day is closed');
  end if;
  select p.* into v_p from public.payments p where p.id = p_payment_id and p.restaurant_id = v_rid for update;
  if exists (select 1 from public.payments r where r.reversed_payment_id = v_p.id) then
    perform public.fn_err('invalid_state', 'already_reversed');
  end if;
  if v_o.payment_status <> 'paid' then perform public.fn_err('invalid_state', 'order_not_paid'); end if;

  v_no := public.fn_next_number(v_rid, 'receipt', 'RCT-');
  insert into public.payments (restaurant_id, day_session_id, order_id, kind, amount, payment_method_id, method_name_snapshot,
                               method_affects_drawer_snapshot, reference, receipt_no, reversed_payment_id, created_by)
  values (v_rid, v_day, v_p.order_id, 'reversal', v_p.amount, v_p.payment_method_id, v_p.method_name_snapshot,
          v_p.method_affects_drawer_snapshot, left(v_reason, 120) /* full reason in the audit row */, v_no, v_p.id, (select auth.uid()))
  returning id into v_rev;
  update public.orders set payment_status = 'unpaid' where id = v_o.id and restaurant_id = v_rid;

  perform public.fn_write_audit('payment.reversed', jsonb_build_object('payment_id', v_p.id, 'reversal_id', v_rev, 'order_id', v_o.id,
                                'amount', v_p.amount, 'reason', v_reason));
  v_res := public.fn_receipt_json(v_rev);
  perform public.fn_idempotency_complete(p_idempotency_key, 'payment.reverse', v_res);
  return v_res || jsonb_build_object('replayed', false);
end;
$$;

-- ── read a receipt ──────────────────────────────────────────────────────────
create or replace function public.fn_get_receipt(p_payment_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_rid uuid := public.fn_tenant_status_guard(false);
begin
  if not (public.has_permission('payments.view') or public.has_permission('payments.create')) then
    perform public.fn_err('permission_denied');
  end if;
  -- payments.view: any receipt of the tenant (same as RLS payments_select); payments.create alone: only the receipts the caller issued
  if p_payment_id is null or not exists (select 1 from public.payments p where p.id = p_payment_id and p.restaurant_id = v_rid
                                         and (public.has_permission('payments.view') or p.created_by = (select auth.uid()))) then
    perform public.fn_err('not_found');
  end if;
  return public.fn_receipt_json(p_payment_id);
end;
$$;

revoke all on function public.fn_confirm_payment(uuid, uuid, text, text, numeric), public.fn_reverse_payment(uuid, text, text),
  public.fn_get_receipt(uuid) from public, anon;
grant execute on function public.fn_confirm_payment(uuid, uuid, text, text, numeric), public.fn_reverse_payment(uuid, text, text),
  public.fn_get_receipt(uuid) to authenticated;

-- ── 0033 order commands, redefined: open day FOR SHARE first, then the order (one lock order for every order command) ─────────
-- Same behaviour as 0033 except: the order must belong to the tenant's open day (otherwise day_closed, as before), and fn_cancel_order
-- looks at the NET payment: an order payment that has been reversed no longer blocks the cancellation of an unpaid order.
create or replace function public.fn_cancel_order(p_order_id uuid, p_reason text default null)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_rid uuid := public.fn_tenant_status_guard(true);
  v_o public.orders%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_day uuid;
  v_n integer := 0;
begin
  if not public.has_permission('orders.cancel') then perform public.fn_err('permission_denied'); end if;
  if p_order_id is null then perform public.fn_err('invalid_input', 'order_id'); end if;
  if v_reason is not null and char_length(v_reason) > 300 then perform public.fn_err('invalid_input', 'reason'); end if;
  select d.id into v_day from public.day_sessions d where d.restaurant_id = v_rid and d.status = 'open' for share;
  select * into v_o from public.orders o where o.id = p_order_id and o.restaurant_id = v_rid for update;
  if not found or not public.fn_order_visible(v_o.created_by, v_o.station_ids) then perform public.fn_err('not_found'); end if;
  if v_o.status = 'cancelled' then
    return jsonb_build_object('order_id', v_o.id, 'order_no', v_o.order_no, 'status', v_o.status, 'reversed_movements', 0,
                              'already_cancelled', true);
  end if;
  if v_day is null or v_o.day_session_id is distinct from v_day then perform public.fn_err('day_closed', 'order business day is closed'); end if;
  if v_o.payment_status <> 'unpaid'
     or exists (select 1 from public.payments p where p.order_id = v_o.id and p.restaurant_id = v_rid and p.kind <> 'reversal'
                and not exists (select 1 from public.payments r where r.reversed_payment_id = p.id and r.restaurant_id = v_rid)) then
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

create or replace function public.fn_set_station_items_status(p_order_id uuid, p_station_id uuid, p_status text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_rid uuid := public.fn_tenant_status_guard(true);
  v_o public.orders%rowtype;
  v_day uuid;
  v_n integer;
  v_order_status text;
begin
  if not public.has_permission('orders.view') then perform public.fn_err('permission_denied'); end if;
  if p_order_id is null then perform public.fn_err('invalid_input', 'order_id'); end if;
  if p_status is null or p_status not in ('preparing', 'ready') then perform public.fn_err('invalid_input', 'status'); end if;
  if p_station_id is null or not public.has_station_access(p_station_id)
     or not exists (select 1 from public.stations st where st.id = p_station_id and st.restaurant_id = v_rid) then
    perform public.fn_err('permission_denied', 'station');
  end if;
  select d.id into v_day from public.day_sessions d where d.restaurant_id = v_rid and d.status = 'open' for share;
  select * into v_o from public.orders o where o.id = p_order_id and o.restaurant_id = v_rid for update;
  if not found or not exists (select 1 from public.order_items oi where oi.order_id = v_o.id and oi.restaurant_id = v_rid
                              and oi.station_id = p_station_id) then
    perform public.fn_err('not_found');
  end if;
  if v_day is null or v_o.day_session_id is distinct from v_day then perform public.fn_err('day_closed', 'order business day is closed'); end if;
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

create or replace function public.fn_serve_order(p_order_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_rid uuid := public.fn_tenant_status_guard(true);
  v_o public.orders%rowtype;
  v_day uuid;
begin
  if not public.has_permission('orders.create') then perform public.fn_err('permission_denied'); end if;
  if p_order_id is null then perform public.fn_err('invalid_input', 'order_id'); end if;
  select d.id into v_day from public.day_sessions d where d.restaurant_id = v_rid and d.status = 'open' for share;
  select * into v_o from public.orders o where o.id = p_order_id and o.restaurant_id = v_rid for update;
  if not found or not (public.has_permission('orders.view')
                       and (public.has_permission('orders.view_all') or v_o.created_by = (select auth.uid()))) then
    perform public.fn_err('not_found');
  end if;
  if v_day is null or v_o.day_session_id is distinct from v_day then perform public.fn_err('day_closed', 'order business day is closed'); end if;
  if v_o.status <> 'ready' then perform public.fn_err('invalid_state_transition', 'order_' || v_o.status); end if;
  update public.order_items set item_status = 'served', served_at = now()
  where order_id = v_o.id and restaurant_id = v_rid and item_status = 'ready';
  update public.orders set status = 'served', served_at = now() where id = v_o.id and restaurant_id = v_rid;
  perform public.fn_write_audit('order.served', jsonb_build_object('order_id', v_o.id, 'order_no', v_o.order_no));
  return public.fn_order_json(v_o.id);
end;
$$;
