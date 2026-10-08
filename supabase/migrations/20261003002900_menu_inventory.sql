-- 0029  Phase 3 (Menu and Inventory), database layer
--
--  What this adds (no new table: menu_items / recipe_lines / ingredients / stock_movements exist since 0005):
--   * Storage: private bucket `menu-images` (2 MiB, png/jpeg/webp) + storage.objects policies, tenant-scoped paths
--     `restaurants/<own tenant id>/menu/<file>` derived from the caller's identity, never from the client. Path regexes are
--     case-SENSITIVE (only the extension is case-insensitive); an image a menu item points at can be neither renamed nor deleted.
--   * Menu RPCs      fn_create_menu_item / fn_update_menu_item / fn_set_menu_item_active / fn_set_recipe        (menu.manage)
--   * Ingredient RPCs fn_create_ingredient / fn_update_ingredient / fn_set_ingredient_active                    (inventory.adjust)
--   * Stock RPCs     fn_receive_stock (inventory.receive), fn_adjust_stock / fn_reverse_stock_movement (inventory.adjust),
--                    fn_list_stock_movements (inventory.view + the same station rule as the stock_movements policy; keyset (created_at, id))
--   * Setting        restaurants.stock_stepup_threshold (ETB, default 5000, 100..1000000) + fn_set_stock_stepup_threshold
--                    (settings.manage + aal2, audited old/new)
--   * Internal       fn_post_stock_movement (the ONE writer of the ledger + on-hand), fn_apply_recipe_consumption /
--                    fn_reverse_order_consumption (called by fn_submit_order / fn_cancel_order in Phase 4; no client EXECUTE)
--
--  WRITE PATH: the RPCs are the ONLY write path for menu_items, recipe_lines and ingredients. This migration REVOKES the client
--  INSERT / UPDATE / DELETE privileges of 0009 / 0020 on those three tables (SELECT + the RLS policies stay; the write policies of
--  0007 remain as a second ceiling but no client privilege reaches them). Reason: direct DML skipped the plan cap, the uploaded-image
--  check, the unit lock, the active-recipe rule and the step-up on cost edits.
--
--  Stock model: `stock_movements` is the append-only ledger (immutable triggers since 0006, closed-day guard since 0013).
--  `ingredients.stock` is a transactionally maintained running total: it only ever changes inside fn_post_stock_movement, in the same
--  statement block as the ledger insert, under the ingredient row lock, so  stock = sum(qty_delta)  holds (asserted in 30_*). Clients
--  have no write privilege on ingredients at all. Corrections are compensating rows (reason 'reversal', reverses_movement_id), never edits.
--  Every ledger write needs the open business day (else day_closed), never drives on-hand below zero (insufficient_stock) and never
--  above 999999999.999 (stock / received_today / consumed_today; invalid_input 'qty').
--
--  Step-up (fn_stock_step_up): a stock movement (receive, adjust, reversal, initial stock of fn_create_ingredient) calls
--  fn_require_step_up() when  |qty| * cost_per_unit >= threshold, or cost_per_unit = 0 and |qty| >= threshold  (threshold =
--  fn_stock_stepup_threshold(tenant)). Changing cost_per_unit of an ingredient that has any movement always calls fn_require_step_up()
--  (otherwise zeroing the cost would evade the value rule).
--
--  Deferred to Phase 9 (day close): resetting / deriving received_today / consumed_today in fn_open_day / fn_close_day, and excluding
--  the stock columns from the ingredients row-audit trigger (today every ledger write also writes a row-audit entry).

-- ── Storage: bucket + policies ──────────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('menu-images', 'menu-images', false, 2097152, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update
  set public = false, file_size_limit = 2097152, allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp'];

-- tenant prefix comes from the caller's profile; only <prefix>/menu/<safe file name>.(png|jpg|jpeg|webp).
-- All path matching is CASE-SENSITIVE (`~`): the prefix is exactly `restaurants/<lowercase uuid>/menu/`, so a case variant
-- (RESTAURANTS/...) can never be created; only the extension accepts any case.
create policy menu_images_select on storage.objects for select to authenticated
  using (bucket_id = 'menu-images'
         and name ~ ('^restaurants/' || (select public.current_restaurant_id())::text || '/menu/[A-Za-z0-9._-]{1,120}$')
         and ((select public.has_permission('menu.view')) or (select public.has_permission('menu.manage'))
              or (select public.has_permission('orders.create'))));
create policy menu_images_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'menu-images'
              and name ~ ('^restaurants/' || (select public.current_restaurant_id())::text
                          || '/menu/[A-Za-z0-9._-]{1,115}\.([pP][nN][gG]|[jJ][pP][eE]?[gG]|[wW][eE][bB][pP])$')
              and name !~ '\.\.'
              and (select public.has_permission('menu.manage'))
              and (select public.current_tenant_writable()));
-- an image a menu item still points at can be neither renamed (UPDATE) nor removed (DELETE): no dangling image_path
create policy menu_images_update on storage.objects for update to authenticated
  using (bucket_id = 'menu-images'
         and name ~ ('^restaurants/' || (select public.current_restaurant_id())::text || '/menu/[A-Za-z0-9._-]{1,120}$')
         and (select public.has_permission('menu.manage')) and (select public.current_tenant_writable())
         and not exists (select 1 from public.menu_items m where m.image_path = storage.objects.name))
  with check (bucket_id = 'menu-images'
              and name ~ ('^restaurants/' || (select public.current_restaurant_id())::text
                          || '/menu/[A-Za-z0-9._-]{1,115}\.([pP][nN][gG]|[jJ][pP][eE]?[gG]|[wW][eE][bB][pP])$')
              and name !~ '\.\.'
              and (select public.has_permission('menu.manage')) and (select public.current_tenant_writable()));
create policy menu_images_delete on storage.objects for delete to authenticated
  using (bucket_id = 'menu-images'
         and name ~ ('^restaurants/' || (select public.current_restaurant_id())::text || '/menu/[A-Za-z0-9._-]{1,120}$')
         and (select public.has_permission('menu.manage')) and (select public.current_tenant_writable())
         and not exists (select 1 from public.menu_items m where m.image_path = storage.objects.name));

-- ── tenant setting: stock step-up threshold ────────────────────────────────
-- A column on restaurants (the tenant root, 1:1) that is NOT in the settings.manage UPDATE column grant: it only changes through
-- fn_set_stock_stepup_threshold (aal2 + audit). Clients may read it (UI hint "this movement will ask for your authenticator").
alter table public.restaurants
  add column stock_stepup_threshold numeric(12,2) not null default 5000
  constraint restaurants_stock_stepup_threshold_check check (stock_stepup_threshold between 100 and 1000000);
grant select (stock_stepup_threshold) on public.restaurants to authenticated;

-- ── internal helpers ────────────────────────────────────────────────────────
-- Business-day for a ledger write (the closed-day trigger of 0013 needs a day id on INSERT).
create or replace function public.fn_stock_day(p_rid uuid)
returns uuid
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_day uuid;
begin
  select d.id into v_day from public.day_sessions d where d.restaurant_id = p_rid and d.status = 'open';
  if v_day is null then perform public.fn_err('day_closed', 'no open business day'); end if;
  return v_day;
end;
$$;

-- Category / station references must be ACTIVE rows of the caller's tenant (unknown and foreign look identical).
create or replace function public.fn_menu_check_refs(p_rid uuid, p_category_id uuid, p_station_id uuid)
returns void
language plpgsql stable security definer set search_path = ''
as $$
begin
  if p_category_id is null
     or not exists (select 1 from public.categories c where c.id = p_category_id and c.restaurant_id = p_rid and c.is_active) then
    perform public.fn_err('invalid_input', 'category_id');
  end if;
  if p_station_id is null
     or not exists (select 1 from public.stations s where s.id = p_station_id and s.restaurant_id = p_rid and s.is_active) then
    perform public.fn_err('invalid_station');
  end if;
end;
$$;

-- Image path: only the caller tenant's menu prefix, a safe file name, an allowed extension, and an object that was really uploaded.
create or replace function public.fn_menu_check_image(p_rid uuid, p_path text)
returns void
language plpgsql stable security definer set search_path = ''
as $$
begin
  if p_path is null then return; end if;
  -- case-sensitive like the Storage policies (only the extension may vary in case)
  if p_path !~ ('^restaurants/' || p_rid::text || '/menu/[A-Za-z0-9._-]{1,115}\.([pP][nN][gG]|[jJ][pP][eE]?[gG]|[wW][eE][bB][pP])$')
     or p_path ~ '\.\.'
     or not exists (select 1 from storage.objects o where o.bucket_id = 'menu-images' and o.name = p_path) then
    perform public.fn_err('invalid_input', 'image_path');
  end if;
end;
$$;

-- Idempotency key shape (same rule as fn_idempotency_begin), checked BEFORE any row lookup or lock so a malformed retry costs nothing.
create or replace function public.fn_check_idempotency_key(p_key text)
returns void
language plpgsql immutable security definer set search_path = ''
as $$
begin
  if p_key is null or char_length(p_key) not between 8 and 128 then perform public.fn_err('invalid_input', 'idempotency_key'); end if;
end;
$$;

-- The tenant's stock step-up threshold in ETB (falls back to the column default).
create or replace function public.fn_stock_stepup_threshold(p_rid uuid)
returns numeric
language sql stable security definer set search_path = ''
as $$
  select coalesce((select r.stock_stepup_threshold from public.restaurants r where r.id = p_rid), 5000::numeric)
$$;

-- Step-up rule for one stock movement: value |qty| * cost >= threshold, or (no cost recorded) |qty| >= threshold.
create or replace function public.fn_stock_step_up(p_rid uuid, p_qty numeric, p_cost numeric)
returns void
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_t numeric := public.fn_stock_stepup_threshold(p_rid);
begin
  if abs(coalesce(p_qty, 0)) * coalesce(p_cost, 0) >= v_t
     or (coalesce(p_cost, 0) = 0 and abs(coalesce(p_qty, 0)) >= v_t) then
    perform public.fn_require_step_up();
  end if;
end;
$$;

-- The ONE writer of the stock ledger and of ingredients.stock. Caller has already authorised and derived p_rid.
create or replace function public.fn_post_stock_movement(
  p_rid uuid, p_ingredient_id uuid, p_delta numeric, p_reason text, p_note text,
  p_order_id uuid default null, p_reverses uuid default null)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  c_max constant numeric := 999999999.999;   -- numeric(12,3)
  v_ing public.ingredients%rowtype;
  v_day uuid;
  v_mid uuid;
  v_orig_reason text;
  v_stock numeric;
  v_recv numeric;
  v_cons numeric;
begin
  if p_delta is null or p_delta = 0 or p_delta <> round(p_delta, 3) or abs(p_delta) > c_max then
    perform public.fn_err('invalid_input', 'qty');
  end if;
  select * into v_ing from public.ingredients i where i.id = p_ingredient_id and i.restaurant_id = p_rid for update;
  if not found then perform public.fn_err('not_found'); end if;
  v_day := public.fn_stock_day(p_rid);
  if v_ing.stock + p_delta < 0 then perform public.fn_err('insufficient_stock', v_ing.name); end if;
  if p_reverses is not null then
    select m.reason into v_orig_reason from public.stock_movements m where m.id = p_reverses and m.restaurant_id = p_rid;
  end if;
  -- resulting on-hand and counters, checked BEFORE any write (no numeric overflow error from the UPDATE)
  v_stock := v_ing.stock + p_delta;
  v_recv := case when p_reason = 'received' then v_ing.received_today + p_delta
                 when p_reason = 'reversal' and v_orig_reason = 'received' then greatest(v_ing.received_today + p_delta, 0)
                 else v_ing.received_today end;
  v_cons := case when p_reason = 'consumed' then v_ing.consumed_today - p_delta
                 when p_reason = 'reversal' and v_orig_reason = 'consumed' then greatest(v_ing.consumed_today - p_delta, 0)
                 else v_ing.consumed_today end;
  if v_stock > c_max or v_recv > c_max or v_cons > c_max then perform public.fn_err('invalid_input', 'qty'); end if;
  insert into public.stock_movements (restaurant_id, ingredient_id, station_id, qty_delta, reason, note, order_id, reverses_movement_id,
                                      day_session_id, created_by)
  values (p_rid, v_ing.id, v_ing.station_id, p_delta, p_reason, p_note, p_order_id, p_reverses, v_day,
          -- actor = the signed-in member of THIS tenant; null for a QR / table-session (no profile) caller
          (select p.id from public.profiles p where p.id = (select public.current_user_id()) and p.restaurant_id = p_rid))
  returning id into v_mid;
  update public.ingredients i set stock = v_stock, received_today = v_recv, consumed_today = v_cons
  where i.id = v_ing.id and i.restaurant_id = p_rid
  returning i.stock into v_stock;
  return jsonb_build_object('movement_id', v_mid, 'ingredient_id', v_ing.id, 'qty_delta', p_delta, 'reason', p_reason, 'stock', v_stock);
end;
$$;

-- Phase-4 hooks (internal, no client EXECUTE). The tenant is derived from the ORDER ROW (orders.restaurant_id), never from the
-- caller's profile: QR / table-session orders have no profile behind them. The Phase-4 caller (fn_submit_order / fn_cancel_order /
-- the QR pipeline) owns authorisation, tenant status and the order row lock; these only move stock for that order's own tenant.
-- Consume one menu item's recipe for an order (negative rows, ingredient-id order = no deadlock between orders).
create or replace function public.fn_apply_recipe_consumption(p_order_id uuid, p_menu_item_id uuid, p_qty integer)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_rid uuid;
  r record;
  v_n integer := 0;
begin
  if p_qty is null or p_qty < 1 or p_qty > 999 then perform public.fn_err('invalid_input', 'qty'); end if;
  select o.restaurant_id into v_rid from public.orders o where o.id = p_order_id;
  if v_rid is null
     or not exists (select 1 from public.menu_items m where m.id = p_menu_item_id and m.restaurant_id = v_rid) then
    perform public.fn_err('not_found');
  end if;
  for r in select rl.ingredient_id, rl.qty_per_serving from public.recipe_lines rl
           where rl.menu_item_id = p_menu_item_id and rl.restaurant_id = v_rid order by rl.ingredient_id loop
    perform public.fn_post_stock_movement(v_rid, r.ingredient_id, -(r.qty_per_serving * p_qty), 'consumed', null, p_order_id, null);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- Compensating reversal of every not-yet-reversed consumption row of an order (order cancellation). An order whose business day is
-- CLOSED raises day_closed (the closed day's stock figures are final; Phase 4 fn_cancel_order must handle it, e.g. refuse the
-- cancellation or post an explicit correction in the open day). Without any open day the ledger write raises day_closed as well.
create or replace function public.fn_reverse_order_consumption(p_order_id uuid)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_rid uuid;
  v_day_status text;
  r record;
  v_n integer := 0;
begin
  select o.restaurant_id, d.status into v_rid, v_day_status
  from public.orders o join public.day_sessions d on d.id = o.day_session_id and d.restaurant_id = o.restaurant_id
  where o.id = p_order_id;
  if v_rid is null then perform public.fn_err('not_found'); end if;
  if v_day_status is distinct from 'open' then perform public.fn_err('day_closed', 'order business day is closed'); end if;
  for r in select m.id, m.ingredient_id, m.qty_delta from public.stock_movements m
           where m.order_id = p_order_id and m.restaurant_id = v_rid and m.reason = 'consumed'
             and not exists (select 1 from public.stock_movements x where x.reverses_movement_id = m.id)
           order by m.ingredient_id, m.id loop
    perform public.fn_post_stock_movement(v_rid, r.ingredient_id, -r.qty_delta, 'reversal', 'order consumption reversed', p_order_id, r.id);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

create or replace function public.fn_menu_item_json(p_id uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('id', m.id, 'name', m.name, 'description', m.description, 'category_id', m.category_id,
                            'station_id', m.station_id, 'price', m.price, 'emoji', m.emoji, 'image_path', m.image_path,
                            'sort_order', m.sort_order, 'is_active', m.is_active)
  from public.menu_items m where m.id = p_id
$$;

create or replace function public.fn_ingredient_json(p_id uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('id', i.id, 'name', i.name, 'station_id', i.station_id, 'unit', i.unit, 'stock', i.stock,
                            'min_level', i.min_level, 'cost_per_unit', i.cost_per_unit, 'is_active', i.is_active)
  from public.ingredients i where i.id = p_id
$$;

-- ── menu items ──────────────────────────────────────────────────────────────
create or replace function public.fn_create_menu_item(
  p_name text, p_category_id uuid, p_station_id uuid, p_price numeric,
  p_description text default null, p_emoji text default null, p_image_path text default null, p_sort_order integer default 0)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_con text;
  v_rid uuid := public.fn_tenant_status_guard(true);
  v_name text := btrim(coalesce(p_name, ''));
  v_max integer;
  v_id uuid;
begin
  if not public.has_permission('menu.manage') then perform public.fn_err('permission_denied'); end if;
  if char_length(v_name) not between 1 and 120 then perform public.fn_err('invalid_input', 'name'); end if;
  if p_price is null or p_price < 0 or p_price > 9999999999.99 or p_price <> round(p_price, 2) then perform public.fn_err('invalid_input', 'price'); end if;
  if p_description is not null and char_length(p_description) > 500 then perform public.fn_err('invalid_input', 'description'); end if;
  if p_emoji is not null and char_length(p_emoji) > 16 then perform public.fn_err('invalid_input', 'emoji'); end if;
  if p_sort_order is null or p_sort_order not between -1000000 and 1000000 then perform public.fn_err('invalid_input', 'sort_order'); end if;
  perform public.fn_menu_check_refs(v_rid, p_category_id, p_station_id);
  perform public.fn_menu_check_image(v_rid, p_image_path);
  -- serialise per tenant so concurrent creates cannot exceed the plan cap
  perform pg_advisory_xact_lock(hashtextextended('menu_create:' || v_rid::text, 0));
  select pl.max_menu_items into v_max
  from public.subscriptions s join public.plans pl on pl.id = s.plan_id where s.restaurant_id = v_rid;
  if v_max is not null and (select count(*) from public.menu_items m where m.restaurant_id = v_rid and m.is_active) >= v_max then
    perform public.fn_err('plan_limit_reached', 'menu_items');
  end if;
  begin
    insert into public.menu_items (restaurant_id, name, description, category_id, station_id, price, emoji, image_path, sort_order)
    values (v_rid, v_name, p_description, p_category_id, p_station_id, p_price, p_emoji, p_image_path, p_sort_order)
    returning id into v_id;
  exception when unique_violation then
    -- only the tenant name key means duplicate_name; any other unique violation is a generic structured conflict
    get stacked diagnostics v_con = constraint_name;
    if v_con = 'menu_items_tenant_name_key' then perform public.fn_err('duplicate_name', 'name'); end if;
    perform public.fn_err('invalid_state', 'unique_conflict');
  end;
  perform public.fn_write_audit('menu.item_created', jsonb_build_object('menu_item_id', v_id, 'name', v_name, 'price', p_price,
                                'category_id', p_category_id, 'station_id', p_station_id));
  return public.fn_menu_item_json(v_id);
end;
$$;

-- Patch keys: name, description, category_id, station_id, price, emoji, image_path, sort_order (null clears description/emoji/image_path only).
create or replace function public.fn_update_menu_item(p_menu_item_id uuid, p_patch jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_con text;
  v_rid uuid := public.fn_tenant_status_guard(true);
  v_old public.menu_items%rowtype;
  v_k text;
  v_name text; v_desc text; v_cat uuid; v_st uuid; v_price numeric; v_emoji text; v_img text; v_sort integer;
  v_changed text[] := '{}';
begin
  if not public.has_permission('menu.manage') then perform public.fn_err('permission_denied'); end if;
  if p_menu_item_id is null or p_patch is null or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb then
    perform public.fn_err('invalid_input', 'patch');
  end if;
  for v_k in select jsonb_object_keys(p_patch) loop
    if v_k <> all (array['name','description','category_id','station_id','price','emoji','image_path','sort_order']) then
      perform public.fn_err('invalid_input', 'patch');
    end if;
  end loop;
  select * into v_old from public.menu_items m where m.id = p_menu_item_id and m.restaurant_id = v_rid for update;
  if not found then perform public.fn_err('not_found'); end if;
  v_name := v_old.name; v_desc := v_old.description; v_cat := v_old.category_id; v_st := v_old.station_id;
  v_price := v_old.price; v_emoji := v_old.emoji; v_img := v_old.image_path; v_sort := v_old.sort_order;
  if p_patch ? 'name' then
    if jsonb_typeof(p_patch -> 'name') <> 'string' then perform public.fn_err('invalid_input', 'name'); end if;
    v_name := btrim(p_patch ->> 'name');
    if char_length(v_name) not between 1 and 120 then perform public.fn_err('invalid_input', 'name'); end if;
  end if;
  if p_patch ? 'description' then
    if jsonb_typeof(p_patch -> 'description') not in ('string', 'null') then perform public.fn_err('invalid_input', 'description'); end if;
    v_desc := p_patch ->> 'description';
    if v_desc is not null and char_length(v_desc) > 500 then perform public.fn_err('invalid_input', 'description'); end if;
  end if;
  if p_patch ? 'category_id' then
    if jsonb_typeof(p_patch -> 'category_id') <> 'string' or (p_patch ->> 'category_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      perform public.fn_err('invalid_input', 'category_id');
    end if;
    v_cat := (p_patch ->> 'category_id')::uuid;
  end if;
  if p_patch ? 'station_id' then
    if jsonb_typeof(p_patch -> 'station_id') <> 'string' or (p_patch ->> 'station_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      perform public.fn_err('invalid_station');
    end if;
    v_st := (p_patch ->> 'station_id')::uuid;
  end if;
  if p_patch ? 'price' then
    if jsonb_typeof(p_patch -> 'price') <> 'number' then perform public.fn_err('invalid_input', 'price'); end if;
    v_price := (p_patch ->> 'price')::numeric;
    if v_price < 0 or v_price > 9999999999.99 or v_price <> round(v_price, 2) then perform public.fn_err('invalid_input', 'price'); end if;
  end if;
  if p_patch ? 'emoji' then
    if jsonb_typeof(p_patch -> 'emoji') not in ('string', 'null') then perform public.fn_err('invalid_input', 'emoji'); end if;
    v_emoji := p_patch ->> 'emoji';
    if v_emoji is not null and char_length(v_emoji) > 16 then perform public.fn_err('invalid_input', 'emoji'); end if;
  end if;
  if p_patch ? 'image_path' then
    if jsonb_typeof(p_patch -> 'image_path') not in ('string', 'null') then perform public.fn_err('invalid_input', 'image_path'); end if;
    v_img := p_patch ->> 'image_path';
    if v_img is distinct from v_old.image_path then perform public.fn_menu_check_image(v_rid, v_img); end if;
  end if;
  if p_patch ? 'sort_order' then
    if jsonb_typeof(p_patch -> 'sort_order') <> 'number' or (p_patch ->> 'sort_order') !~ '^-?[0-9]{1,7}$' then perform public.fn_err('invalid_input', 'sort_order'); end if;
    v_sort := (p_patch ->> 'sort_order')::integer;
  end if;
  if v_cat is distinct from v_old.category_id or v_st is distinct from v_old.station_id then
    perform public.fn_menu_check_refs(v_rid, v_cat, v_st);
  end if;
  if v_name is distinct from v_old.name then v_changed := array_append(v_changed, 'name'::text); end if;
  if v_desc is distinct from v_old.description then v_changed := array_append(v_changed, 'description'::text); end if;
  if v_cat is distinct from v_old.category_id then v_changed := array_append(v_changed, 'category_id'::text); end if;
  if v_st is distinct from v_old.station_id then v_changed := array_append(v_changed, 'station_id'::text); end if;
  if v_price is distinct from v_old.price then v_changed := array_append(v_changed, 'price'::text); end if;
  if v_emoji is distinct from v_old.emoji then v_changed := array_append(v_changed, 'emoji'::text); end if;
  if v_img is distinct from v_old.image_path then v_changed := array_append(v_changed, 'image_path'::text); end if;
  if v_sort is distinct from v_old.sort_order then v_changed := array_append(v_changed, 'sort_order'::text); end if;
  if cardinality(v_changed) > 0 then
    begin
      update public.menu_items set name = v_name, description = v_desc, category_id = v_cat, station_id = v_st, price = v_price,
                                   emoji = v_emoji, image_path = v_img, sort_order = v_sort
      where id = v_old.id and restaurant_id = v_rid;
    exception when unique_violation then
      -- only the tenant name key means duplicate_name; any other unique violation is a generic structured conflict
      get stacked diagnostics v_con = constraint_name;
      if v_con = 'menu_items_tenant_name_key' then perform public.fn_err('duplicate_name', 'name'); end if;
      perform public.fn_err('invalid_state', 'unique_conflict');
    end;
    perform public.fn_write_audit('menu.item_updated', jsonb_build_object('menu_item_id', v_old.id, 'changed', to_jsonb(v_changed),
                                  'old_price', v_old.price, 'new_price', v_price));
  end if;
  return public.fn_menu_item_json(v_old.id);
end;
$$;

create or replace function public.fn_set_menu_item_active(p_menu_item_id uuid, p_active boolean)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_rid uuid := public.fn_tenant_status_guard(true);
  v_old boolean;
  v_max integer;
begin
  if not public.has_permission('menu.manage') then perform public.fn_err('permission_denied'); end if;
  if p_menu_item_id is null or p_active is null then perform public.fn_err('invalid_input'); end if;
  select m.is_active into v_old from public.menu_items m where m.id = p_menu_item_id and m.restaurant_id = v_rid for update;
  if not found then perform public.fn_err('not_found'); end if;
  if v_old is distinct from p_active then
    if p_active then
      perform pg_advisory_xact_lock(hashtextextended('menu_create:' || v_rid::text, 0));
      select pl.max_menu_items into v_max from public.subscriptions s join public.plans pl on pl.id = s.plan_id where s.restaurant_id = v_rid;
      if v_max is not null and (select count(*) from public.menu_items m where m.restaurant_id = v_rid and m.is_active) >= v_max then
        perform public.fn_err('plan_limit_reached', 'menu_items');
      end if;
      -- a recipe that uses a deactivated ingredient cannot go back on sale: lock the recipe's ingredients (FOR SHARE: a concurrent
      -- fn_set_ingredient_active waits, and its active-recipe check then sees this reactivation) and re-check them
      perform 1 from public.ingredients i
      where i.restaurant_id = v_rid
        and i.id in (select rl.ingredient_id from public.recipe_lines rl where rl.menu_item_id = p_menu_item_id and rl.restaurant_id = v_rid)
      order by i.id for share;
      if exists (select 1 from public.recipe_lines rl join public.ingredients i on i.id = rl.ingredient_id and i.restaurant_id = rl.restaurant_id
                 where rl.menu_item_id = p_menu_item_id and rl.restaurant_id = v_rid and not i.is_active) then
        perform public.fn_err('invalid_state', 'ingredient_inactive');
      end if;
    end if;
    update public.menu_items set is_active = p_active where id = p_menu_item_id and restaurant_id = v_rid;
    perform public.fn_write_audit('menu.item_active_changed', jsonb_build_object('menu_item_id', p_menu_item_id, 'is_active', p_active));
  end if;
  return public.fn_menu_item_json(p_menu_item_id);
end;
$$;

-- Replaces the recipe of one menu item. p_lines = [{"ingredient_id": uuid, "qty_per_serving": number > 0, <= 3 decimals}], [] clears it.
create or replace function public.fn_set_recipe(p_menu_item_id uuid, p_lines jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_rid uuid := public.fn_tenant_status_guard(true);
  v_el jsonb;
  v_ids uuid[] := '{}';
  v_qtys numeric[] := '{}';
  v_id uuid;
  v_q numeric;
  v_old jsonb;
  v_new jsonb;
begin
  if not public.has_permission('menu.manage') then perform public.fn_err('permission_denied'); end if;
  if p_menu_item_id is null or p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) > 50 then
    perform public.fn_err('invalid_input', 'lines');
  end if;
  for v_el in select * from jsonb_array_elements(p_lines) loop
    if jsonb_typeof(v_el) <> 'object' or jsonb_typeof(v_el -> 'ingredient_id') is distinct from 'string'
       or (v_el ->> 'ingredient_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or jsonb_typeof(v_el -> 'qty_per_serving') is distinct from 'number' then
      perform public.fn_err('invalid_input', 'lines');
    end if;
    v_id := (v_el ->> 'ingredient_id')::uuid;
    v_q := (v_el ->> 'qty_per_serving')::numeric;
    if v_q <= 0 or v_q > 1000000 or v_q <> round(v_q, 3) then perform public.fn_err('invalid_input', 'qty_per_serving'); end if;
    if v_id = any (v_ids) then perform public.fn_err('invalid_input', 'duplicate_ingredient'); end if;
    v_ids := v_ids || v_id;
    v_qtys := v_qtys || v_q;
  end loop;
  perform 1 from public.menu_items m where m.id = p_menu_item_id and m.restaurant_id = v_rid for update;
  if not found then perform public.fn_err('not_found'); end if;
  -- every ingredient must be an ACTIVE ingredient of this tenant (unknown and foreign are the same answer). FOR SHARE (in id order) so
  -- a concurrent fn_set_ingredient_active / fn_update_ingredient (FOR UPDATE) waits for this recipe and then sees it.
  if (select count(*) from (select 1 from public.ingredients i where i.restaurant_id = v_rid and i.is_active and i.id = any (v_ids)
                            order by i.id for share) x) <> cardinality(v_ids) then
    perform public.fn_err('invalid_input', 'ingredient_id');
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('ingredient_id', rl.ingredient_id, 'qty_per_serving', rl.qty_per_serving)
                            order by rl.ingredient_id), '[]'::jsonb)
    into v_old from public.recipe_lines rl where rl.menu_item_id = p_menu_item_id and rl.restaurant_id = v_rid;
  delete from public.recipe_lines rl
  where rl.menu_item_id = p_menu_item_id and rl.restaurant_id = v_rid and rl.ingredient_id <> all (v_ids);
  insert into public.recipe_lines (restaurant_id, menu_item_id, ingredient_id, qty_per_serving)
  select v_rid, p_menu_item_id, t.id, t.q from unnest(v_ids, v_qtys) as t(id, q)
  on conflict (menu_item_id, ingredient_id) do update set qty_per_serving = excluded.qty_per_serving
    where public.recipe_lines.qty_per_serving is distinct from excluded.qty_per_serving;
  select coalesce(jsonb_agg(jsonb_build_object('ingredient_id', rl.ingredient_id, 'qty_per_serving', rl.qty_per_serving)
                            order by rl.ingredient_id), '[]'::jsonb)
    into v_new from public.recipe_lines rl where rl.menu_item_id = p_menu_item_id and rl.restaurant_id = v_rid;
  if v_new is distinct from v_old then
    perform public.fn_write_audit('menu.recipe_set', jsonb_build_object('menu_item_id', p_menu_item_id, 'old', v_old, 'new', v_new));
  end if;
  return jsonb_build_object('menu_item_id', p_menu_item_id, 'lines', v_new);
end;
$$;

-- ── ingredients ─────────────────────────────────────────────────────────────
create or replace function public.fn_create_ingredient(
  p_name text, p_station_id uuid, p_unit text, p_min_level numeric default 0, p_cost_per_unit numeric default 0, p_initial_stock numeric default 0)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_con text;
  v_rid uuid := public.fn_tenant_status_guard(true);
  v_name text := btrim(coalesce(p_name, ''));
  v_id uuid;
begin
  if not public.has_permission('inventory.adjust') then perform public.fn_err('permission_denied'); end if;
  if char_length(v_name) not between 1 and 120 then perform public.fn_err('invalid_input', 'name'); end if;
  if p_unit is null or p_unit <> all (array['kg','g','L','ml','pcs']) then perform public.fn_err('invalid_input', 'unit'); end if;
  if p_min_level is null or p_min_level < 0 or p_min_level > 999999999 or p_min_level <> round(p_min_level, 3) then perform public.fn_err('invalid_input', 'min_level'); end if;
  if p_cost_per_unit is null or p_cost_per_unit < 0 or p_cost_per_unit > 9999999999.99 or p_cost_per_unit <> round(p_cost_per_unit, 2) then perform public.fn_err('invalid_input', 'cost_per_unit'); end if;
  if p_initial_stock is null or p_initial_stock < 0 or p_initial_stock > 999999999 or p_initial_stock <> round(p_initial_stock, 3) then perform public.fn_err('invalid_input', 'initial_stock'); end if;
  if p_station_id is null or not exists (select 1 from public.stations s where s.id = p_station_id and s.restaurant_id = v_rid and s.is_active) then
    perform public.fn_err('invalid_station');
  end if;
  if p_initial_stock > 0 then
    perform public.fn_stock_day(v_rid);                                  -- the opening row needs the open business day
    perform public.fn_stock_step_up(v_rid, p_initial_stock, p_cost_per_unit);   -- same step-up rule as any other movement
  end if;
  begin
    insert into public.ingredients (restaurant_id, name, station_id, unit, min_level, cost_per_unit)
    values (v_rid, v_name, p_station_id, p_unit, p_min_level, p_cost_per_unit) returning id into v_id;
  exception when unique_violation then
    -- only the tenant name key means duplicate_name; any other unique violation is a generic structured conflict
    get stacked diagnostics v_con = constraint_name;
    if v_con = 'ingredients_tenant_name_key' then perform public.fn_err('duplicate_name', 'name'); end if;
    perform public.fn_err('invalid_state', 'unique_conflict');
  end;
  if p_initial_stock > 0 then
    perform public.fn_post_stock_movement(v_rid, v_id, p_initial_stock, 'opening', 'Initial stock', null, null);
    update public.ingredients set opening_stock = p_initial_stock where id = v_id and restaurant_id = v_rid;
  end if;
  perform public.fn_write_audit('inventory.ingredient_created', jsonb_build_object('ingredient_id', v_id, 'name', v_name, 'unit', p_unit,
                                'station_id', p_station_id, 'initial_stock', p_initial_stock));
  return public.fn_ingredient_json(v_id);
end;
$$;

-- Patch keys: name, station_id, unit (locked once the ingredient has any movement), min_level, cost_per_unit.
create or replace function public.fn_update_ingredient(p_ingredient_id uuid, p_patch jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_con text;
  v_rid uuid := public.fn_tenant_status_guard(true);
  v_old public.ingredients%rowtype;
  v_k text;
  v_name text; v_st uuid; v_unit text; v_min numeric; v_cost numeric;
  v_changed text[] := '{}';
begin
  if not public.has_permission('inventory.adjust') then perform public.fn_err('permission_denied'); end if;
  if p_ingredient_id is null or p_patch is null or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb then
    perform public.fn_err('invalid_input', 'patch');
  end if;
  for v_k in select jsonb_object_keys(p_patch) loop
    if v_k <> all (array['name','station_id','unit','min_level','cost_per_unit']) then perform public.fn_err('invalid_input', 'patch'); end if;
  end loop;
  select * into v_old from public.ingredients i where i.id = p_ingredient_id and i.restaurant_id = v_rid for update;
  if not found then perform public.fn_err('not_found'); end if;
  v_name := v_old.name; v_st := v_old.station_id; v_unit := v_old.unit; v_min := v_old.min_level; v_cost := v_old.cost_per_unit;
  if p_patch ? 'name' then
    if jsonb_typeof(p_patch -> 'name') <> 'string' then perform public.fn_err('invalid_input', 'name'); end if;
    v_name := btrim(p_patch ->> 'name');
    if char_length(v_name) not between 1 and 120 then perform public.fn_err('invalid_input', 'name'); end if;
  end if;
  if p_patch ? 'station_id' then
    if jsonb_typeof(p_patch -> 'station_id') <> 'string' or (p_patch ->> 'station_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      perform public.fn_err('invalid_station');
    end if;
    v_st := (p_patch ->> 'station_id')::uuid;
    if v_st is distinct from v_old.station_id
       and not exists (select 1 from public.stations s where s.id = v_st and s.restaurant_id = v_rid and s.is_active) then
      perform public.fn_err('invalid_station');
    end if;
  end if;
  if p_patch ? 'unit' then
    if jsonb_typeof(p_patch -> 'unit') <> 'string' or (p_patch ->> 'unit') <> all (array['kg','g','L','ml','pcs']) then perform public.fn_err('invalid_input', 'unit'); end if;
    v_unit := p_patch ->> 'unit';
    if v_unit is distinct from v_old.unit
       and (exists (select 1 from public.stock_movements m where m.ingredient_id = v_old.id and m.restaurant_id = v_rid)
            or exists (select 1 from public.recipe_lines rl where rl.ingredient_id = v_old.id and rl.restaurant_id = v_rid)) then
      -- recipe quantities are expressed in the unit: changing it would silently rescale every recipe using the ingredient
      perform public.fn_err('invalid_state', 'unit_locked');
    end if;
  end if;
  if p_patch ? 'min_level' then
    if jsonb_typeof(p_patch -> 'min_level') <> 'number' then perform public.fn_err('invalid_input', 'min_level'); end if;
    v_min := (p_patch ->> 'min_level')::numeric;
    if v_min < 0 or v_min > 999999999 or v_min <> round(v_min, 3) then perform public.fn_err('invalid_input', 'min_level'); end if;
  end if;
  if p_patch ? 'cost_per_unit' then
    if jsonb_typeof(p_patch -> 'cost_per_unit') <> 'number' then perform public.fn_err('invalid_input', 'cost_per_unit'); end if;
    v_cost := (p_patch ->> 'cost_per_unit')::numeric;
    if v_cost < 0 or v_cost > 9999999999.99 or v_cost <> round(v_cost, 2) then perform public.fn_err('invalid_input', 'cost_per_unit'); end if;
    -- the cost drives the stock step-up value rule: changing it on an ingredient with any movement needs step-up
    if v_cost is distinct from v_old.cost_per_unit
       and exists (select 1 from public.stock_movements m where m.ingredient_id = v_old.id and m.restaurant_id = v_rid) then
      perform public.fn_require_step_up();
    end if;
  end if;
  if v_name is distinct from v_old.name then v_changed := array_append(v_changed, 'name'::text); end if;
  if v_st is distinct from v_old.station_id then v_changed := array_append(v_changed, 'station_id'::text); end if;
  if v_unit is distinct from v_old.unit then v_changed := array_append(v_changed, 'unit'::text); end if;
  if v_min is distinct from v_old.min_level then v_changed := array_append(v_changed, 'min_level'::text); end if;
  if v_cost is distinct from v_old.cost_per_unit then v_changed := array_append(v_changed, 'cost_per_unit'::text); end if;
  if cardinality(v_changed) > 0 then
    begin
      update public.ingredients set name = v_name, station_id = v_st, unit = v_unit, min_level = v_min, cost_per_unit = v_cost
      where id = v_old.id and restaurant_id = v_rid;
    exception when unique_violation then
      -- only the tenant name key means duplicate_name; any other unique violation is a generic structured conflict
      get stacked diagnostics v_con = constraint_name;
      if v_con = 'ingredients_tenant_name_key' then perform public.fn_err('duplicate_name', 'name'); end if;
      perform public.fn_err('invalid_state', 'unique_conflict');
    end;
    perform public.fn_write_audit('inventory.ingredient_updated', jsonb_build_object('ingredient_id', v_old.id, 'changed', to_jsonb(v_changed),
                                  'old_cost_per_unit', v_old.cost_per_unit, 'new_cost_per_unit', v_cost));
  end if;
  return public.fn_ingredient_json(v_old.id);
end;
$$;

create or replace function public.fn_set_ingredient_active(p_ingredient_id uuid, p_active boolean)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_rid uuid := public.fn_tenant_status_guard(true);
  v_old boolean;
begin
  if not public.has_permission('inventory.adjust') then perform public.fn_err('permission_denied'); end if;
  if p_ingredient_id is null or p_active is null then perform public.fn_err('invalid_input'); end if;
  select i.is_active into v_old from public.ingredients i where i.id = p_ingredient_id and i.restaurant_id = v_rid for update;
  if not found then perform public.fn_err('not_found'); end if;
  if v_old is distinct from p_active then
    -- the blocking dependency is explained to the UI: an ingredient used by an ACTIVE menu item's recipe stays active
    if not p_active and exists (select 1 from public.recipe_lines rl join public.menu_items m on m.id = rl.menu_item_id and m.restaurant_id = rl.restaurant_id
                                where rl.ingredient_id = p_ingredient_id and rl.restaurant_id = v_rid and m.is_active) then
      perform public.fn_err('invalid_state', 'ingredient_in_active_recipe');
    end if;
    update public.ingredients set is_active = p_active where id = p_ingredient_id and restaurant_id = v_rid;
    perform public.fn_write_audit('inventory.ingredient_active_changed', jsonb_build_object('ingredient_id', p_ingredient_id, 'is_active', p_active));
  end if;
  return public.fn_ingredient_json(p_ingredient_id);
end;
$$;

-- ── stock commands ──────────────────────────────────────────────────────────
create or replace function public.fn_receive_stock(p_ingredient_id uuid, p_qty numeric, p_idempotency_key text, p_note text default null)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_rid uuid := public.fn_tenant_status_guard(true);
  v_ing public.ingredients%rowtype;
  v_hash text;
  v_replay jsonb;
  v_res jsonb;
begin
  if not public.has_permission('inventory.receive') then perform public.fn_err('permission_denied'); end if;
  perform public.fn_check_idempotency_key(p_idempotency_key);   -- before any lookup / lock
  if p_ingredient_id is null then perform public.fn_err('invalid_input', 'ingredient_id'); end if;
  if p_qty is null or p_qty <= 0 or p_qty > 1000000 or p_qty <> round(p_qty, 3) then perform public.fn_err('invalid_input', 'qty'); end if;
  if p_note is not null and char_length(p_note) > 300 then perform public.fn_err('invalid_input', 'note'); end if;
  select * into v_ing from public.ingredients i where i.id = p_ingredient_id and i.restaurant_id = v_rid for update;
  if not found then perform public.fn_err('not_found'); end if;
  v_hash := encode(extensions.digest(convert_to(format('%s|%s|%s', p_ingredient_id, p_qty::numeric(12,3), coalesce(p_note, '')), 'UTF8'), 'sha256'), 'hex');
  v_replay := public.fn_idempotency_begin(p_idempotency_key, 'stock.receive', v_hash);
  if v_replay is not null then return v_replay -> 'result'; end if;
  if not v_ing.is_active then perform public.fn_err('invalid_state', 'ingredient_inactive'); end if;
  perform public.fn_stock_step_up(v_rid, p_qty, v_ing.cost_per_unit);
  v_res := public.fn_post_stock_movement(v_rid, p_ingredient_id, p_qty, 'received', p_note, null, null);
  perform public.fn_write_audit('inventory.stock_received', jsonb_build_object('ingredient_id', p_ingredient_id, 'qty', p_qty,
                                'movement_id', v_res ->> 'movement_id', 'stock', v_res -> 'stock'));
  perform public.fn_idempotency_complete(p_idempotency_key, 'stock.receive', v_res);
  return v_res;
end;
$$;

-- p_qty_delta is signed (non-zero); p_reason is mandatory free text (3..300 chars) and is stored on the ledger row.
create or replace function public.fn_adjust_stock(p_ingredient_id uuid, p_qty_delta numeric, p_reason text, p_idempotency_key text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_rid uuid := public.fn_tenant_status_guard(true);
  v_ing public.ingredients%rowtype;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_hash text;
  v_replay jsonb;
  v_res jsonb;
begin
  if not public.has_permission('inventory.adjust') then perform public.fn_err('permission_denied'); end if;
  perform public.fn_check_idempotency_key(p_idempotency_key);   -- before any lookup / lock
  if p_ingredient_id is null then perform public.fn_err('invalid_input', 'ingredient_id'); end if;
  if p_qty_delta is null or p_qty_delta = 0 or abs(p_qty_delta) > 1000000 or p_qty_delta <> round(p_qty_delta, 3) then perform public.fn_err('invalid_input', 'qty_delta'); end if;
  if char_length(v_reason) not between 3 and 300 then perform public.fn_err('invalid_input', 'reason'); end if;
  select * into v_ing from public.ingredients i where i.id = p_ingredient_id and i.restaurant_id = v_rid for update;
  if not found then perform public.fn_err('not_found'); end if;
  v_hash := encode(extensions.digest(convert_to(format('%s|%s|%s', p_ingredient_id, p_qty_delta::numeric(12,3), v_reason), 'UTF8'), 'sha256'), 'hex');
  v_replay := public.fn_idempotency_begin(p_idempotency_key, 'stock.adjust', v_hash);
  if v_replay is not null then return v_replay -> 'result'; end if;
  -- large adjustments (value or, without a cost, quantity >= the tenant threshold) need the same step-up as role changes
  perform public.fn_stock_step_up(v_rid, p_qty_delta, v_ing.cost_per_unit);
  v_res := public.fn_post_stock_movement(v_rid, p_ingredient_id, p_qty_delta, 'manual_adjustment', v_reason, null, null);
  perform public.fn_write_audit('inventory.stock_adjusted', jsonb_build_object('ingredient_id', p_ingredient_id, 'qty_delta', p_qty_delta,
                                'reason', v_reason, 'movement_id', v_res ->> 'movement_id', 'stock', v_res -> 'stock'));
  perform public.fn_idempotency_complete(p_idempotency_key, 'stock.adjust', v_res);
  return v_res;
end;
$$;

-- Compensating record for a received / manually adjusted / opening / correction row. Consumption rows are reversed with the order.
create or replace function public.fn_reverse_stock_movement(p_movement_id uuid, p_reason text, p_idempotency_key text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_rid uuid := public.fn_tenant_status_guard(true);
  v_mov public.stock_movements%rowtype;
  v_cost numeric;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_hash text;
  v_replay jsonb;
  v_res jsonb;
begin
  if not public.has_permission('inventory.adjust') then perform public.fn_err('permission_denied'); end if;
  perform public.fn_check_idempotency_key(p_idempotency_key);   -- before any lookup / lock
  if p_movement_id is null then perform public.fn_err('invalid_input', 'movement_id'); end if;
  if char_length(v_reason) not between 3 and 300 then perform public.fn_err('invalid_input', 'reason'); end if;
  select * into v_mov from public.stock_movements m where m.id = p_movement_id and m.restaurant_id = v_rid;
  if not found then perform public.fn_err('not_found'); end if;
  v_hash := encode(extensions.digest(convert_to(format('%s|%s', p_movement_id, v_reason), 'UTF8'), 'sha256'), 'hex');
  v_replay := public.fn_idempotency_begin(p_idempotency_key, 'stock.reverse', v_hash);
  if v_replay is not null then return v_replay -> 'result'; end if;
  -- serialise with every other movement of this ingredient before the "already reversed" test
  select i.cost_per_unit into v_cost from public.ingredients i where i.id = v_mov.ingredient_id and i.restaurant_id = v_rid for update;
  if v_mov.reason in ('reversal', 'consumed') then perform public.fn_err('invalid_state', 'not_reversible'); end if;
  if exists (select 1 from public.stock_movements x where x.reverses_movement_id = v_mov.id and x.restaurant_id = v_rid) then
    perform public.fn_err('invalid_state', 'already_reversed');
  end if;
  perform public.fn_stock_step_up(v_rid, v_mov.qty_delta, v_cost);
  v_res := public.fn_post_stock_movement(v_rid, v_mov.ingredient_id, -v_mov.qty_delta, 'reversal', v_reason, null, v_mov.id);
  perform public.fn_write_audit('inventory.stock_reversed', jsonb_build_object('reverses_movement_id', v_mov.id, 'ingredient_id', v_mov.ingredient_id,
                                'qty_delta', -v_mov.qty_delta, 'reason', v_reason, 'movement_id', v_res ->> 'movement_id'));
  perform public.fn_idempotency_complete(p_idempotency_key, 'stock.reverse', v_res);
  return v_res;
end;
$$;

-- Movement log, newest first. Keyset pagination on (created_at, id): pass the previous page's LAST row as p_before (created_at) and
-- p_before_id (id); rows strictly older in that order follow (ties on created_at are split by id, so no row is skipped or repeated).
-- p_before alone filters created_at < p_before; p_before_id without p_before is invalid_input. Same visibility rule as the
-- stock_movements policy: inventory.view AND (station access OR adjust OR receive); own tenant only.
create or replace function public.fn_list_stock_movements(p_ingredient_id uuid default null, p_limit integer default 50,
                                                          p_before timestamptz default null, p_before_id uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_rid uuid := public.fn_tenant_status_guard(false);
  v_all boolean;
begin
  if not public.has_permission('inventory.view') then perform public.fn_err('permission_denied'); end if;
  if p_limit is null or p_limit not between 1 and 200 then perform public.fn_err('invalid_input', 'limit'); end if;
  if p_before_id is not null and p_before is null then perform public.fn_err('invalid_input', 'before'); end if;
  v_all := public.has_permission('inventory.adjust') or public.has_permission('inventory.receive');
  return coalesce((
    select jsonb_agg(x.j order by x.created_at desc, x.id desc)
    from (
      select m.id, m.created_at,
             jsonb_build_object('id', m.id, 'ingredient_id', m.ingredient_id, 'ingredient_name', i.name, 'unit', i.unit,
                                'station_id', m.station_id, 'qty_delta', m.qty_delta, 'reason', m.reason, 'note', m.note,
                                'order_id', m.order_id, 'reverses_movement_id', m.reverses_movement_id,
                                'day_session_id', m.day_session_id, 'created_by', m.created_by, 'created_by_name', pr.short_name,
                                'created_at', m.created_at) as j
      from public.stock_movements m
      join public.ingredients i on i.id = m.ingredient_id and i.restaurant_id = m.restaurant_id
      left join public.profiles pr on pr.id = m.created_by and pr.restaurant_id = m.restaurant_id
      where m.restaurant_id = v_rid
        and (p_ingredient_id is null or m.ingredient_id = p_ingredient_id)
        and (p_before is null
             or (p_before_id is null and m.created_at < p_before)
             or (p_before_id is not null and (m.created_at, m.id) < (p_before, p_before_id)))
        and (v_all or public.has_station_access(m.station_id))
      order by m.created_at desc, m.id desc
      limit p_limit
    ) x), '[]'::jsonb);
end;
$$;

-- ── tenant setting: stock step-up threshold (RPC) ───────────────────────────
-- settings.manage + a real authenticator (fn_require_aal2: aal2 token, verified factor, not a PIN account; stricter than
-- fn_require_step_up, which it therefore subsumes); order tenant guard -> permission -> aal2 -> validation. Audit old/new.
create or replace function public.fn_set_stock_stepup_threshold(p_threshold numeric)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_rid uuid := public.fn_tenant_status_guard(true);
  v_old numeric;
begin
  if not public.has_permission('settings.manage') then perform public.fn_err('permission_denied'); end if;
  perform public.fn_require_aal2();
  if p_threshold is null or p_threshold not between 100 and 1000000 or p_threshold <> round(p_threshold, 2) then
    perform public.fn_err('invalid_input', 'stock_stepup_threshold');
  end if;
  select r.stock_stepup_threshold into v_old from public.restaurants r where r.id = v_rid for update;
  if v_old is distinct from p_threshold then
    update public.restaurants set stock_stepup_threshold = p_threshold where id = v_rid;
    perform public.fn_write_audit('settings.stock_stepup_threshold_updated',
                                  jsonb_build_object('old', v_old, 'new', p_threshold::numeric(12,2)), v_rid);
  end if;
  return jsonb_build_object('stock_stepup_threshold', p_threshold::numeric(12,2));
end;
$$;

-- ── privileges ──────────────────────────────────────────────────────────────
-- RPCs are the ONLY write path for menu_items / recipe_lines / ingredients (table AND column write grants of 0009 / 0020 go away;
-- revoking the table-level privilege also revokes the column-level ones). SELECT and the RLS policies stay.
revoke insert, update, delete on public.menu_items, public.recipe_lines, public.ingredients from authenticated;

revoke all on function
  public.fn_stock_day(uuid), public.fn_menu_check_refs(uuid, uuid, uuid), public.fn_menu_check_image(uuid, text),
  public.fn_check_idempotency_key(text), public.fn_stock_stepup_threshold(uuid), public.fn_stock_step_up(uuid, numeric, numeric),
  public.fn_post_stock_movement(uuid, uuid, numeric, text, text, uuid, uuid),
  public.fn_apply_recipe_consumption(uuid, uuid, integer), public.fn_reverse_order_consumption(uuid),
  public.fn_menu_item_json(uuid), public.fn_ingredient_json(uuid),
  public.fn_create_menu_item(text, uuid, uuid, numeric, text, text, text, integer),
  public.fn_update_menu_item(uuid, jsonb), public.fn_set_menu_item_active(uuid, boolean), public.fn_set_recipe(uuid, jsonb),
  public.fn_create_ingredient(text, uuid, text, numeric, numeric, numeric),
  public.fn_update_ingredient(uuid, jsonb), public.fn_set_ingredient_active(uuid, boolean),
  public.fn_receive_stock(uuid, numeric, text, text), public.fn_adjust_stock(uuid, numeric, text, text),
  public.fn_reverse_stock_movement(uuid, text, text), public.fn_list_stock_movements(uuid, integer, timestamptz, uuid),
  public.fn_set_stock_stepup_threshold(numeric)
  from public, anon, authenticated, service_role;
grant execute on function
  public.fn_create_menu_item(text, uuid, uuid, numeric, text, text, text, integer),
  public.fn_update_menu_item(uuid, jsonb), public.fn_set_menu_item_active(uuid, boolean), public.fn_set_recipe(uuid, jsonb),
  public.fn_create_ingredient(text, uuid, text, numeric, numeric, numeric),
  public.fn_update_ingredient(uuid, jsonb), public.fn_set_ingredient_active(uuid, boolean),
  public.fn_receive_stock(uuid, numeric, text, text), public.fn_adjust_stock(uuid, numeric, text, text),
  public.fn_reverse_stock_movement(uuid, text, text), public.fn_list_stock_movements(uuid, integer, timestamptz, uuid),
  public.fn_set_stock_stepup_threshold(numeric)
  to authenticated;
