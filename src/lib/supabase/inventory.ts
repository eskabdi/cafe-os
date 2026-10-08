import { z } from 'zod'
import { INGREDIENT_UNITS, MOVEMENT_REASONS, type IngredientUnit } from '@/lib/domain/inventory'
import { isUuid } from '@/lib/domain/navigation'
import { supabase } from './client'
import { callRpc } from './rpc'
import { numericValue, uuid } from './schemas'

// Ingredients and the stock ledger (migration 0029). Reads: RLS-scoped SELECT on ingredients and the
// fn_list_stock_movements RPC (keyset paging). Writes: RPCs only. Stock commands carry a client-generated idempotency key
// per intent (the same key is reused for a retry of that intent, e.g. after step-up). On-hand stock is never sent by the
// client: the server posts a ledger row and maintains the running total.

export const ingredientSchema = z.object({
  id: uuid,
  name: z.string(),
  station_id: uuid,
  unit: z.enum(INGREDIENT_UNITS),
  stock: numericValue,
  min_level: numericValue,
  cost_per_unit: numericValue,
  is_active: z.boolean(),
})
export type Ingredient = z.infer<typeof ingredientSchema>

const stockResultSchema = z.object({
  movement_id: uuid,
  ingredient_id: uuid,
  qty_delta: numericValue,
  reason: z.enum(MOVEMENT_REASONS),
  stock: numericValue,
})
export type StockResult = z.infer<typeof stockResultSchema>

export const movementSchema = z.object({
  id: uuid,
  ingredient_id: uuid,
  ingredient_name: z.string(),
  unit: z.enum(INGREDIENT_UNITS),
  station_id: uuid,
  qty_delta: numericValue,
  reason: z.enum(MOVEMENT_REASONS),
  note: z.string().nullable().optional(),
  order_id: uuid.nullable().optional(),
  reverses_movement_id: uuid.nullable().optional(),
  day_session_id: uuid.nullable().optional(),
  created_by: uuid.nullable().optional(),
  created_by_name: z.string().nullable().optional(),
  created_at: z.string(),
})
export type StockMovement = z.infer<typeof movementSchema>

export const ingredientsKey = (restaurantId: string) => ['ingredients', restaurantId] as const
export const movementsKey = (restaurantId: string, ingredientId: string | null) =>
  ['stock-movements', restaurantId, ingredientId ?? 'all'] as const
export const stepUpThresholdKey = (restaurantId: string) => ['stock-stepup-threshold', restaurantId] as const

/** All ingredients the caller may see (RLS: inventory.view + station access / adjust / receive, or menu.manage). */
export async function fetchIngredients(): Promise<Ingredient[]> {
  const { data, error } = await supabase
    .from('ingredients')
    .select('id,name,station_id,unit,stock,min_level,cost_per_unit,is_active')
    .order('name', { ascending: true })
  if (error) throw new Error('ingredients_unavailable')
  const out: Ingredient[] = []
  for (const row of Array.isArray(data) ? data : []) {
    const parsed = ingredientSchema.safeParse(row)
    if (parsed.success) out.push(parsed.data)
  }
  return out
}

export interface IngredientInput {
  name: string
  station_id: string
  unit: IngredientUnit
  min_level?: number
  cost_per_unit?: number
  /** > 0 posts an `opening` ledger row (needs the open day, follows the stock step-up rule). */
  initial_stock?: number
}

/** inventory.adjust. Errors: duplicate_name, invalid_input (detail), invalid_station, day_closed, mfa_required. */
export async function createIngredient(input: IngredientInput): Promise<Ingredient> {
  return ingredientSchema.parse(
    await callRpc('fn_create_ingredient', {
      p_name: input.name,
      p_station_id: input.station_id,
      p_unit: input.unit,
      p_min_level: input.min_level ?? 0,
      p_cost_per_unit: input.cost_per_unit ?? 0,
      p_initial_stock: input.initial_stock ?? 0,
    }),
  )
}

export type IngredientPatch = Partial<Pick<IngredientInput, 'name' | 'station_id' | 'unit' | 'min_level' | 'cost_per_unit'>>
const PATCH_KEYS = ['name', 'station_id', 'unit', 'min_level', 'cost_per_unit'] as const

/** Closed key list (stock is never patchable). unit_locked once movements / recipe lines exist; cost change may need step-up. */
export async function updateIngredient(id: string, patch: IngredientPatch): Promise<Ingredient> {
  const body: Record<string, unknown> = {}
  for (const k of PATCH_KEYS) if (patch[k] !== undefined) body[k] = patch[k]
  return ingredientSchema.parse(await callRpc('fn_update_ingredient', { p_ingredient_id: id, p_patch: body }))
}

/** Deactivation is refused (invalid_state / ingredient_in_active_recipe) while an active menu item's recipe uses it. */
export async function setIngredientActive(id: string, active: boolean): Promise<Ingredient> {
  return ingredientSchema.parse(await callRpc('fn_set_ingredient_active', { p_ingredient_id: id, p_active: active }))
}

/** inventory.receive. qty > 0, <= 3 decimals. Idempotent per key (a replay returns the first result). */
export async function receiveStock(a: { ingredientId: string; qty: number; note?: string | null; idempotencyKey: string }): Promise<StockResult> {
  return stockResultSchema.parse(
    await callRpc('fn_receive_stock', {
      p_ingredient_id: a.ingredientId,
      p_qty: a.qty,
      p_idempotency_key: a.idempotencyKey,
      p_note: a.note ?? null,
    }),
  )
}

/** inventory.adjust. Signed non-zero delta; reason (3..300) is mandatory. insufficient_stock below zero. */
export async function adjustStock(a: { ingredientId: string; qtyDelta: number; reason: string; idempotencyKey: string }): Promise<StockResult> {
  return stockResultSchema.parse(
    await callRpc('fn_adjust_stock', {
      p_ingredient_id: a.ingredientId,
      p_qty_delta: a.qtyDelta,
      p_reason: a.reason,
      p_idempotency_key: a.idempotencyKey,
    }),
  )
}

/** inventory.adjust. Compensating row; once only (already_reversed); consumption / reversal rows are not_reversible. */
export async function reverseStockMovement(a: { movementId: string; reason: string; idempotencyKey: string }): Promise<StockResult> {
  return stockResultSchema.parse(
    await callRpc('fn_reverse_stock_movement', {
      p_movement_id: a.movementId,
      p_reason: a.reason,
      p_idempotency_key: a.idempotencyKey,
    }),
  )
}

export interface MovementCursor {
  before: string
  beforeId: string
}

/** Newest first. Pass the previous page's last row as the cursor (keyset on created_at, id: no row skipped or repeated). */
export async function listStockMovements(a: { ingredientId?: string | null; limit?: number; cursor?: MovementCursor | null } = {}): Promise<StockMovement[]> {
  return z.array(movementSchema).parse(
    await callRpc('fn_list_stock_movements', {
      p_ingredient_id: a.ingredientId ?? null,
      p_limit: a.limit ?? 50,
      p_before: a.cursor?.before ?? null,
      p_before_id: a.cursor?.beforeId ?? null,
    }),
  )
}

/** The tenant's stock step-up threshold (ETB) for the UI hint; RLS returns only the caller's own restaurant row. */
export async function fetchStockStepupThreshold(restaurantId: string): Promise<number | null> {
  if (!isUuid(restaurantId)) return null
  const { data, error } = await supabase.from('restaurants').select('stock_stepup_threshold').eq('id', restaurantId).maybeSingle()
  if (error) throw new Error('threshold_unavailable')
  const parsed = z.object({ stock_stepup_threshold: numericValue }).safeParse(data)
  return parsed.success ? parsed.data.stock_stepup_threshold : null
}

/** settings.manage + aal2 (mfa_required otherwise). ETB 100..1,000,000, at most 2 decimals. */
export async function setStockStepupThreshold(threshold: number): Promise<number> {
  return z
    .object({ stock_stepup_threshold: numericValue })
    .parse(await callRpc('fn_set_stock_stepup_threshold', { p_threshold: threshold })).stock_stepup_threshold
}

export type InventoryRealtimeTable = 'ingredients' | 'stock_movements' | 'stations'

/** Realtime changes to the tenant's ingredients, stock ledger and stations (RLS applies). Returns an unsubscribe function. */
export function subscribeToInventory(restaurantId: string, onChange: (table: InventoryRealtimeTable) => void): () => void {
  if (!isUuid(restaurantId)) return () => {}
  const filter = `restaurant_id=eq.${restaurantId}`
  const channel = supabase
    .channel(`inventory:${restaurantId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'ingredients', filter }, () => onChange('ingredients'))
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'stock_movements', filter }, () => onChange('stock_movements'))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'stations', filter }, () => onChange('stations'))
    .subscribe()
  return () => {
    void supabase.removeChannel(channel)
  }
}
