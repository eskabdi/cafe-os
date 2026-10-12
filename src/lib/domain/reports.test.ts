import { describe, expect, it } from 'vitest'
import { activeHours, describeDays, ethiopianHourLabel, internationalHourLabel, parseDayRange } from './reports'

describe('parseDayRange', () => {
  it('both empty means the current business day', () => {
    expect(parseDayRange('', ' ')).toEqual({ ok: true, range: { from: null, to: null } })
  })
  it('one bound means that single day', () => {
    expect(parseDayRange('4', '')).toEqual({ ok: true, range: { from: 4, to: 4 } })
    expect(parseDayRange('', '9')).toEqual({ ok: true, range: { from: 9, to: 9 } })
  })
  it('accepts a forward range', () => {
    expect(parseDayRange(' 2', '12 ')).toEqual({ ok: true, range: { from: 2, to: 12 } })
  })
  it('refuses non-digits, zero, a reversed range and a range wider than the server allows', () => {
    expect(parseDayRange('a', '')).toMatchObject({ ok: false })
    expect(parseDayRange('-1', '')).toMatchObject({ ok: false })
    expect(parseDayRange('1.5', '')).toMatchObject({ ok: false })
    expect(parseDayRange('0', '3')).toMatchObject({ ok: false })
    expect(parseDayRange('5', '2')).toEqual({ ok: false, error: 'The last day must not be before the first day.' })
    expect(parseDayRange('1', '367')).toMatchObject({ ok: true })
    expect(parseDayRange('1', '368')).toMatchObject({ ok: false })
  })
})

describe('hour labels', () => {
  it('international 24-hour label', () => {
    expect(internationalHourLabel(7)).toBe('07:00')
    expect(internationalHourLabel(19)).toBe('19:00')
  })
  it('Ethiopian clock label (offset 6 h, Arabic numerals)', () => {
    expect(ethiopianHourLabel(7)).toBe('1:00 ጠዋት')
    expect(ethiopianHourLabel(12)).toBe('6:00 ቀትር')
    expect(ethiopianHourLabel(19)).toBe('1:00 ማታ')
    expect(ethiopianHourLabel(0)).toBe('6:00 ለሊት')
  })
  it('activeHours keeps only hours with orders', () => {
    expect(activeHours([{ hour: 1, orders: 0 }, { hour: 2, orders: 3 }])).toEqual([{ hour: 2, orders: 3 }])
  })
})

describe('describeDays', () => {
  it('no day', () => {
    expect(describeDays([], 'Africa/Addis_Ababa')).toBe('No business day in this range.')
  })
  it('one day with its Ethiopian opening date', () => {
    // 2026-09-23 06:00 UTC = 09:00 in Addis Ababa = 3:00 ጠዋት, 13 መስከረም 2019
    expect(describeDays([{ day_no: 3, status: 'open', opened_at: '2026-09-23T06:00:00Z' }], 'Africa/Addis_Ababa')).toBe(
      'Business day 3 (open), opened 13 መስከረም 2019, 3:00 ጠዋት',
    )
  })
  it('a range', () => {
    const days = [
      { day_no: 1, status: 'closed', opened_at: '2026-09-23T06:00:00Z' },
      { day_no: 2, status: 'open', opened_at: '2026-09-24T06:00:00Z' },
    ]
    expect(describeDays(days, 'Africa/Addis_Ababa')).toBe('Business days 1–2 (2 days), from 13 መስከረም 2019, 3:00 ጠዋት')
  })
})
