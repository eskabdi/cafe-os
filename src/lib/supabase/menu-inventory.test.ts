import { beforeEach, describe, expect, it, vi } from 'vitest'

// The 12 Phase-3 RPC wrappers: argument names match the SQL signatures (migration 0029), responses are zod-parsed, structured
// errors surface as RpcError. Table reads go through the RLS-scoped query builder without any restaurant_id filter.
const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  result: { data: [] as unknown, error: null as null | { message: string } },
  calls: [] as Array<[string, ...unknown[]]>,
  ons: [] as Array<{ table: string; event: string; filter: string; cb: () => void }>,
  removeChannel: vi.fn(),
}))

vi.mock('./client', () => {
  const query: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'order'])
    query[m] = (...args: unknown[]) => {
      h.calls.push([m, ...args])
      return query
    }
  query.maybeSingle = () => {
    h.calls.push(['maybeSingle'])
    return Promise.resolve(h.result)
  }
  query.then = (resolve: (v: unknown) => unknown) => Promise.resolve(h.result).then(resolve)
  const channel = {
    on: (_t: string, f: { table: string; event: string; filter: string }, cb: () => void) => {
      h.ons.push({ table: f.table, event: f.event, filter: f.filter, cb })
      return channel
    },
    subscribe: () => channel,
  }
  return {
    supabase: {
      rpc: h.rpc,
      from: (table: string) => {
        h.calls.push(['from', table])
        return query
      },
      channel: () => channel,
      removeChannel: h.removeChannel,
    },
  }
})

const menu = await import('./menu')
const inv = await import('./inventory')
const { RpcError } = await import('./rpc')

const RID = '99999999-9999-4999-8999-999999999999'
const ITEM = '11111111-1111-4111-8111-111111111111'
const CAT = '22222222-2222-4222-8222-222222222222'
const ST = '33333333-3333-4333-8333-333333333333'
const ING = '44444444-4444-4444-8444-444444444444'
const MOV = '55555555-5555-4555-8555-555555555555'
const KEY = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

const itemJson = {
  id: ITEM,
  name: 'Item',
  description: null,
  category_id: CAT,
  station_id: ST,
  price: 120.5,
  emoji: null,
  image_path: null,
  sort_order: 0,
  is_active: true,
}
const ingJson = { id: ING, name: 'Ing', station_id: ST, unit: 'kg', stock: 5, min_level: 1, cost_per_unit: 10, is_active: true }
const stockJson = { movement_id: MOV, ingredient_id: ING, qty_delta: 2, reason: 'received', stock: 7 }

beforeEach(() => {
  h.rpc.mockReset()
  h.calls.length = 0
  h.ons.length = 0
  h.result = { data: [], error: null }
})

describe('menu RPCs', () => {
  it('fn_create_menu_item: documented argument names, null for empty optionals', async () => {
    h.rpc.mockResolvedValue({ data: itemJson, error: null })
    await expect(menu.createMenuItem({ name: 'Item', category_id: CAT, station_id: ST, price: 120.5 })).resolves.toEqual(itemJson)
    expect(h.rpc).toHaveBeenCalledWith('fn_create_menu_item', {
      p_name: 'Item',
      p_category_id: CAT,
      p_station_id: ST,
      p_price: 120.5,
      p_description: null,
      p_emoji: null,
      p_image_path: null,
      p_sort_order: 0,
    })
  })

  it('fn_update_menu_item sends only the closed key list; null clears', async () => {
    h.rpc.mockResolvedValue({ data: itemJson, error: null })
    await menu.updateMenuItem(ITEM, {
      price: 99,
      image_path: null,
      ...({ restaurant_id: RID, stock: 1 } as object),
    })
    expect(h.rpc).toHaveBeenCalledWith('fn_update_menu_item', { p_menu_item_id: ITEM, p_patch: { price: 99, image_path: null } })
  })

  it('fn_set_menu_item_active and fn_set_recipe', async () => {
    h.rpc.mockResolvedValueOnce({ data: { ...itemJson, is_active: false }, error: null })
    await expect(menu.setMenuItemActive(ITEM, false)).resolves.toMatchObject({ is_active: false })
    expect(h.rpc).toHaveBeenLastCalledWith('fn_set_menu_item_active', { p_menu_item_id: ITEM, p_active: false })

    const lines = [{ ingredient_id: ING, qty_per_serving: 0.25 }]
    h.rpc.mockResolvedValueOnce({ data: { menu_item_id: ITEM, lines }, error: null })
    await expect(menu.setRecipe(ITEM, lines)).resolves.toEqual({ menu_item_id: ITEM, lines })
    expect(h.rpc).toHaveBeenLastCalledWith('fn_set_recipe', { p_menu_item_id: ITEM, p_lines: lines })
  })

  it('rejects a malformed response and surfaces structured errors', async () => {
    h.rpc.mockResolvedValueOnce({ data: { ...itemJson, id: 'not-a-uuid' }, error: null })
    await expect(menu.setMenuItemActive(ITEM, true)).rejects.toThrow()
    h.rpc.mockResolvedValueOnce({ data: null, error: { message: 'plan_limit_reached', details: 'menu_items' } })
    const err = await menu.setMenuItemActive(ITEM, true).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RpcError)
    expect(err).toMatchObject({ code: 'plan_limit_reached', detail: 'menu_items' })
  })

  it('reads menu items via RLS without a tenant filter and drops invalid rows', async () => {
    h.result = { data: [itemJson, { ...itemJson, id: 'bad' }], error: null }
    await expect(menu.fetchMenuItems()).resolves.toEqual([itemJson])
    expect(h.calls[0]).toEqual(['from', 'menu_items'])
    expect(h.calls.some((c) => c[0] === 'eq')).toBe(false)
  })

  it('subscribes to menu, recipe, category and station changes of the tenant', () => {
    const changed = vi.fn()
    const off = menu.subscribeToMenu(RID, changed)
    expect(h.ons.map((o) => o.table)).toEqual(['menu_items', 'recipe_lines', 'categories', 'stations'])
    expect(new Set(h.ons.map((o) => o.filter))).toEqual(new Set([`restaurant_id=eq.${RID}`]))
    h.ons[1]?.cb()
    expect(changed).toHaveBeenCalledWith('recipe_lines')
    off()
    expect(h.removeChannel).toHaveBeenCalled()
    expect(menu.subscribeToMenu('not-a-uuid', changed)).toBeTypeOf('function')
    expect(h.ons).toHaveLength(4)
  })
})

describe('ingredient and stock RPCs', () => {
  it('fn_create_ingredient / fn_update_ingredient / fn_set_ingredient_active', async () => {
    h.rpc.mockResolvedValue({ data: ingJson, error: null })
    await inv.createIngredient({ name: 'Ing', station_id: ST, unit: 'kg' })
    expect(h.rpc).toHaveBeenLastCalledWith('fn_create_ingredient', {
      p_name: 'Ing',
      p_station_id: ST,
      p_unit: 'kg',
      p_min_level: 0,
      p_cost_per_unit: 0,
      p_initial_stock: 0,
    })
    await inv.updateIngredient(ING, { cost_per_unit: 12, ...({ stock: 99 } as object) })
    expect(h.rpc).toHaveBeenLastCalledWith('fn_update_ingredient', { p_ingredient_id: ING, p_patch: { cost_per_unit: 12 } })
    await inv.setIngredientActive(ING, false)
    expect(h.rpc).toHaveBeenLastCalledWith('fn_set_ingredient_active', { p_ingredient_id: ING, p_active: false })
  })

  it('fn_receive_stock / fn_adjust_stock / fn_reverse_stock_movement carry the idempotency key', async () => {
    h.rpc.mockResolvedValue({ data: stockJson, error: null })
    await expect(inv.receiveStock({ ingredientId: ING, qty: 2, idempotencyKey: KEY })).resolves.toEqual(stockJson)
    expect(h.rpc).toHaveBeenLastCalledWith('fn_receive_stock', {
      p_ingredient_id: ING,
      p_qty: 2,
      p_idempotency_key: KEY,
      p_note: null,
    })
    await inv.adjustStock({ ingredientId: ING, qtyDelta: -1.5, reason: 'spoiled', idempotencyKey: KEY })
    expect(h.rpc).toHaveBeenLastCalledWith('fn_adjust_stock', {
      p_ingredient_id: ING,
      p_qty_delta: -1.5,
      p_reason: 'spoiled',
      p_idempotency_key: KEY,
    })
    await inv.reverseStockMovement({ movementId: MOV, reason: 'wrong entry', idempotencyKey: KEY })
    expect(h.rpc).toHaveBeenLastCalledWith('fn_reverse_stock_movement', {
      p_movement_id: MOV,
      p_reason: 'wrong entry',
      p_idempotency_key: KEY,
    })
  })

  it('fn_list_stock_movements: keyset cursor and parsed rows', async () => {
    const row = {
      id: MOV,
      ingredient_id: ING,
      ingredient_name: 'Ing',
      unit: 'kg',
      station_id: ST,
      qty_delta: -0.25,
      reason: 'manual_adjustment',
      note: 'count',
      order_id: null,
      reverses_movement_id: null,
      day_session_id: null,
      created_by: null,
      created_by_name: null,
      created_at: '2026-10-08T10:00:00.123456+00:00',
    }
    h.rpc.mockResolvedValue({ data: [row], error: null })
    await expect(inv.listStockMovements()).resolves.toEqual([row])
    expect(h.rpc).toHaveBeenLastCalledWith('fn_list_stock_movements', {
      p_ingredient_id: null,
      p_limit: 50,
      p_before: null,
      p_before_id: null,
    })
    await inv.listStockMovements({ ingredientId: ING, limit: 25, cursor: { before: row.created_at, beforeId: MOV } })
    expect(h.rpc).toHaveBeenLastCalledWith('fn_list_stock_movements', {
      p_ingredient_id: ING,
      p_limit: 25,
      p_before: row.created_at,
      p_before_id: MOV,
    })
    h.rpc.mockResolvedValueOnce({ data: [{ ...row, reason: 'stolen' }], error: null })
    await expect(inv.listStockMovements()).rejects.toThrow()
  })

  it('fn_set_stock_stepup_threshold and the threshold read', async () => {
    h.rpc.mockResolvedValue({ data: { stock_stepup_threshold: 2500 }, error: null })
    await expect(inv.setStockStepupThreshold(2500)).resolves.toBe(2500)
    expect(h.rpc).toHaveBeenLastCalledWith('fn_set_stock_stepup_threshold', { p_threshold: 2500 })
    h.result = { data: { stock_stepup_threshold: 5000 }, error: null }
    await expect(inv.fetchStockStepupThreshold(RID)).resolves.toBe(5000)
    expect(h.calls).toContainEqual(['from', 'restaurants'])
    await expect(inv.fetchStockStepupThreshold('x')).resolves.toBeNull()
  })

  it('accepts numeric strings for numeric columns, refuses garbage', () => {
    expect(inv.ingredientSchema.parse({ ...ingJson, stock: '5.250' }).stock).toBe(5.25)
    expect(() => inv.ingredientSchema.parse({ ...ingJson, stock: 'NaN' })).toThrow()
    expect(() => inv.ingredientSchema.parse({ ...ingJson, unit: 'cups' })).toThrow()
  })

  it('surfaces mfa_required / insufficient_stock / day_closed as RpcError codes', async () => {
    for (const code of ['mfa_required', 'insufficient_stock', 'day_closed']) {
      h.rpc.mockResolvedValueOnce({ data: null, error: { message: code, details: 'Some Ingredient Name' } })
      const err = await inv.adjustStock({ ingredientId: ING, qtyDelta: -1, reason: 'x x x', idempotencyKey: KEY }).catch((e: unknown) => e)
      expect(err).toMatchObject({ code, detail: undefined })
    }
  })

  it('subscribes to ingredients, ledger inserts and stations of the tenant', () => {
    const changed = vi.fn()
    inv.subscribeToInventory(RID, changed)
    expect(h.ons.map((o) => [o.table, o.event])).toEqual([
      ['ingredients', '*'],
      ['stock_movements', 'INSERT'],
      ['stations', '*'],
    ])
    h.ons[1]?.cb()
    expect(changed).toHaveBeenCalledWith('stock_movements')
  })
})
