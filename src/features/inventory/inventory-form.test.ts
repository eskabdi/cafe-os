import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase/client', () => ({ supabase: {} }))

const f = await import('./inventory-form')

const ST = '33333333-3333-4333-8333-333333333333'
const ing = {
  id: '44444444-4444-4444-8444-444444444444',
  name: 'Flour',
  station_id: ST,
  unit: 'kg' as const,
  stock: 5,
  min_level: 1,
  cost_per_unit: 10,
  is_active: true,
}

describe('ingredient form', () => {
  const ok = {
    name: 'Flour',
    station_id: ST,
    unit: 'kg' as const,
    min_level: '1.5',
    cost_per_unit: '12.25',
    initial_stock: '0',
  }
  it('validates units, decimals and station uuid', () => {
    expect(f.ingredientFormSchema.safeParse(ok).success).toBe(true)
    expect(f.ingredientFormSchema.safeParse({ ...ok, unit: 'cups' }).success).toBe(false)
    expect(f.ingredientFormSchema.safeParse({ ...ok, cost_per_unit: '1.001' }).success).toBe(false)
    expect(f.ingredientFormSchema.safeParse({ ...ok, min_level: '1.0001' }).success).toBe(false)
    expect(f.ingredientFormSchema.safeParse({ ...ok, station_id: 'Kitchen-ish' }).success).toBe(false)
  })

  it('patch never contains stock and only changed fields', () => {
    const v = f.ingredientFormFrom(ing)
    expect(f.ingredientPatch(ing, v)).toEqual({})
    expect(f.ingredientPatch(ing, { ...v, cost_per_unit: '11', initial_stock: '99' })).toEqual({
      cost_per_unit: 11,
    })
    expect(f.toIngredientInput(ok)).toEqual({
      name: 'Flour',
      station_id: ST,
      unit: 'kg',
      min_level: 1.5,
      cost_per_unit: 12.25,
      initial_stock: 0,
    })
  })
})

describe('stock forms', () => {
  it('receive: positive quantity with at most 3 decimals', () => {
    expect(f.receiveFormSchema.safeParse({ qty: '2.5', note: '' }).success).toBe(true)
    expect(f.receiveFormSchema.safeParse({ qty: '0', note: '' }).success).toBe(false)
    expect(f.receiveFormSchema.safeParse({ qty: '-1', note: '' }).success).toBe(false)
    expect(f.receiveFormSchema.safeParse({ qty: '1000001', note: '' }).success).toBe(false)
    expect(f.receiveFormSchema.safeParse({ qty: '1', note: 'x'.repeat(301) }).success).toBe(false)
  })

  it('adjust: signed non-zero delta and a mandatory reason of 3..300 characters', () => {
    expect(f.adjustFormSchema.safeParse({ qty_delta: '-0.5', reason: 'spoiled' }).success).toBe(true)
    expect(f.adjustFormSchema.safeParse({ qty_delta: '0', reason: 'spoiled' }).success).toBe(false)
    expect(f.adjustFormSchema.safeParse({ qty_delta: '2', reason: '  ' }).success).toBe(false)
    expect(f.adjustFormSchema.safeParse({ qty_delta: '2', reason: 'ab' }).success).toBe(false)
  })

  it('threshold: ETB 100..1,000,000', () => {
    expect(f.thresholdFormSchema.safeParse({ threshold: '100' }).success).toBe(true)
    expect(f.thresholdFormSchema.safeParse({ threshold: '99.99' }).success).toBe(false)
    expect(f.thresholdFormSchema.safeParse({ threshold: '1000000.01' }).success).toBe(false)
  })
})
