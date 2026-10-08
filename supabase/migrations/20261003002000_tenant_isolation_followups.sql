-- 0020  Tenant-isolation review follow-ups (M1, L3, L4)
--
--  M1  menu_items, recipe_lines and tables had table-level INSERT/UPDATE grants, so a client could write `id`
--      (and created_at/updated_at): inserting or updating a row with a FOREIGN id answers 23505 (taken) vs success,
--      a cross-tenant existence oracle. They now use column grants without id, created_at, updated_at and the generated
--      normalized_* columns (like every other client-writable table).
--  L3  fn_resolve_tenant_slug (anon) no longer returns the tenant id: the login page only needs name + branding; the
--      pin-login Edge Function (service role) resolves the id itself.
--  L4  profiles.username is no longer client-updatable (renames will go through an RPC); first/middle/last name and
--      is_active remain.

-- ── M1 ──────────────────────────────────────────────────────────────────────
revoke insert, update on public.menu_items, public.recipe_lines, public.tables from authenticated;

grant insert (restaurant_id, name, description, category_id, station_id, price, emoji, image_path, sort_order, is_active),
      update (name, description, category_id, station_id, price, emoji, image_path, sort_order, is_active)
  on public.menu_items to authenticated;
grant insert (restaurant_id, menu_item_id, ingredient_id, qty_per_serving),
      update (qty_per_serving)
  on public.recipe_lines to authenticated;
grant insert (restaurant_id, table_area_id, label, capacity, status, qr_enabled, sort_order, is_active),
      update (table_area_id, label, capacity, status, qr_enabled, sort_order, is_active)
  on public.tables to authenticated;

-- ── L4 ──────────────────────────────────────────────────────────────────────
revoke update (username) on public.profiles from authenticated;

-- ── L3 ──────────────────────────────────────────────────────────────────────
create or replace function public.fn_resolve_tenant_slug(p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
           'name', r.name,
           'branding', jsonb_build_object(
             'logo_path', r.branding -> 'logo_path',
             'primary_color', r.branding -> 'primary_color',
             'accent_color', r.branding -> 'accent_color'))
  from public.restaurants r
  where r.slug = lower(btrim(coalesce(p_slug, '')))
    and r.status not in ('suspended', 'cancelled')
$$;
