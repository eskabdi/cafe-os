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
    expect(rules('src/lib/utils/kiosk-token.ts', 'localStorage.setItem("a","b")')).toEqual([])
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

const SQL = 'supabase/migrations/002_x.sql'

describe('check-forbidden-patterns: SQL name literals', () => {
  it.each([
    "select id from stations where name = 'Kitchen'",
    "select * from payment_methods pm where lower(pm.name) = 'cash'",
    "update public.roles set x = 1 where restaurant_id = r and name <> 'Waiter'",
    "delete from table_areas where name ilike 'garden'",
    "select * from categories c where c.name in ('Desserts')",
    "select 1 from expense_categories e where 'Rent' = e.name",
  ])('flags %s', (sql) => {
    expect(rules(SQL, sql)).toContain('sql-name-literal-comparison')
  })

  it('allows system role literals, id lookups and non-domain tables', () => {
    expect(rules(SQL, "select id from roles where name = 'tenant_admin'")).toEqual([])
    expect(rules(SQL, "select id from roles where name = 'platform_super_admin'")).toEqual([])
    expect(rules(SQL, 'select id from stations where id = $1')).toEqual([])
    expect(rules(SQL, "select * from restaurants where name = 'Kitchen Sink'")).toEqual([])
    expect(rules(SQL, "-- select id from stations where name = 'Kitchen'")).toEqual([])
  })

  it.each([
    "alter table t add constraint c check (kind in ('kitchen','pastry','bar'))",
    "create table t (m text check (m in ('cash','telebirr','card')))",
    "create table t (m text check (m in ('cash','other')))",
    "select 1 where x in ('bar','pastry')",
  ])('flags literal domain list: %s', (sql) => {
    expect(rules(SQL, sql)).toContain('sql-domain-literal-list')
  })

  it('allows literal lists of non-domain values', () => {
    expect(rules(SQL, "create table t (s text check (s in ('open','closed','void')))")).toEqual([])
    expect(rules(SQL, "select 1 where x in ('cash','open')")).toEqual([]) // one domain word, not in a check
  })

  it.each([
    "select case when s.name = 'Kitchen' then 1 else 0 end from stations s",
    "select case when name = 'Cash' then 1 end from x",
    "select case name when 'Cash' then 1 end from x",
  ])('flags case-when on name: %s', (sql) => {
    expect(rules(SQL, sql)).toContain('sql-case-when-name')
  })

  it('allows case-when on non-name columns and system roles', () => {
    expect(rules(SQL, "select case when status = 'open' then 1 end from x")).toEqual([])
    expect(rules(SQL, "select case when name = 'tenant_admin' then 1 end from x")).toEqual([])
  })

  const fn = (body: string, name = 'fn_do_thing') =>
    `create or replace function public.${name}() returns void language plpgsql as $$ begin ${body} end $$;`

  it('flags hardcoded domain names in functions', () => {
    expect(rules(SQL, fn("if v = 'Telebirr' then null; end if;"))).toContain(
      'sql-hardcoded-domain-name-in-function',
    )
  })

  it('does not flag domain-looking literals outside functions or in neutral function bodies', () => {
    expect(rules(SQL, "insert into t values ('Kitchen');")).toEqual([])
    expect(rules(SQL, fn("raise exception 'permission_denied';"))).toEqual([])
  })

  it('exempts fn_seed_tenant_defaults bodies but not other functions', () => {
    const seed = fn(
      "insert into stations(name) values ('Kitchen'), ('Bar'); perform 1 where name = 'Cash';",
      'fn_seed_tenant_defaults',
    )
    expect(rules(SQL, seed)).toEqual([])
    expect(rules(SQL, fn("insert into stations(name) values ('Kitchen');"))).toContain(
      'sql-hardcoded-domain-name-in-function',
    )
  })

  it('exempts marked seed-data regions only, and keeps line numbers', () => {
    const body = [
      'select 1;',
      '-- forbidden-patterns: allow-seed-data',
      "select id from stations where name = 'Kitchen';",
      '-- forbidden-patterns: end',
      "select id from stations where name = 'Bar';",
    ].join('\n')
    const v = scanText('supabase/seed.sql', body)
    expect(v).toHaveLength(1)
    expect(v[0]?.line).toBe(5)
  })

  it('does not let an unterminated marker exempt the rest of the file', () => {
    const body = "-- forbidden-patterns: allow-seed-data\nselect id from stations where name = 'Kitchen';"
    expect(rules('supabase/seed.sql', body)).toContain('sql-name-literal-comparison')
  })

  it('still enforces the enum rule inside seed regions', () => {
    const body =
      "-- forbidden-patterns: allow-seed-data\ncreate type station as enum ('a');\n-- forbidden-patterns: end"
    expect(rules('supabase/seed.sql', body)).toContain('sql-enum-dynamic-domain')
  })
})

describe('check-forbidden-patterns: TS domain names', () => {
  it.each([
    ["if (m.name === 'cash') {}", 'hardcoded-payment-method-name'],
    ["switch (x) { case 'telebirr': break }", 'hardcoded-payment-method-name'],
    ["if (a.name !== 'Terrace') {}", 'hardcoded-area-name'],
    ["if (c.name == 'Desserts') {}", 'hardcoded-category-name'],
    ["if (e.name === 'rent') {}", 'hardcoded-expense-category-name'],
    ["if (role === 'waiter') {}", 'hardcoded-role-name'],
    ["if ('cashier' === role.name) {}", 'hardcoded-role-name'],
    ["if (s.name === 'Kitchen') {}", 'hardcoded-station-name'],
  ])('flags %s', (code, rule) => {
    expect(rules('src/a.ts', code)).toContain(rule)
  })

  it.each([
    'const m = { kitchen: 1 }',
    "const m = { 'cash': 1 }",
    'const m = { a: 1, telebirr: 2 }',
    'const m = {\n  waiter: true,\n}',
    "const x = map['cash']",
    'type T = { cash: number }',
  ])('flags domain-name keyed object: %s', (code) => {
    expect(rules('src/a.ts', code)).toContain('domain-name-keyed-object')
  })

  it('exempts the two system roles', () => {
    expect(rules('src/a.ts', "if (role === 'tenant_admin') {}")).toEqual([])
    expect(rules('src/a.ts', "if (ctx.platform_role !== 'platform_super_admin') {}")).toEqual([])
    expect(rules('src/a.ts', 'const m = { tenant_admin: 1, platform_super_admin: 2 }')).toEqual([])
  })

  it('exempts test files', () => {
    expect(rules('src/a.test.ts', "expect(role === 'waiter')")).toEqual([])
    expect(rules('src/a.test.tsx', 'const m = { kitchen: 1 }')).toEqual([])
    expect(rules('tests/e2e/x.spec.ts', "if (x === 'cash') {}")).toEqual([])
  })

  it('does not flag unrelated code', () => {
    const clean = `
      const a = cond ? cash : other
      if (status === 'open') {}
      const label = 'Cash register'
      const x = { id: 1, name: 'x' }
      call(kitchen)
    `
    expect(rules('src/a.ts', clean)).toEqual([])
  })

  it('honours documented allowlist entries and requires a reason', () => {
    const allow = [{ file: 'src/a.ts', rule: 'hardcoded-role-name', reason: 'legacy bridge' }]
    expect(rules('src/a.ts', "if (role === 'waiter') {}")).toContain('hardcoded-role-name')
    expect(scanText('src/a.ts', "if (role === 'waiter') {}", allow)).toEqual([])
    expect(scanText('src/b.ts', "if (role === 'waiter') {}", allow)).toHaveLength(1)
    const narrow = [{ file: 'src/a.ts', rule: 'hardcoded-role-name', match: "'cashier'", reason: 'x' }]
    expect(scanText('src/a.ts', "if (role === 'waiter') {}", narrow)).toHaveLength(1)
    expect(() => scanText('src/a.ts', 'x', [{ file: 'src/a.ts', rule: 'r', reason: ' ' }])).toThrow(/reason/)
  })
})

describe('check-forbidden-patterns: injection and storage rules', () => {
  it.each([
    ['document.write("<p>")', 'document-write'],
    ['document . writeln(x)', 'document-write'],
    ['eval("1+1")', 'eval'],
    ['window.eval(x)', 'eval'],
    ['const f = new Function("a", "return a")', 'new-function'],
    ['el.outerHTML = x', 'inner-html'],
    ['el.insertAdjacentHTML("beforeend", x)', 'inner-html'],
    ['sessionStorage.setItem("a", "b")', 'local-storage'],
    ['window.localStorage.getItem("a")', 'local-storage'],
    ['const k = process.env.SUPABASE_SERVICE_ROLE_KEY', 'service-role-in-client'],
  ])('flags %s', (code, rule) => {
    expect(rules('src/features/x.ts', code)).toContain(rule)
  })

  it('allows storage only in the allowlisted files', () => {
    expect(rules('src/lib/utils/ui-prefs.ts', 'sessionStorage.getItem("a")')).toEqual([])
    expect(rules('src/lib/supabase/client.ts', 'const s = window.localStorage')).toEqual([])
    expect(rules('src/lib/supabase/other.ts', 'localStorage.clear()')).toContain('local-storage')
  })

  it('does not flag lookalikes', () => {
    expect(rules('src/a.ts', 'const retrieval = medieval(x); obj.evaluate(1)')).toEqual([])
    expect(rules('src/a.ts', 'const doc = document.getElementById("x"); writeLog()')).toEqual([])
    expect(rules('src/a.ts', 'const F = Function.prototype')).toEqual([])
  })
})

describe('check-forbidden-patterns: repository', () => {
  it('passes on the current repository', async () => {
    const { scanRepo } = await import('../../scripts/check-forbidden-patterns.mjs')
    const { violations } = scanRepo(process.cwd())
    expect(violations).toEqual([])
  })
})
