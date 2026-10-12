-- 0041 Orders scoped to the signed-in user (docs/note.md task 1).
--
-- Rule (decided by PERMISSION, never by role or station name):
--   * READ   orders_select / order_items_select / fn_order_visible (unchanged, 0012 + 0033):
--              an order is readable with orders.view AND (orders.view_all OR created_by = me OR one of its lines is routed to
--              one of my stations); an order line with orders.view AND (orders.view_all OR its station is mine OR the order is mine).
--            A station therefore sees the order HEADER (number, table, type) and ONLY its own routed lines, never the other
--            stations' lines. A user without orders.view_all ("waiter-like") sees only their own orders. The cashier keeps the
--            full view through orders.view_all (seeded on the default Cashier role): a payment needs the order to be visible.
--   * CANCEL fn_cancel_order (redefined below): orders.cancel AND the order is visible AND (created_by = me OR orders.cancel_any).
--            A visible order of someone else without orders.cancel_any -> permission_denied (no oracle: the caller can already
--            read it); an invisible / foreign / unknown order -> not_found exactly as before.
--   * Reports, dashboard, day close and receipts are security-definer RPCs with their own permission checks: unaffected.
--
-- Backfill: tenant_admin gets orders.cancel_any from trg_grant_new_permission (every existing tenant) and fn_seed_tenant_defaults
-- (new tenants: the whole catalogue). Every other existing role holding orders.cancel AND orders.view_all could cancel ANY order
-- before this migration, so it keeps that right through orders.cancel_any. Roles holding orders.cancel without orders.view_all
-- (waiter-like) are restricted to their own orders. orders.view_all is not re-granted: it already existed, so every role with a
-- full view today keeps it, and a role deliberately created without it (e.g. payments.create only) is not widened.
--
-- Index: orders_created_by_idx (restaurant_id, created_by, created_at desc) from 0005 already serves `created_by = me`; the
-- station predicates keep their 0012 indexes. Realtime: orders and order_items are in the supabase_realtime publication and
-- Realtime applies the SAME select policies, so a waiter's channel receives only own orders and a station's only its own lines.

insert into public.permissions (key, module, description, sort_order) values
  ('orders.cancel_any', 'orders', 'Cancel any order of the restaurant, not only own ones (still needs orders.cancel)', 24)
on conflict (key) do nothing;

update public.permissions
   set description = 'Cancel own orders that are still untouched and unpaid (any order with orders.cancel_any)'
 where key = 'orders.cancel';
update public.permissions
   set description = 'View own orders and the lines routed to own stations (every order with orders.view_all)'
 where key = 'orders.view';

-- backfill: roles that could cancel every order keep that right (tenant_admin already got it from trg_grant_new_permission)
insert into public.role_permissions (role_id, permission_id, restaurant_id)
select rp_c.role_id, (select id from public.permissions where key = 'orders.cancel_any'), rp_c.restaurant_id
from public.role_permissions rp_c
join public.permissions pc on pc.id = rp_c.permission_id and pc.key = 'orders.cancel'
where exists (select 1 from public.role_permissions rp_v join public.permissions pv on pv.id = rp_v.permission_id
              where pv.key = 'orders.view_all' and rp_v.role_id = rp_c.role_id and rp_v.restaurant_id = rp_c.restaurant_id)
on conflict do nothing;

-- ── fn_cancel_order (same as 0034 plus the own-order rule) ───────────────────────────────────────────────────────────────────
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
  -- own orders only, unless orders.cancel_any (the caller can already read this order, so permission_denied leaks nothing)
  if v_o.created_by is distinct from (select auth.uid()) and not public.has_permission('orders.cancel_any') then
    perform public.fn_err('permission_denied');
  end if;
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

revoke all on function public.fn_cancel_order(uuid, text) from public, anon;
grant execute on function public.fn_cancel_order(uuid, text) to authenticated;
