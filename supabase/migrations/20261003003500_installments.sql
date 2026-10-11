-- 0035  Phase 7 (Installments), database layer
--
--  * fn_generate_voucher(order, customer name / phone, down payment, down method, down reference, installment count, interval days,
--                        idempotency key)   vouchers.manage
--      Turns an unpaid order of the open day into an installment voucher: VCH-nnnn, the schedule is computed HERE from the server-side
--      order total (balance = total - down; ceil(balance / n) whole birr per installment, the remainder in the last one; when that
--      would leave the last installment at zero or below, an even split to the cent with the remainder in the last one), due dates
--      every interval_days from the tenant's local date, an optional down payment (payments.kind = 'down_payment', own receipt) and
--      orders.payment_status -> 'installment'.
--  * fn_confirm_installment(voucher, payment method, reference, idempotency key, installment no, tendered)   vouchers.manage
--      Collects the NEXT unpaid installment (lowest no) at its scheduled amount (never a client amount): payments.kind =
--      'installment_payment' in the OPEN day, its own receipt; the installment row is marked paid. An explicit p_installment_no must be
--      that next one (invalid_installment_no); none left -> voucher_already_settled. Guards double payment and overpayment.
--  * fn_get_voucher(voucher)   vouchers.view: voucher, schedule, paid / outstanding amounts, computed status.
--  * fn_voucher_json internal; fn_receipt_json now carries a voucher block for down / installment payments.
--
--  Status is COMPUTED, never stored: settled (every installment paid) > overdue (an unpaid installment due before the tenant's local
--  today) > active. Lock order: key -> day (FOR SHARE) -> order (FOR UPDATE) -> voucher (FOR UPDATE) -> payment method (FOR SHARE) ->
--  counter. Installment payments are not reversible here (a settled installment of a closed day is frozen by the day guard).

-- ── internal: tenant local date ─────────────────────────────────────────────
create or replace function public.fn_tenant_today(p_rid uuid)
returns date
language sql stable security definer set search_path = ''
as $$
  select (now() at time zone coalesce((select r.timezone from public.restaurants r where r.id = p_rid), 'Africa/Addis_Ababa'))::date
$$;
revoke all on function public.fn_tenant_today(uuid) from public, anon, authenticated, service_role;

-- ── internal: the voucher document ──────────────────────────────────────────
create or replace function public.fn_voucher_json(p_voucher_id uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  with v as (select * from public.vouchers where id = p_voucher_id),
  i as (select x.* from public.installments x join v on x.voucher_id = v.id and x.restaurant_id = v.restaurant_id),
  agg as (select coalesce(sum(amount) filter (where paid), 0) paid_amt, coalesce(sum(amount) filter (where not paid), 0) open_amt,
                 count(*) filter (where paid) paid_n, count(*) n,
                 bool_or(not paid and due_date < public.fn_tenant_today((select restaurant_id from v))) overdue
          from i)
  select jsonb_build_object(
    'id', v.id, 'voucher_no', v.voucher_no, 'order_id', v.order_id,
    'order_no', (select o.order_no from public.orders o where o.id = v.order_id and o.restaurant_id = v.restaurant_id),
    'customer_name', v.customer_name, 'customer_phone', v.customer_phone,
    'total', v.total, 'down_payment', v.down_payment, 'installment_count', v.installment_count, 'interval_days', v.interval_days,
    'created_at', v.created_at,
    'paid_installments', agg.paid_n, 'paid_amount', v.down_payment + agg.paid_amt, 'outstanding', agg.open_amt,
    'status', case when agg.paid_n = agg.n then 'settled' when coalesce(agg.overdue, false) then 'overdue' else 'active' end,
    'next_due', (select jsonb_build_object('no', x.no, 'due_date', x.due_date, 'amount', x.amount) from i x where not x.paid order by x.no limit 1),
    'installments', coalesce((select jsonb_agg(jsonb_build_object('no', x.no, 'due_date', x.due_date, 'amount', x.amount, 'paid', x.paid,
                                                                  'paid_at', x.paid_at, 'payment_id', x.payment_id) order by x.no) from i x), '[]'::jsonb))
  from v, agg
$$;
revoke all on function public.fn_voucher_json(uuid) from public, anon, authenticated, service_role;

-- ── receipt document: + voucher block ───────────────────────────────────────
create or replace function public.fn_receipt_json(p_payment_id uuid, p_restaurant_id uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'payment_id', p.id, 'receipt_no', p.receipt_no, 'kind', p.kind, 'amount', p.amount, 'created_at', p.created_at,
    'method', p.method_name_snapshot, 'affects_cash_drawer', p.method_affects_drawer_snapshot, 'reference', p.reference,
    'reversed_payment_id', p.reversed_payment_id,
    'reversed_receipt_no', (select o2.receipt_no from public.payments o2 where o2.id = p.reversed_payment_id and o2.restaurant_id = p.restaurant_id),
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
              from public.orders o where o.id = p.order_id and o.restaurant_id = p.restaurant_id),
    'voucher', case when p.voucher_id is null then null else (
      select jsonb_build_object('voucher_no', v.voucher_no, 'customer_name', v.customer_name, 'installment_no', p.installment_no,
                                'installment_count', v.installment_count, 'total', v.total,
                                -- the balance right after THIS payment (later payments excluded), so a reprint shows the same figures
                                'outstanding', v.total - v.down_payment
                                  - coalesce((select sum(x.amount) from public.installments x join public.payments q on q.id = x.payment_id
                                              where x.voucher_id = v.id and x.restaurant_id = v.restaurant_id and x.paid
                                                and (q.created_at, q.id) <= (p.created_at, p.id)), 0))
      from public.vouchers v where v.id = p.voucher_id and v.restaurant_id = p.restaurant_id) end)
  from public.payments p where p.id = p_payment_id and p.restaurant_id = p_restaurant_id
$$;
revoke all on function public.fn_receipt_json(uuid, uuid) from public, anon, authenticated, service_role;

-- ── generate a voucher ──────────────────────────────────────────────────────
create or replace function public.fn_generate_voucher(
  p_order_id uuid, p_customer_name text, p_customer_phone text, p_down_payment numeric, p_down_method_id uuid, p_down_reference text,
  p_installment_count integer, p_interval_days integer, p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rid uuid := public.fn_tenant_status_guard(true);
  v_name text := btrim(coalesce(p_customer_name, ''));
  v_phone text := nullif(btrim(coalesce(p_customer_phone, '')), '');
  v_down numeric := coalesce(p_down_payment, 0);
  v_ref text := nullif(btrim(coalesce(p_down_reference, '')), '');
  v_hash text;
  v_replay jsonb;
  v_day uuid;
  v_o public.orders%rowtype;
  v_m public.payment_methods%rowtype;
  v_balance numeric;
  v_per numeric;
  v_last numeric;
  v_vid uuid;
  v_vno text;
  v_pay uuid;
  v_today date;
  v_res jsonb;
begin
  -- receipts carry the order lines: vouchers.manage also needs order visibility (same rule as fn_confirm_payment)
  if not (public.has_permission('vouchers.manage') and public.has_permission('orders.view')) then perform public.fn_err('permission_denied'); end if;
  perform public.fn_check_idempotency_key(p_idempotency_key);
  if p_order_id is null then perform public.fn_err('invalid_input', 'order_id'); end if;
  if char_length(v_name) not between 1 and 80 or v_name ~ '[[:cntrl:]]' then perform public.fn_err('invalid_input', 'customer_name'); end if;
  if v_phone is not null and (char_length(v_phone) > 40 or v_phone !~ '^[0-9+() -]{3,40}$') then perform public.fn_err('invalid_input', 'customer_phone'); end if;
  if v_down < 0 or v_down <> round(v_down, 2) or v_down > 9999999999.99 then perform public.fn_err('invalid_input', 'down_payment'); end if;
  if p_installment_count is null or p_installment_count not between 1 and 60 then perform public.fn_err('invalid_input', 'installment_count'); end if;
  if p_interval_days is null or p_interval_days not between 1 and 365 then perform public.fn_err('invalid_input', 'interval_days'); end if;
  if v_ref is not null and (char_length(v_ref) > 120 or v_ref ~ '[[:cntrl:]]') then perform public.fn_err('invalid_input', 'reference'); end if;
  if v_down > 0 and p_down_method_id is null then perform public.fn_err('invalid_input', 'down_method_id'); end if;

  v_hash := encode(extensions.digest(convert_to(format('%s|%s|%s|%s|%s|%s|%s|%s|%s', (select auth.uid()), p_order_id, v_name, coalesce(v_phone, ''), v_down,
                     coalesce(p_down_method_id::text, ''), coalesce(v_ref, ''), p_installment_count, p_interval_days), 'UTF8'), 'sha256'), 'hex');
  v_replay := public.fn_idempotency_begin(p_idempotency_key, 'voucher.generate', v_hash);
  if v_replay is not null then
    if v_replay -> 'result' is null or jsonb_typeof(v_replay -> 'result') = 'null' then perform public.fn_err('invalid_state', 'idempotency_pending'); end if;
    return (v_replay -> 'result') || jsonb_build_object('replayed', true);
  end if;

  select d.id into v_day from public.day_sessions d where d.restaurant_id = v_rid and d.status = 'open' for share;
  if v_day is null then perform public.fn_err('day_closed', 'no open business day'); end if;

  select * into v_o from public.orders o where o.id = p_order_id and o.restaurant_id = v_rid for update;
  if not found then perform public.fn_err('not_found'); end if;
  if v_o.day_session_id is distinct from v_day then perform public.fn_err('day_closed', 'order business day is closed'); end if;
  if v_o.status = 'cancelled' then perform public.fn_err('order_not_payable', 'cancelled'); end if;
  if v_o.payment_status <> 'unpaid' then perform public.fn_err('order_not_payable', v_o.payment_status); end if;
  -- an order with a live (unreversed) payment is not unpaid even if its flag says so
  if exists (select 1 from public.payments p where p.order_id = v_o.id and p.restaurant_id = v_rid and p.kind <> 'reversal'
             and not exists (select 1 from public.payments r where r.reversed_payment_id = p.id and r.restaurant_id = v_rid)) then
    perform public.fn_err('order_not_payable', 'paid');
  end if;
  if v_o.total <= 0 then perform public.fn_err('order_not_payable', 'zero_total'); end if;
  if v_down >= v_o.total then perform public.fn_err('invalid_input', 'down_payment'); end if;

  if v_down > 0 then
    select * into v_m from public.payment_methods m where m.id = p_down_method_id and m.restaurant_id = v_rid for share;
    if not found or not v_m.is_active then perform public.fn_err('invalid_input', 'down_method_id'); end if;
    if v_m.requires_reference and v_ref is null then perform public.fn_err('invalid_input', 'reference'); end if;
  end if;

  -- schedule (server-side): ceil to whole birr, remainder in the last; fallback even split to the cent
  v_balance := v_o.total - v_down;
  v_per := ceil(v_balance / p_installment_count);
  v_last := v_balance - v_per * (p_installment_count - 1);
  if v_last <= 0 then
    v_per := trunc(v_balance / p_installment_count, 2);
    v_last := v_balance - v_per * (p_installment_count - 1);
  end if;
  if v_per <= 0 then perform public.fn_err('invalid_input', 'installment_count'); end if;

  v_vno := public.fn_next_number(v_rid, 'voucher', 'VCH-');
  v_today := public.fn_tenant_today(v_rid);
  insert into public.vouchers (restaurant_id, voucher_no, order_id, customer_name, customer_phone, total, down_payment,
                               down_payment_method_id, installment_count, interval_days, created_by)
  values (v_rid, v_vno, v_o.id, v_name, v_phone, v_o.total, v_down, case when v_down > 0 then v_m.id end, p_installment_count,
          p_interval_days, (select auth.uid()))
  returning id into v_vid;
  insert into public.installments (restaurant_id, voucher_id, no, due_date, amount)
  select v_rid, v_vid, g, v_today + p_interval_days * g, case when g = p_installment_count then v_last else v_per end
  from generate_series(1, p_installment_count) g;

  if v_down > 0 then
    insert into public.payments (restaurant_id, day_session_id, order_id, voucher_id, kind, amount, payment_method_id, method_name_snapshot,
                                 method_affects_drawer_snapshot, reference, receipt_no, created_by)
    values (v_rid, v_day, v_o.id, v_vid, 'down_payment', v_down, v_m.id, v_m.name, v_m.affects_cash_drawer, v_ref,
            public.fn_next_number(v_rid, 'receipt', 'RCT-'), (select auth.uid()))
    returning id into v_pay;
  end if;
  update public.orders set payment_status = 'installment' where id = v_o.id and restaurant_id = v_rid;

  perform public.fn_write_audit('voucher.issued', jsonb_build_object('voucher_id', v_vid, 'voucher_no', v_vno, 'order_id', v_o.id,
                                'total', v_o.total, 'down_payment', v_down, 'installment_count', p_installment_count,
                                'interval_days', p_interval_days, 'down_payment_id', v_pay));
  v_res := jsonb_build_object('voucher', public.fn_voucher_json(v_vid),
                              'down_receipt', case when v_pay is null then null else public.fn_receipt_json(v_pay, v_rid) end);
  perform public.fn_idempotency_complete(p_idempotency_key, 'voucher.generate', v_res);
  return v_res || jsonb_build_object('replayed', false);
end;
$$;

-- ── collect the next installment ────────────────────────────────────────────
create or replace function public.fn_confirm_installment(
  p_voucher_id uuid, p_payment_method_id uuid, p_reference text, p_idempotency_key text,
  p_installment_no integer default null, p_tendered numeric default null)
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
  v_v public.vouchers%rowtype;
  v_i public.installments%rowtype;
  v_m public.payment_methods%rowtype;
  v_pay uuid;
  v_res jsonb;
begin
  -- receipts carry the order lines: vouchers.manage also needs order visibility (same rule as fn_confirm_payment)
  if not (public.has_permission('vouchers.manage') and public.has_permission('orders.view')) then perform public.fn_err('permission_denied'); end if;
  perform public.fn_check_idempotency_key(p_idempotency_key);
  if p_voucher_id is null then perform public.fn_err('invalid_input', 'voucher_id'); end if;
  if p_payment_method_id is null then perform public.fn_err('invalid_input', 'payment_method_id'); end if;
  if p_installment_no is not null and p_installment_no not between 1 and 60 then perform public.fn_err('invalid_installment_no'); end if;
  if v_ref is not null and (char_length(v_ref) > 120 or v_ref ~ '[[:cntrl:]]') then perform public.fn_err('invalid_input', 'reference'); end if;
  if p_tendered is not null and (p_tendered <= 0 or p_tendered > 9999999999.99 or p_tendered <> round(p_tendered, 2)) then
    perform public.fn_err('invalid_input', 'tendered');
  end if;

  v_hash := encode(extensions.digest(convert_to(format('%s|%s|%s|%s|%s|%s', (select auth.uid()), p_voucher_id, p_payment_method_id, coalesce(v_ref, ''),
                     coalesce(p_installment_no::text, ''), coalesce(p_tendered::text, '')), 'UTF8'), 'sha256'), 'hex');
  v_replay := public.fn_idempotency_begin(p_idempotency_key, 'installment.confirm', v_hash);
  if v_replay is not null then
    if v_replay -> 'result' is null or jsonb_typeof(v_replay -> 'result') = 'null' then perform public.fn_err('invalid_state', 'idempotency_pending'); end if;
    return (v_replay -> 'result') || jsonb_build_object('replayed', true);
  end if;

  select d.id into v_day from public.day_sessions d where d.restaurant_id = v_rid and d.status = 'open' for share;
  if v_day is null then perform public.fn_err('day_closed', 'no open business day'); end if;

  select * into v_v from public.vouchers v where v.id = p_voucher_id and v.restaurant_id = v_rid for update;
  if not found then perform public.fn_err('not_found'); end if;
  select * into v_i from public.installments x where x.voucher_id = v_v.id and x.restaurant_id = v_rid and not x.paid
  order by x.no limit 1 for update;
  if not found then perform public.fn_err('voucher_already_settled'); end if;
  if p_installment_no is not null and p_installment_no <> v_i.no then perform public.fn_err('invalid_installment_no', v_i.no::text); end if;

  select * into v_m from public.payment_methods m where m.id = p_payment_method_id and m.restaurant_id = v_rid for share;
  if not found or not v_m.is_active then perform public.fn_err('invalid_input', 'payment_method_id'); end if;
  if v_m.requires_reference and v_ref is null then perform public.fn_err('invalid_input', 'reference'); end if;
  if p_tendered is not null then
    if not v_m.affects_cash_drawer then perform public.fn_err('invalid_input', 'tendered'); end if;
    if p_tendered < v_i.amount then perform public.fn_err('insufficient_tendered'); end if;
  end if;

  insert into public.payments (restaurant_id, day_session_id, order_id, voucher_id, installment_no, kind, amount, payment_method_id,
                               method_name_snapshot, method_affects_drawer_snapshot, reference, receipt_no, created_by)
  values (v_rid, v_day, v_v.order_id, v_v.id, v_i.no, 'installment_payment', v_i.amount, v_m.id, v_m.name, v_m.affects_cash_drawer, v_ref,
          public.fn_next_number(v_rid, 'receipt', 'RCT-'), (select auth.uid()))
  returning id into v_pay;
  update public.installments set paid = true, paid_at = now(), payment_id = v_pay where id = v_i.id and restaurant_id = v_rid;

  perform public.fn_write_audit('installment.collected', jsonb_build_object('voucher_id', v_v.id, 'voucher_no', v_v.voucher_no,
                                'installment_no', v_i.no, 'amount', v_i.amount, 'payment_id', v_pay, 'payment_method_id', v_m.id));
  v_res := public.fn_receipt_json(v_pay, v_rid)
           || jsonb_build_object('tendered', p_tendered, 'change', case when p_tendered is null then null else p_tendered - v_i.amount end,
                                 'voucher_status', public.fn_voucher_json(v_v.id) ->> 'status');
  perform public.fn_idempotency_complete(p_idempotency_key, 'installment.confirm', v_res);
  return v_res || jsonb_build_object('replayed', false);
end;
$$;

-- ── read a voucher ──────────────────────────────────────────────────────────
create or replace function public.fn_get_voucher(p_voucher_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_rid uuid := public.fn_tenant_status_guard(false);
begin
  if not public.has_permission('vouchers.view') then perform public.fn_err('permission_denied'); end if;
  if p_voucher_id is null or not exists (select 1 from public.vouchers v where v.id = p_voucher_id and v.restaurant_id = v_rid) then
    perform public.fn_err('not_found');
  end if;
  return public.fn_voucher_json(p_voucher_id);
end;
$$;

-- ── list vouchers with computed status (vouchers.view) ──────────────────────
create or replace function public.fn_list_vouchers(p_status text default null, p_limit integer default 200)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_rid uuid := public.fn_tenant_status_guard(false);
begin
  if not public.has_permission('vouchers.view') then perform public.fn_err('permission_denied'); end if;
  if p_status is not null and p_status not in ('active', 'overdue', 'settled') then perform public.fn_err('invalid_input', 'status'); end if;
  if p_limit is null or p_limit not between 1 and 500 then perform public.fn_err('invalid_input', 'limit'); end if;
  return coalesce((
    select jsonb_agg(t.j order by t.created_at desc)
    from (select s.j, s.created_at
          from (select public.fn_voucher_json(v.id) - 'installments' j, v.created_at
                from public.vouchers v where v.restaurant_id = v_rid order by v.created_at desc limit 2000) s
          where p_status is null or s.j ->> 'status' = p_status
          order by s.created_at desc limit p_limit) t), '[]'::jsonb);
end;
$$;

revoke all on function public.fn_generate_voucher(uuid, text, text, numeric, uuid, text, integer, integer, text),
  public.fn_confirm_installment(uuid, uuid, text, text, integer, numeric), public.fn_get_voucher(uuid),
  public.fn_list_vouchers(text, integer) from public, anon;
grant execute on function public.fn_generate_voucher(uuid, text, text, numeric, uuid, text, integer, integer, text),
  public.fn_confirm_installment(uuid, uuid, text, text, integer, numeric), public.fn_get_voucher(uuid),
  public.fn_list_vouchers(text, integer) to authenticated;
