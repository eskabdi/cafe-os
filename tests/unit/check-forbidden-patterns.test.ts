import { describe, expect, it } from 'vitest'
import { scanText } from '../../scripts/check-forbidden-patterns.mjs'

const rules = (file: string, text: string): string[] =>
  (scanText(file, text) as Array<{ rule: string }>).map((v) => v.rule)

describe('check-forbidden-patterns: SQL enums', () => {
  it.each([
    "create type station as enum ('kitchen');",
    "CREATE TYPE public.payment_method AS ENUM ('cash');",
    'create type "table_area" as enum (\'a\');',
    "create type expense_category as enum ('x');",
    "create type staff_role as enum ('x');",
    "create type pay_method as enum ('x');",
    "create type category_kind as enum ('x');",
  ])('flags %s', (sql) => {
    expect(rules('supabase/migrations/001.sql', sql)).toContain('sql-enum-dynamic-domain')
  })

  it('allows enums for non-dynamic domains and ignores comments', () => {
    expect(rules('supabase/migrations/001.sql', "create type order_status as enum ('open');")).toEqual([])
    expect(rules('supabase/migrations/001.sql', "-- create type station as enum ('a');")).toEqual([])
    expect(rules('supabase/migrations/001.sql', "/* create type station as enum ('a'); */")).toEqual([])
  })

  it('reports correct line numbers', () => {
    const v = scanText('supabase/migrations/001.sql', "select 1;\n\ncreate type station as enum ('a');")
    expect(v[0]?.line).toBe(3)
  })
})

describe('check-forbidden-patterns: client code', () => {
  it('flags dangerouslySetInnerHTML and innerHTML', () => {
    expect(rules('src/a.tsx', '<div dangerouslySetInnerHTML={{__html: x}} />')).toContain(
      'dangerously-set-inner-html',
    )
    expect(rules('src/a.ts', 'el.innerHTML = x')).toContain('inner-html')
  })

  it('flags localStorage outside the allowlist only', () => {
    expect(rules('src/features/x.ts', 'localStorage.setItem("a","b")')).toContain('local-storage')
    expect(rules('src/lib/utils/ui-prefs.ts', 'localStorage.setItem("a","b")')).toEqual([])
  })

  it('flags service_role in any casing', () => {
    expect(rules('src/a.ts', 'const k = import.meta.env.SERVICE_ROLE_KEY')).toContain(
      'service-role-in-client',
    )
    expect(rules('src/a.ts', "const r = 'service_role'")).toContain('service-role-in-client')
  })

  it.each([
    'const STATION_COLORS = {}',
    'ROLE_ICONS[role.name]',
    'PAYMENT_LABELS.cash',
    'const categoryColors = {}',
    'const stationIcons = new Map()',
  ])('flags name-keyed map: %s', (code) => {
    expect(rules('src/a.ts', code)).toContain('name-keyed-map')
  })

  it.each([
    'if (station.name === "kitchen") {}',
    "if (s.name !== 'bar') {}",
    "if ('pastry' === s.name) {}",
    "switch (x) { case 'grill': break }",
  ])('flags hardcoded station name: %s', (code) => {
    expect(rules('src/a.ts', code)).toContain('hardcoded-station-name')
  })

  it('does not flag clean code', () => {
    const clean = `
      const color = station.color
      if (station.id === selectedId) {}
      const label = 'Barcode'
      const x = status === 'open'
    `
    expect(rules('src/a.tsx', clean)).toEqual([])
  })

  it('does not apply SQL rules to TS or TS rules to SQL', () => {
    expect(rules('src/a.ts', "create type station as enum ('a')")).toEqual([])
    expect(rules('supabase/migrations/1.sql', 'select innerHTML')).toEqual([])
  })
})
