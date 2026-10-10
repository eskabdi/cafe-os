import { describe, expect, it } from 'vitest'
import {
  ethiopianClock,
  formatEthiopianDateTime,
  formatInternationalDateTime,
  toEthiopianDate,
} from './ethiopian-time'

describe('Ethiopian calendar', () => {
  it('converts known dates', () => {
    expect(toEthiopianDate(2026, 9, 11)).toEqual({ year: 2019, month: 1, day: 1 })
    expect(toEthiopianDate(2023, 9, 12)).toEqual({ year: 2016, month: 1, day: 1 }) // the year before a Gregorian leap year
    expect(toEthiopianDate(2024, 1, 7)).toEqual({ year: 2016, month: 4, day: 28 }) // Genna
    expect(toEthiopianDate(2026, 9, 10)).toEqual({ year: 2018, month: 13, day: 5 })
    expect(toEthiopianDate(2023, 9, 11)).toEqual({ year: 2015, month: 13, day: 6 }) // Pagume 6 in a leap year
  })
})

describe('Ethiopian clock', () => {
  it('shifts by 6 hours with the period', () => {
    expect(ethiopianClock(7, 0)).toBe('1:00 ጠዋት')
    expect(ethiopianClock(12, 0)).toBe('6:00 ቀትር')
    expect(ethiopianClock(19, 0)).toBe('1:00 ማታ')
    expect(ethiopianClock(0, 0)).toBe('6:00 ለሊት')
    expect(ethiopianClock(6, 30)).toBe('12:30 ጠዋት')
    expect(ethiopianClock(15, 5)).toBe('9:05 ከሰዓት')
  })
  it('formats an instant in the restaurant time zone with Arabic numerals', () => {
    // 16:05 UTC = 19:05 in Addis Ababa (UTC+3)
    expect(formatEthiopianDateTime('2026-09-23T16:05:00Z')).toBe('13 መስከረም 2019, 1:05 ማታ')
    expect(formatInternationalDateTime('2026-09-23T16:05:00Z')).toBe('2026-09-23 19:05')
    expect(formatEthiopianDateTime('2026-09-23T16:05:00Z', 'Not/AZone')).toBe('13 መስከረም 2019, 1:05 ማታ')
    expect(formatEthiopianDateTime('nope')).toBe('')
  })
})
