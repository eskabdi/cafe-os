import { describe, expect, it } from 'vitest'
import {
  checkMenuImage,
  groupByCategory,
  isLowStock,
  isReversibleReason,
  MENU_IMAGE_MAX_BYTES,
  menuImagePath,
  newIdempotencyKey,
  pickerRows,
  sniffImageType,
  stepUpLikely,
} from './inventory'

const C1 = '11111111-1111-4111-8111-111111111111'
const C2 = '22222222-2222-4222-8222-222222222222'
const C3 = '33333333-3333-4333-8333-333333333333'
const RID = '99999999-9999-4999-8999-999999999999'

describe('groupByCategory', () => {
  // Category names are runtime data: the grouping only ever uses ids and sort_order.
  const cats = [
    { id: C2, name: 'Zeta', sort_order: 2, is_active: true },
    { id: C1, name: 'Alpha', sort_order: 1, is_active: true },
    { id: C3, name: 'Empty', sort_order: 0, is_active: true },
  ]
  it('groups by category id in category order, items by sort order then name, empties omitted, orphans last', () => {
    const items = [
      { id: 'a', name: 'B item', category_id: C2, sort_order: 0 },
      { id: 'b', name: 'A item', category_id: C2, sort_order: 0 },
      { id: 'c', name: 'First', category_id: C1, sort_order: 5 },
      { id: 'd', name: 'Lost', category_id: '44444444-4444-4444-8444-444444444444', sort_order: 0 },
    ]
    const groups = groupByCategory(items, cats)
    expect(groups.map((g) => g.key)).toEqual([C1, C2, 'uncategorised'])
    expect(groups[1]?.items.map((i) => i.id)).toEqual(['b', 'a'])
    expect(groups[2]?.category).toBeNull()
  })
})

describe('stock rules (UX hints only)', () => {
  it('low stock is on hand at or below the minimum, inactive rows excluded', () => {
    expect(isLowStock({ stock: 2, min_level: 2 })).toBe(true)
    expect(isLowStock({ stock: 2.001, min_level: 2 })).toBe(false)
    expect(isLowStock({ stock: 0, min_level: 0, is_active: false })).toBe(false)
  })

  it('step-up hint mirrors fn_stock_step_up (value, or quantity when there is no cost)', () => {
    expect(stepUpLikely(10, 500, 5000)).toBe(true)
    expect(stepUpLikely(-10, 499.99, 5000)).toBe(false)
    expect(stepUpLikely(5000, 0, 5000)).toBe(true)
    expect(stepUpLikely(4999, 0, 5000)).toBe(false)
    expect(stepUpLikely(10, 500, null)).toBe(false)
  })

  it('only received / adjustment / opening / correction rows are reversible', () => {
    expect(isReversibleReason('received')).toBe(true)
    expect(isReversibleReason('manual_adjustment')).toBe(true)
    expect(isReversibleReason('opening')).toBe(true)
    expect(isReversibleReason('consumed')).toBe(false)
    expect(isReversibleReason('reversal')).toBe(false)
  })

  it('pickers offer active rows plus the current selection', () => {
    const rows = [
      { id: 'x', name: 'Off', is_active: false, sort_order: 0 },
      { id: 'y', name: 'On', is_active: true, sort_order: 1 },
    ]
    expect(pickerRows(rows).map((r) => r.id)).toEqual(['y'])
    expect(pickerRows(rows, 'x').map((r) => r.id)).toEqual(['x', 'y'])
  })

  it('idempotency keys are unique UUIDs within the 8..128 char rule', () => {
    const a = newIdempotencyKey()
    expect(a).toMatch(/^[0-9a-f-]{36}$/)
    expect(newIdempotencyKey()).not.toBe(a)
  })
})

describe('menu image checks', () => {
  it('accepts png / jpeg / webp up to 2 MiB', () => {
    expect(checkMenuImage({ type: 'image/png', size: 10 })).toEqual({
      ok: true,
      ext: 'png',
      contentType: 'image/png',
    })
    expect(checkMenuImage({ type: 'image/jpeg', size: MENU_IMAGE_MAX_BYTES })).toMatchObject({
      ok: true,
      ext: 'jpg',
    })
    expect(checkMenuImage({ type: 'image/webp', size: 1 })).toMatchObject({ ok: true, ext: 'webp' })
  })

  it('refuses other types, oversize and empty files', () => {
    expect(checkMenuImage({ type: 'image/svg+xml', size: 10 })).toEqual({ ok: false, reason: 'type' })
    expect(checkMenuImage({ type: 'image/gif', size: 10 })).toEqual({ ok: false, reason: 'type' })
    expect(checkMenuImage({ type: 'image/png', size: MENU_IMAGE_MAX_BYTES + 1 })).toEqual({
      ok: false,
      reason: 'size',
    })
    expect(checkMenuImage({ type: 'image/png', size: 0 })).toEqual({ ok: false, reason: 'empty' })
    expect(checkMenuImage({ type: 'constructor', size: 1 })).toEqual({ ok: false, reason: 'type' })
  })

  it('sniffs magic bytes', () => {
    expect(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toBe('image/png')
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(sniffImageType(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe(
      'image/webp',
    )
    expect(sniffImageType(new TextEncoder().encode('<svg xmlns='))).toBeNull()
    expect(sniffImageType(new Uint8Array([]))).toBeNull()
  })

  it('builds the tenant-scoped path the Storage policy expects', () => {
    expect(menuImagePath(RID, 'png', 'abc')).toBe(`restaurants/${RID}/menu/abc.png`)
    expect(menuImagePath(RID, 'webp')).toMatch(new RegExp(`^restaurants/${RID}/menu/[0-9a-f-]{36}\\.webp$`))
  })
})
