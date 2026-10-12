import { describe, expect, it } from 'vitest'
import {
  MAX_ETH_YEAR,
  MIN_ETH_YEAR,
  parseEthiopianYear,
  addDays,
  defaultPeriod,
  ethiopianMonthLength,
  ethiopianMonthRange,
  ethiopianToIso,
  isEthiopianLeapYear,
  isIsoDate,
  isoToEthiopian,
  parseCustomRange,
  periodLabel,
  periodRange,
  shiftPeriod,
  spanDays,
  todayIn,
  weekRange,
} from './reports-period'

describe('Ethiopian month ranges', () => {
  it('Meskerem 2019 starts on 11 September 2026', () => {
    expect(ethiopianMonthRange(2019, 1)).toEqual({ from: '2026-09-11', to: '2026-10-10' })
  })
  it('Tir 2018 spans 9 January to 7 February 2026', () => {
    expect(ethiopianMonthRange(2018, 5)).toEqual({ from: '2026-01-09', to: '2026-02-07' })
  })
  it('Pagume has 5 days in a common year', () => {
    expect(isEthiopianLeapYear(2018)).toBe(false)
    expect(ethiopianMonthRange(2018, 13)).toEqual({ from: '2026-09-06', to: '2026-09-10' })
  })
  it('Pagume has 6 days in a leap year (year % 4 === 3), and the next year starts on 12 September', () => {
    expect(isEthiopianLeapYear(2015)).toBe(true)
    expect(ethiopianMonthRange(2015, 13)).toEqual({ from: '2023-09-06', to: '2023-09-11' })
    expect(ethiopianMonthRange(2016, 1).from).toBe('2023-09-12')
    expect(ethiopianMonthRange(2019, 13)).toEqual({ from: '2027-09-06', to: '2027-09-11' })
    expect(ethiopianMonthRange(2020, 1).from).toBe('2027-09-12')
  })
  it('months tile the year without gaps and round-trip through toEthiopianDate', () => {
    for (const year of [2015, 2016, 2018, 2019]) {
      let next = ethiopianToIso(year, 1, 1)
      for (let m = 1; m <= 13; m++) {
        const r = ethiopianMonthRange(year, m)
        expect(r.from).toBe(next)
        expect(spanDays(r.from, r.to)).toBe(ethiopianMonthLength(year, m))
        expect(isoToEthiopian(r.from)).toEqual({ year, month: m, day: 1 })
        expect(isoToEthiopian(r.to)).toEqual({ year, month: m, day: ethiopianMonthLength(year, m) })
        next = addDays(r.to, 1)
      }
      expect(isoToEthiopian(next)).toEqual({ year: year + 1, month: 1, day: 1 })
    }
  })
  it('refuses an invalid month', () => {
    expect(() => ethiopianMonthRange(2018, 14)).toThrow()
    expect(() => ethiopianMonthRange(2018, 0)).toThrow()
  })
})

describe('weeks and days', () => {
  it('a week runs Monday to Sunday', () => {
    expect(weekRange('2026-10-12')).toEqual({ from: '2026-10-12', to: '2026-10-18' }) // a Monday
    expect(weekRange('2026-10-14')).toEqual({ from: '2026-10-12', to: '2026-10-18' })
    expect(weekRange('2026-10-18')).toEqual({ from: '2026-10-12', to: '2026-10-18' }) // a Sunday
  })
  it('a week can straddle the Gregorian new year', () => {
    expect(weekRange('2026-01-01')).toEqual({ from: '2025-12-29', to: '2026-01-04' })
  })
  it('day arithmetic crosses months and leap days', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01')
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31')
    expect(spanDays('2026-01-01', '2026-12-31')).toBe(365)
  })
  it('validates calendar dates', () => {
    expect(isIsoDate('2026-02-28')).toBe(true)
    expect(isIsoDate('2026-02-29')).toBe(false)
    expect(isIsoDate('2026-13-01')).toBe(false)
    expect(isIsoDate('26-01-01')).toBe(false)
  })
})

describe('periods', () => {
  it('default periods around today', () => {
    expect(periodRange(defaultPeriod('daily', '2026-10-14'))).toEqual({
      from: '2026-10-14',
      to: '2026-10-14',
    })
    expect(periodRange(defaultPeriod('weekly', '2026-10-14'))).toEqual({
      from: '2026-10-12',
      to: '2026-10-18',
    })
    expect(defaultPeriod('monthly', '2026-10-14')).toEqual({ kind: 'monthly', year: 2019, month: 2 })
    expect(defaultPeriod('custom', '2026-10-14')).toEqual({
      kind: 'custom',
      from: '2026-10-12',
      to: '2026-10-14',
    })
  })
  it('previous / next', () => {
    expect(shiftPeriod({ kind: 'daily', date: '2026-10-01' }, -1)).toEqual({
      kind: 'daily',
      date: '2026-09-30',
    })
    expect(periodRange(shiftPeriod({ kind: 'weekly', date: '2026-10-14' }, 1))).toEqual({
      from: '2026-10-19',
      to: '2026-10-25',
    })
    expect(shiftPeriod({ kind: 'monthly', year: 2018, month: 12 }, 1)).toEqual({
      kind: 'monthly',
      year: 2018,
      month: 13,
    })
    expect(shiftPeriod({ kind: 'monthly', year: 2018, month: 13 }, 1)).toEqual({
      kind: 'monthly',
      year: 2019,
      month: 1,
    })
    expect(shiftPeriod({ kind: 'monthly', year: 2019, month: 1 }, -1)).toEqual({
      kind: 'monthly',
      year: 2018,
      month: 13,
    })
    expect(shiftPeriod({ kind: 'custom', from: '2026-10-01', to: '2026-10-03' }, 1)).toEqual({
      kind: 'custom',
      from: '2026-10-04',
      to: '2026-10-06',
    })
  })
  it('labels: Ethiopian first (Arabic numerals), Gregorian second', () => {
    expect(periodLabel({ kind: 'daily', date: '2026-09-23' })).toEqual({
      ethiopian: '13 መስከረም 2019',
      gregorian: '2026-09-23',
    })
    expect(periodLabel({ kind: 'monthly', year: 2018, month: 13 })).toEqual({
      ethiopian: 'ጳጉሜ 2018',
      gregorian: '2026-09-06 – 2026-09-10',
    })
    const w = periodLabel({ kind: 'weekly', date: '2026-09-23' })
    expect(w.ethiopian).toBe('11 መስከረም 2019 – 17 መስከረም 2019')
    expect(w.ethiopian).not.toMatch(/[፩-፼]/) // no Ge'ez numerals
  })
  it('custom range: both dates, in order, at most 366 days', () => {
    expect(parseCustomRange('2026-01-01', '2026-12-31')).toEqual({
      ok: true,
      range: { from: '2026-01-01', to: '2026-12-31' },
    })
    expect(parseCustomRange('2027-01-01', '2028-01-01')).toMatchObject({ ok: true }) // 366 days
    expect(parseCustomRange('2027-01-01', '2028-01-02')).toEqual({
      ok: false,
      error: 'A report covers at most 366 days.',
    })
    expect(parseCustomRange('2026-05-02', '2026-05-01')).toEqual({
      ok: false,
      error: 'The end date must not be before the start date.',
    })
    expect(parseCustomRange('', '2026-05-01')).toEqual({ ok: false, error: 'Choose both dates.' })
  })
  it('today in the tenant time zone', () => {
    const at = new Date('2026-10-11T22:30:00Z') // 01:30 on the 12th in Addis Ababa
    expect(todayIn('Africa/Addis_Ababa', at)).toBe('2026-10-12')
    expect(todayIn('Not/AZone', at)).toBe('2026-10-12')
  })
})

describe('parseEthiopianYear (the month picker year field)', () => {
  it('accepts whole 4-digit years in range only', () => {
    expect(parseEthiopianYear(' 2018 ')).toBe(2018)
    expect(parseEthiopianYear(String(MIN_ETH_YEAR))).toBe(MIN_ETH_YEAR)
    expect(parseEthiopianYear(String(MAX_ETH_YEAR))).toBe(MAX_ETH_YEAR)
    for (const bad of ['', '20', '201', '1989', '2101', '2018.5', '2e3', 'abcd', '-2018', '20180']) expect(parseEthiopianYear(bad)).toBeNull()
  })
})
