import { describe, expect, it } from 'vitest'
import { hasPlanFeature, isKnownPlanFeature, mergePlanFeatures, PLAN_FEATURE_KEYS, splitPlanFeatures } from './plan-features'

describe('hasPlanFeature', () => {
  it('is true only when the key is exactly true', () => {
    expect(hasPlanFeature({ plan_features: { installments: true } }, 'installments')).toBe(true)
    expect(hasPlanFeature({ plan_features: { installments: false } }, 'installments')).toBe(false)
    expect(hasPlanFeature({ plan_features: { installments: 'true' } }, 'installments')).toBe(false)
    expect(hasPlanFeature({ plan_features: { installments: 1 } }, 'installments')).toBe(false)
    expect(hasPlanFeature({ plan_features: { multi_station: true } }, 'installments')).toBe(false)
  })

  it('is false without a feature object (platform admins, older payloads)', () => {
    expect(hasPlanFeature({ plan_features: null }, 'installments')).toBe(false)
    expect(hasPlanFeature({}, 'installments')).toBe(false)
    expect(hasPlanFeature(null, 'installments')).toBe(false)
    expect(hasPlanFeature(undefined, 'multi_station')).toBe(false)
  })

  it('ignores inherited properties', () => {
    const proto = Object.create({ installments: true }) as Record<string, unknown>
    expect(hasPlanFeature({ plan_features: proto }, 'installments')).toBe(false)
  })
})

describe('splitPlanFeatures / mergePlanFeatures', () => {
  it('turns known keys into switches (exactly true = on) and keeps unknown keys', () => {
    const { switches, other } = splitPlanFeatures({ installments: true, multi_station: 'yes', qr_ordering: true, seats: 4 })
    expect(switches).toEqual({ installments: true, multi_station: false })
    expect(other).toEqual({ qr_ordering: true, seats: 4 })
  })

  it('writes every known feature explicitly and preserves unknown keys', () => {
    expect(mergePlanFeatures({ qr_ordering: true }, { installments: false, multi_station: true })).toEqual({
      qr_ordering: true,
      installments: false,
      multi_station: true,
    })
  })

  it('a switch wins over a known key left in the unknown bucket', () => {
    expect(mergePlanFeatures({ installments: true }, { installments: false, multi_station: false })).toEqual({
      installments: false,
      multi_station: false,
    })
  })

  it('round-trips with defaults all off for an empty plan', () => {
    const { switches, other } = splitPlanFeatures(null)
    expect(Object.values(switches).every((v) => v === false)).toBe(true)
    expect(Object.keys(mergePlanFeatures(other, switches)).sort()).toEqual([...PLAN_FEATURE_KEYS].sort())
    expect(isKnownPlanFeature('installments')).toBe(true)
    expect(isKnownPlanFeature('qr_ordering')).toBe(false)
  })
})
