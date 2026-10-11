import { describe, expect, it } from 'vitest'
import { buildSchedule } from './installments'

describe('buildSchedule (preview of the server rule)', () => {
  it('ceil whole birr, remainder in the last', () => {
    expect(buildSchedule(1000, 100, 4, 7)).toEqual([
      { no: 1, dueInDays: 7, amount: 225 },
      { no: 2, dueInDays: 14, amount: 225 },
      { no: 3, dueInDays: 21, amount: 225 },
      { no: 4, dueInDays: 28, amount: 225 },
    ])
    expect(buildSchedule(173.65, 10, 3, 30)?.map((l) => l.amount)).toEqual([55, 55, 53.65])
  })
  it('falls back to an even split to the cent when ceil would leave nothing for the last', () => {
    const s = buildSchedule(105, 100, 6, 14)
    expect(s?.every((l) => l.amount > 0)).toBe(true)
    expect(Math.round((s ?? []).reduce((a, l) => a + l.amount, 0) * 100)).toBe(500)
  })
  it('refuses invalid input', () => {
    expect(buildSchedule(100, 100, 3, 7)).toBeNull()
    expect(buildSchedule(100, -1, 3, 7)).toBeNull()
    expect(buildSchedule(100, 0, 0, 7)).toBeNull()
    expect(buildSchedule(100, 0, 61, 7)).toBeNull()
  })
})
