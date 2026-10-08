import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase/client', () => ({ supabase: {} }))

const { menuItemFormSchema, menuItemPatch, toMenuItemInput, menuFormFromItem } = await import('./menu-form')
const { validateRecipe, recipeCostPreview } = await import('./recipe-form')

const CAT = '22222222-2222-4222-8222-222222222222'
const ST = '33333333-3333-4333-8333-333333333333'
const ING = '44444444-4444-4444-8444-444444444444'
const ING2 = '55555555-5555-4555-8555-555555555555'
const item = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Item',
  description: null,
  category_id: CAT,
  station_id: ST,
  price: 120.5,
  emoji: null,
  image_path: 'restaurants/r/menu/a.png',
  sort_order: 0,
  is_active: true,
}

describe('menu item form', () => {
  const ok = {
    name: ' Tibs ',
    price: '120.50',
    category_id: CAT,
    station_id: ST,
    description: '',
    emoji: '',
    sort_order: '0',
  }

  it('validates like the RPC (2-decimal price, uuid refs, emoji code points)', () => {
    expect(menuItemFormSchema.safeParse(ok).success).toBe(true)
    expect(menuItemFormSchema.safeParse({ ...ok, price: '1.234' }).success).toBe(false)
    expect(menuItemFormSchema.safeParse({ ...ok, price: '-1' }).success).toBe(false)
    expect(menuItemFormSchema.safeParse({ ...ok, category_id: 'Desserts' }).success).toBe(false)
    expect(menuItemFormSchema.safeParse({ ...ok, emoji: '🍕'.repeat(16) }).success).toBe(true)
    expect(menuItemFormSchema.safeParse({ ...ok, emoji: '🍕'.repeat(17) }).success).toBe(false)
    expect(menuItemFormSchema.safeParse({ ...ok, sort_order: '1.5' }).success).toBe(false)
  })

  it('builds the RPC input (trimmed, nulls for empty optionals, exact decimals)', () => {
    expect(toMenuItemInput(ok, null)).toEqual({
      name: 'Tibs',
      price: 120.5,
      category_id: CAT,
      station_id: ST,
      description: null,
      emoji: null,
      image_path: null,
      sort_order: 0,
    })
  })

  it('patches only changed fields; image undefined = keep, null = remove', () => {
    const v = menuFormFromItem(item)
    expect(menuItemPatch(item, v, undefined)).toEqual({})
    expect(menuItemPatch(item, { ...v, price: '99' }, undefined)).toEqual({ price: 99 })
    expect(menuItemPatch(item, v, null)).toEqual({ image_path: null })
    expect(menuItemPatch(item, { ...v, description: 'Spicy' }, 'restaurants/r/menu/b.png')).toEqual({
      description: 'Spicy',
      image_path: 'restaurants/r/menu/b.png',
    })
  })
})

describe('recipe draft', () => {
  it('accepts unique ingredients with positive 3-decimal quantities', () => {
    expect(
      validateRecipe([
        { key: 'a', ingredient_id: ING, qty: '0.125' },
        { key: 'b', ingredient_id: ING2, qty: '2' },
      ]),
    ).toEqual({
      ok: true,
      lines: [
        { ingredient_id: ING, qty_per_serving: 0.125 },
        { ingredient_id: ING2, qty_per_serving: 2 },
      ],
    })
    expect(validateRecipe([])).toEqual({ ok: true, lines: [] })
  })

  it('reports per-line errors', () => {
    const r = validateRecipe([
      { key: 'a', ingredient_id: '', qty: '1' },
      { key: 'b', ingredient_id: ING, qty: '0' },
      { key: 'c', ingredient_id: ING2, qty: '1' },
      { key: 'd', ingredient_id: ING2, qty: '1.0001' },
    ])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(['a', 'b', 'd'])
  })

  it('refuses more than 50 lines', () => {
    const lines = Array.from({ length: 51 }, (_, i) => ({ key: String(i), ingredient_id: ING, qty: '1' }))
    expect(validateRecipe(lines)).toMatchObject({ ok: false })
  })

  it('previews the per-serving cost in santim precision', () => {
    const cost = recipeCostPreview(
      [
        { ingredient_id: ING, qty_per_serving: 0.1 },
        { ingredient_id: ING2, qty_per_serving: 0.2 },
      ],
      (id) => (id === ING ? 10.1 : 20.2),
    )
    expect(cost).toBe(5.05)
  })
})
