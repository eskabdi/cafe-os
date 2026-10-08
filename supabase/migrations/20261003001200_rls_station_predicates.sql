-- 0012  H1: station-scoped RLS predicates resolved ONCE per statement (set-based), not once per row.
--
-- Before: orders / order_items / ingredients / stock_movements policies called has_station_access(station_id)
-- and order_has_station_access(id) per row; each call re-joined profiles/roles/stations (measured: a kitchen user
-- counting 20k orders took 15 s).
-- Now:
--   * public.current_station_ids() returns the caller's station ids as ONE uuid[] (tenant_admin: every station of
--     the tenant; everyone else: role_station_access). Policies use  station_id = any((select current_station_ids())),
--     which Postgres evaluates as an InitPlan, i.e. once per statement.
--   * orders.station_ids (uuid[]) is a trigger-maintained denormalisation of the stations of the order's items so
--     "may this user see this order through a station" is an array-overlap test on the row itself
--     (station_ids && (select current_station_ids())) instead of a correlated lookup into order_items.
--     It is internal: not part of the client SELECT grant.
-- has_station_access(uuid) stays for RPC code (one-off checks); order_has_station_access(uuid) is dropped (unused).

create or replace function public.current_station_ids()
returns uuid[]
language sql stable security definer set search_path = ''
as $$
  select coalesce((
    select case
      when ro.system_key = 'tenant_admin' then
        (select array_agg(s.id) from public.stations s where s.restaurant_id = p.restaurant_id)
      else
        (select array_agg(rsa.station_id) from public.role_station_access rsa
         where rsa.role_id = ro.id and rsa.restaurant_id = ro.restaurant_id)
      end
    from public.profiles p
    join public.restaurants r on r.id = p.restaurant_id
    join public.roles ro on ro.id = p.role_id and ro.restaurant_id = p.restaurant_id
    where p.id = (select auth.uid())
      and p.is_active
      and ro.is_active
      and r.status not in ('suspended', 'cancelled')
  ), '{}'::uuid[])
$$;
revoke all on function public.current_station_ids() from public, anon;
grant execute on function public.current_station_ids() to authenticated;

-- ── orders.station_ids ──────────────────────────────────────────────────────
alter table public.orders add column station_ids uuid[] not null default '{}'::uuid[];

create or replace function public.fn_sync_order_stations()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_order uuid;
begin
  for v_order in
    select distinct x from unnest(array[
      case when tg_op in ('UPDATE', 'DELETE') then old.order_id end,
      case when tg_op in ('UPDATE', 'INSERT') then new.order_id end]) x
    where x is not null
  loop
    update public.orders o
       set station_ids = coalesce((select array_agg(distinct oi.station_id order by oi.station_id)
                                   from public.order_items oi where oi.restaurant_id = o.restaurant_id and oi.order_id = o.id), '{}'::uuid[])
     where o.id = v_order
       and o.station_ids is distinct from coalesce((select array_agg(distinct oi.station_id order by oi.station_id)
                                                    from public.order_items oi where oi.restaurant_id = o.restaurant_id and oi.order_id = o.id), '{}'::uuid[]);
  end loop;
  return null;
end;
$$;
revoke all on function public.fn_sync_order_stations() from public, anon, authenticated;
create trigger trg_sync_order_stations after insert or delete or update of station_id, order_id on public.order_items
  for each row execute function public.fn_sync_order_stations();

-- is_order_owner ran two extra definer lookups (current_restaurant_id/current_user_id) per ITEM row. The policy that
-- calls it already pins the tenant (restaurant_id = current_restaurant_id()), and orders.created_by is a
-- tenant-composite FK, so ownership reduces to created_by = auth.uid().
create or replace function public.is_order_owner(p_order_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.orders o
    where o.id = p_order_id and o.created_by = (select auth.uid())
  )
$$;

-- ── policies ────────────────────────────────────────────────────────────────
alter policy orders_select on public.orders
  using (restaurant_id = (select public.current_restaurant_id())
         and (select public.has_permission('orders.view'))
         and ((select public.has_permission('orders.view_all'))
              or created_by = (select public.current_user_id())
              or station_ids && (select public.current_station_ids())));

alter policy order_items_select on public.order_items
  using (restaurant_id = (select public.current_restaurant_id())
         and (select public.has_permission('orders.view'))
         and ((select public.has_permission('orders.view_all'))
              or station_id = any (((select public.current_station_ids()))::uuid[])
              or public.is_order_owner(order_id)));

alter policy ingredients_select on public.ingredients
  using (restaurant_id = (select public.current_restaurant_id())
         and (((select public.has_permission('inventory.view'))
               and (station_id = any (((select public.current_station_ids()))::uuid[])
                    or (select public.has_permission('inventory.adjust'))
                    or (select public.has_permission('inventory.receive'))))
              or (select public.has_permission('menu.manage'))));

alter policy stock_movements_select on public.stock_movements
  using (restaurant_id = (select public.current_restaurant_id())
         and (select public.has_permission('inventory.view'))
         and (station_id = any (((select public.current_station_ids()))::uuid[])
              or (select public.has_permission('inventory.adjust'))
              or (select public.has_permission('inventory.receive'))));

drop function public.order_has_station_access(uuid);

-- order_items.station_id must be the menu item's station at insert (L7: station snapshot cannot be forged);
-- the station name snapshot comes from the stations row.
create or replace function public.fn_order_item_station_check()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_station uuid;
begin
  select m.station_id into v_station from public.menu_items m
  where m.id = new.menu_item_id and m.restaurant_id = new.restaurant_id;
  if v_station is null or v_station is distinct from new.station_id then
    perform public.fn_err('station_mismatch', 'order_items.station_id must equal menu_items.station_id');
  end if;
  return new;
end;
$$;
revoke all on function public.fn_order_item_station_check() from public, anon, authenticated;
create trigger trg_order_item_station_check before insert on public.order_items
  for each row execute function public.fn_order_item_station_check();
