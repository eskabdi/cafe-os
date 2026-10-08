import { z } from 'zod'
import { isUuid } from '@/lib/domain/navigation'
import { supabase } from './client'
import { callRpc } from './rpc'
import { numericValue, uuid } from './schemas'

// Menu items and recipes (migration 0029). Reads are RLS-scoped table SELECTs (menu_items_select / recipe_lines_select);
// every write is a security-definer RPC (the only write path: client INSERT/UPDATE/DELETE privileges are revoked). The client
// sends intents and ids only; the tenant comes from the caller's identity, never from a parameter.

export const menuItemSchema = z.object({
  id: uuid,
  name: z.string(),
  description: z.string().nullable().optional(),
  category_id: uuid,
  station_id: uuid,
  price: numericValue,
  emoji: z.string().nullable().optional(),
  image_path: z.string().nullable().optional(),
  sort_order: z.number().int().nullable().optional(),
  is_active: z.boolean(),
})
export type MenuItem = z.infer<typeof menuItemSchema>

export const recipeLineSchema = z.object({ ingredient_id: uuid, qty_per_serving: numericValue })
export type RecipeLine = z.infer<typeof recipeLineSchema>

const recipeResultSchema = z.object({ menu_item_id: uuid, lines: z.array(recipeLineSchema) })
export type RecipeResult = z.infer<typeof recipeResultSchema>

export const menuItemsKey = (restaurantId: string) => ['menu-items', restaurantId] as const
export const recipeKey = (restaurantId: string, menuItemId: string) => ['recipe', restaurantId, menuItemId] as const

const MENU_COLUMNS = 'id,name,description,category_id,station_id,price,emoji,image_path,sort_order,is_active'

/** All menu items of the caller's tenant (active and inactive). Rows failing validation are dropped. */
export async function fetchMenuItems(): Promise<MenuItem[]> {
  const { data, error } = await supabase.from('menu_items').select(MENU_COLUMNS).order('sort_order', { ascending: true })
  if (error) throw new Error('menu_unavailable')
  // A row that fails validation fails the whole read (UI shows ErrorState) instead of silently vanishing from the list.
  const parsed = z.array(menuItemSchema).safeParse(data ?? [])
  if (!parsed.success) throw new Error('menu_unavailable')
  return parsed.data
}

/** The recipe of one menu item (RLS: menu.view / menu.manage / inventory.view). */
export async function fetchRecipe(menuItemId: string): Promise<RecipeLine[]> {
  if (!isUuid(menuItemId)) return []
  const { data, error } = await supabase
    .from('recipe_lines')
    .select('ingredient_id,qty_per_serving')
    .eq('menu_item_id', menuItemId)
  if (error) throw new Error('recipe_unavailable')
  return z.array(recipeLineSchema).parse(data ?? [])
}

export interface MenuItemInput {
  name: string
  category_id: string
  station_id: string
  /** ETB, at most 2 decimals (the server refuses more instead of rounding). */
  price: number
  description?: string | null
  emoji?: string | null
  image_path?: string | null
  sort_order?: number
}

/** menu.manage. Errors: duplicate_name, plan_limit_reached (menu_items), invalid_input (detail = field), invalid_station. */
export async function createMenuItem(input: MenuItemInput): Promise<MenuItem> {
  return menuItemSchema.parse(
    await callRpc('fn_create_menu_item', {
      p_name: input.name,
      p_category_id: input.category_id,
      p_station_id: input.station_id,
      p_price: input.price,
      p_description: input.description ?? null,
      p_emoji: input.emoji ?? null,
      p_image_path: input.image_path ?? null,
      p_sort_order: input.sort_order ?? 0,
    }),
  )
}

export type MenuItemPatch = Partial<MenuItemInput>
const PATCH_KEYS = ['name', 'description', 'category_id', 'station_id', 'price', 'emoji', 'image_path', 'sort_order'] as const

/** Sends only the closed key list the RPC accepts (anything else would be invalid_input / patch). null clears description / emoji / image. */
export async function updateMenuItem(id: string, patch: MenuItemPatch): Promise<MenuItem> {
  const body: Record<string, unknown> = {}
  for (const k of PATCH_KEYS) if (patch[k] !== undefined) body[k] = patch[k]
  return menuItemSchema.parse(await callRpc('fn_update_menu_item', { p_menu_item_id: id, p_patch: body }))
}

/** Soft (de)activation. Reactivation re-checks the plan cap and refuses invalid_state / ingredient_inactive. */
export async function setMenuItemActive(id: string, active: boolean): Promise<MenuItem> {
  return menuItemSchema.parse(await callRpc('fn_set_menu_item_active', { p_menu_item_id: id, p_active: active }))
}

/** Replaces the recipe ([] clears it). Ingredients must be active rows of the tenant. */
export async function setRecipe(menuItemId: string, lines: RecipeLine[]): Promise<RecipeResult> {
  return recipeResultSchema.parse(
    await callRpc('fn_set_recipe', {
      p_menu_item_id: menuItemId,
      p_lines: lines.map((l) => ({ ingredient_id: l.ingredient_id, qty_per_serving: l.qty_per_serving })),
    }),
  )
}

export type MenuRealtimeTable = 'menu_items' | 'recipe_lines' | 'categories' | 'stations' | 'ingredients'

/**
 * Realtime changes to the tenant's menu items, recipe lines, categories, stations and ingredients (RLS applies to Realtime; the filter only
 * narrows the stream). The handler invalidates queries; no polling. Returns an unsubscribe function.
 */
export function subscribeToMenu(restaurantId: string, onChange: (table: MenuRealtimeTable) => void): () => void {
  if (!isUuid(restaurantId)) return () => {}
  const filter = `restaurant_id=eq.${restaurantId}`
  const channel = supabase
    .channel(`menu:${restaurantId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'menu_items', filter }, () => onChange('menu_items'))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'recipe_lines', filter }, () => onChange('recipe_lines'))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'categories', filter }, () => onChange('categories'))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'stations', filter }, () => onChange('stations'))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'ingredients', filter }, () => onChange('ingredients'))
    .subscribe()
  return () => {
    void supabase.removeChannel(channel)
  }
}
