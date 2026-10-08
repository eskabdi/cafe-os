#!/usr/bin/env node
/**
 * Scans src/ and supabase/migrations for patterns the project forbids
 * (execution prompt hard rules, see CLAUDE.md). Wired into `pnpm lint`.
 * Pure `scanText` is exported for unit tests.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Files allowed to use localStorage/sessionStorage (per-viewer UI prefs, the Supabase client's own session storage, the kiosk device token). */
export const LOCAL_STORAGE_ALLOWLIST = [
  'src/lib/utils/ui-prefs.ts',
  'src/lib/supabase/client.ts',
  'src/lib/utils/kiosk-token.ts',
]

/** The only role literals the client/DB may hardcode (CLAUDE.md: two hardcoded system roles). */
export const SYSTEM_ROLE_LITERALS = ['tenant_admin', 'platform_super_admin']

/** SQL seed-data region markers (comments). Everything between is exempt from the name-literal SQL rules. */
export const SEED_MARKER_START = '-- forbidden-patterns: allow-seed-data'
export const SEED_MARKER_END = '-- forbidden-patterns: end'

/** Functions whose body legitimately seeds default tenant rows (auto-exempt from name-literal SQL rules). */
export const SEED_FUNCTIONS = ['fn_seed_tenant_defaults']

/** Literal names of the six dynamic domains, by domain. Used to catch business logic keyed on names. */
export const DOMAIN_NAMES = {
  station: ['kitchen', 'bar', 'pastry', 'grill', 'juice', 'barista'],
  payment: ['cash', 'telebirr', 'cbe', 'cbe birr', 'amole', 'chapa', 'card', 'bank transfer', 'mobile money'],
  area: ['indoor', 'outdoor', 'terrace', 'patio', 'rooftop', 'garden', 'main hall', 'vip'],
  category: [
    'desserts',
    'drinks',
    'beverages',
    'starters',
    'mains',
    'appetizers',
    'breakfast',
    'lunch',
    'dinner',
  ],
  expense: ['rent', 'utilities', 'salaries', 'supplies', 'maintenance', 'transport', 'marketing'],
  role: ['waiter', 'cashier', 'chef', 'manager', 'runner', 'host', 'bartender'],
}
const ALL_DOMAIN_NAMES = Object.values(DOMAIN_NAMES).flat()

const DOMAIN_TYPE_NAME =
  /(station|category|categories|pay_?method|payment_?method|table_?area|expense_?category|staff_?role)/i
const DOMAIN_TABLES = 'stations|categories|payment_methods|table_areas|expense_categories|roles'

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const alt = (names) => names.map(esc).join('|')
const Q = '["\'`]'
const isSystemRole = (lit) => SYSTEM_ROLE_LITERALS.includes(lit.toLowerCase())

/** `=== 'name'`, `'name' ===`, `case 'name':` for a set of names. */
function comparisonRule(names) {
  const a = alt(names)
  return regexTest(
    new RegExp(`(?:[!=]==?\\s*|\\bcase\\s+)${Q}(?:${a})${Q}|${Q}(?:${a})${Q}\\s*[!=]==?`, 'gi'),
  )
}

const TS_DOMAIN_COMPARISON = [
  ['hardcoded-station-name', 'station', 'Stations are UUID rows; never branch on their names.'],
  ['hardcoded-payment-method-name', 'payment', 'Payment methods are UUID rows; never branch on their names.'],
  ['hardcoded-area-name', 'area', 'Table areas are UUID rows; never branch on their names.'],
  ['hardcoded-category-name', 'category', 'Categories are UUID rows; never branch on their names.'],
  [
    'hardcoded-expense-category-name',
    'expense',
    'Expense categories are UUID rows; never branch on their names.',
  ],
  [
    'hardcoded-role-name',
    'role',
    'Roles are UUID rows (only tenant_admin / platform_super_admin are system roles); use permissions.',
  ],
].map(([id, key, why]) => ({
  id,
  scope: 'ts',
  skipTests: true,
  message: `Hardcoded ${key}-name comparison. ${why}`,
  test: comparisonRule(DOMAIN_NAMES[key]),
}))

/** @type {Array<{id:string, scope:'ts'|'sql', skipTests?:boolean, seedExempt?:boolean, message:string, test:(text:string, file:string)=>Array<{index:number, match:string}>}>} */
export const RULES = [
  {
    id: 'sql-enum-dynamic-domain',
    scope: 'sql',
    message:
      'PG enum for a dynamic tenant domain (station, category, payment method, table area, expense category, staff role). Use a relational table keyed by UUID.',
    test(text) {
      const out = []
      const re = /create\s+type\s+(?:"?[\w]+"?\.)?"?([\w]+)"?\s+as\s+enum/gi
      for (const m of text.matchAll(re)) {
        if (DOMAIN_TYPE_NAME.test(m[1] ?? '')) out.push({ index: m.index ?? 0, match: m[0] })
      }
      return out
    },
  },
  {
    id: 'sql-name-literal-comparison',
    scope: 'sql',
    seedExempt: true,
    message:
      "Business logic keyed on a domain row name (name = '<literal>' / lower(name) = ...). Domain rows are identified by UUID, never by name.",
    test(text) {
      const out = []
      const tbl = new RegExp(`\\b(?:public\\.)?(?:${DOMAIN_TABLES})\\b`, 'i')
      const cmp =
        /(?:\b(?:lower|upper)\s*\(\s*)?(?:\b\w+\.)?\bname\b\s*\)?\s*(?:=|<>|!=|~~\*?|\bi?like\b|\bin\s*\()\s*\(?\s*(?:lower\s*\(\s*)?'([^']*)'/gi
      const rev = /'([^']*)'\s*(?:=|<>|!=)\s*(?:\b(?:lower|upper)\s*\(\s*)?(?:\b\w+\.)?\bname\b/gi
      for (const st of statements(text)) {
        if (!tbl.test(st.text)) continue
        for (const re of [cmp, rev]) {
          for (const m of st.text.matchAll(re)) {
            if (isSystemRole(m[1] ?? '')) continue
            out.push({ index: st.start + (m.index ?? 0), match: m[0] })
          }
        }
      }
      return out
    },
  },
  {
    id: 'sql-domain-literal-list',
    scope: 'sql',
    seedExempt: true,
    message:
      "Literal list of domain names (check (... in ('kitchen','cash',...)) / in ('bar','pastry')). Domains are relational rows; do not enumerate their names.",
    test(text) {
      const out = []
      const names = new Set(ALL_DOMAIN_NAMES)
      const re = /\bin\s*\(\s*('(?:[^']*)'(?:\s*,\s*'(?:[^']*)')*)\s*\)/gi
      for (const st of statements(text)) {
        const inCheck = /\bcheck\s*\(/i.test(st.text)
        for (const m of st.text.matchAll(re)) {
          const lits = [...(m[1] ?? '').matchAll(/'([^']*)'/g)].map((x) => (x[1] ?? '').toLowerCase())
          const hits = lits.filter((l) => names.has(l))
          if (hits.length >= 2 || (inCheck && hits.length >= 1)) {
            out.push({ index: st.start + (m.index ?? 0), match: m[0] })
          }
        }
      }
      return out
    },
  },
  {
    id: 'sql-case-when-name',
    scope: 'sql',
    seedExempt: true,
    message:
      "case when ... name = '<literal>' branches on a domain row name. Branch on ids/flags/columns instead.",
    test(text) {
      const out = []
      const re = /\bcase\s+(?:when\b[^;]*?\bname\b\s*(?:=|<>|!=)\s*|(?:\w+\.)?name\s+when\s+)'([^']*)'/gi
      for (const m of text.matchAll(re)) {
        if (isSystemRole(m[1] ?? '')) continue
        out.push({ index: m.index ?? 0, match: m[0] })
      }
      return out
    },
  },
  {
    id: 'sql-hardcoded-domain-name-in-function',
    scope: 'sql',
    seedExempt: true,
    message:
      'Hardcoded domain name literal inside a function body. Only seed/provisioning default-seeding code may name domain rows (fn_seed_tenant_defaults or a `-- forbidden-patterns: allow-seed-data` region).',
    test(text) {
      const out = []
      const re = new RegExp(`'(?:${alt(ALL_DOMAIN_NAMES)})'`, 'gi')
      for (const body of functionBodies(text)) {
        for (const m of body.text.matchAll(re)) out.push({ index: body.start + (m.index ?? 0), match: m[0] })
      }
      return out
    },
  },
  {
    id: 'dangerously-set-inner-html',
    scope: 'ts',
    message: 'dangerouslySetInnerHTML is forbidden. Use React escaping.',
    test: regexTest(/dangerouslySetInnerHTML/g),
  },
  {
    id: 'inner-html',
    scope: 'ts',
    message: 'innerHTML / outerHTML / insertAdjacentHTML are forbidden (XSS with tenant data).',
    test: regexTest(/\b(?:innerHTML|outerHTML|insertAdjacentHTML)\b/g),
  },
  {
    id: 'document-write',
    scope: 'ts',
    message: 'document.write / document.writeln are forbidden (XSS, blocks parsing).',
    test: regexTest(/\bdocument\s*\.\s*write(?:ln)?\s*\(/g),
  },
  {
    id: 'eval',
    scope: 'ts',
    message: 'eval() is forbidden (code injection).',
    test: regexTest(/(?<![\w$.])eval\s*\(|\bwindow\s*\.\s*eval\s*\(/g),
  },
  {
    id: 'new-function',
    scope: 'ts',
    message: 'new Function(...) is forbidden (code injection).',
    test: regexTest(/\bnew\s+Function\s*\(/g),
  },
  {
    id: 'local-storage',
    scope: 'ts',
    message: `localStorage / sessionStorage are only allowed in: ${LOCAL_STORAGE_ALLOWLIST.join(', ')}. Never use them as a domain database.`,
    test(text, file) {
      if (LOCAL_STORAGE_ALLOWLIST.includes(normalize(file))) return []
      return regexTest(/\b(?:localStorage|sessionStorage)\b/g)(text)
    },
  },
  {
    id: 'service-role-in-client',
    scope: 'ts',
    message: 'service_role / SERVICE_ROLE must never appear in src/ (browser code).',
    // `(?<!is_)` exempts the generated SQL helper name `is_service_role` (no key/secret) in src/lib/supabase/types.ts.
    test: regexTest(/(?<!is_)service_role/gi),
  },
  {
    id: 'name-keyed-map',
    scope: 'ts',
    message:
      'Name-keyed colour/icon/label maps are forbidden. Presentation (color, icon) lives on the DB row.',
    test: regexTest(
      /\b(?:STATION|CATEGORY|ROLE|PAYMENT|PAY_METHOD|PAYMENT_METHOD|TABLE_AREA|EXPENSE_CATEGORY)_(?:COLORS?|ICONS?|LABELS?)\b|\b(?:station|category|role|payment|paymentMethod|tableArea|expenseCategory)(?:Colors?|Icons?|Labels?)\b/g,
    ),
  },
  {
    id: 'domain-name-keyed-object',
    scope: 'ts',
    skipTests: true,
    message:
      "Object/map keyed by a domain name ({ kitchen: ... }, map['cash']). Key by UUID and read presentation from the row.",
    test(text) {
      const a = alt(ALL_DOMAIN_NAMES)
      const key = new RegExp(
        `(?:[{,]|^)[ \\t]*(?:${Q}(?:${a})${Q}|(?:${a.replace(/ /g, '_')}))[ \\t]*:(?!:)`,
        'gim',
      )
      const idx = new RegExp(`\\[\\s*${Q}(?:${a})${Q}\\s*\\]`, 'gi')
      return [...text.matchAll(key), ...text.matchAll(idx)].map((m) => ({
        index: m.index ?? 0,
        match: m[0].trim(),
      }))
    },
  },
  ...TS_DOMAIN_COMPARISON,
]

function regexTest(re) {
  return (text) => [...text.matchAll(re)].map((m) => ({ index: m.index ?? 0, match: m[0] }))
}

function normalize(file) {
  return file.split(path.sep).join('/').replace(/^\.\//, '')
}

function stripSqlComments(text) {
  // Replace comments with same-length whitespace so line numbers stay correct.
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
    .replace(/--[^\n]*/g, (c) => ' '.repeat(c.length))
}

/** Blank out [start,end) ranges, preserving newlines so line numbers stay correct. */
function mask(text, ranges) {
  if (ranges.length === 0) return text
  const chars = text.split('')
  for (const [s, e] of ranges)
    for (let i = s; i < e && i < chars.length; i++) if (chars[i] !== '\n') chars[i] = ' '
  return chars.join('')
}

/** Ranges of `-- forbidden-patterns: allow-seed-data` ... `-- forbidden-patterns: end` regions (from RAW text). */
export function seedRegions(raw) {
  const ranges = []
  let from = -1
  let pos = 0
  for (const line of raw.split('\n')) {
    const trimmed = line.trim().toLowerCase()
    if (trimmed.startsWith(SEED_MARKER_START)) from = pos
    else if (trimmed.startsWith(SEED_MARKER_END) && from >= 0) {
      ranges.push([from, pos + line.length])
      from = -1
    }
    pos += line.length + 1
  }
  // An unterminated region is NOT silently exempt to EOF: it ends at the next marker or is ignored.
  return ranges
}

/** Bodies of `create function ... as $tag$ ... $tag$` (start offsets into `text`). */
function functionBodies(text) {
  const out = []
  const re = /create\s+(?:or\s+replace\s+)?function\s+([\w."]+)[\s\S]*?(\$[\w]*\$)/gi
  let m
  while ((m = re.exec(text))) {
    const tag = m[2]
    const bodyStart = m.index + m[0].length
    const close = text.indexOf(tag, bodyStart)
    if (close < 0) break
    out.push({
      name: (m[1] ?? '').replace(/"/g, ''),
      start: bodyStart,
      end: close,
      text: text.slice(bodyStart, close),
    })
    re.lastIndex = close + tag.length
  }
  return out
}

/** `;`-separated chunks with their offsets (good enough for statement-scoped heuristics, also inside $$ bodies). */
function statements(text) {
  const out = []
  let start = 0
  for (const part of text.split(';')) {
    out.push({ start, text: part })
    start += part.length + 1
  }
  return out
}

/** Ranges (in `text`) of the bodies of default-seeding functions. */
function seedFunctionRanges(text) {
  return functionBodies(text)
    .filter((f) => SEED_FUNCTIONS.some((n) => f.name.toLowerCase().endsWith(n)))
    .map((f) => [f.start, f.end])
}

function normalizeAllow(list) {
  return (list ?? []).map((e, i) => {
    if (!e || typeof e.file !== 'string' || typeof e.rule !== 'string' || !String(e.reason ?? '').trim()) {
      throw new Error(
        `forbidden-patterns.allow.json entry #${i} needs "file", "rule" and a non-empty "reason"`,
      )
    }
    return e
  })
}

function isTestFile(f) {
  return /\.test\.[cm]?[jt]sx?$/.test(f) || f.startsWith('tests/') || f.includes('/tests/')
}

function lineOf(text, index) {
  let line = 1
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++
  return line
}

/**
 * @param {string} file repo-relative path (decides scope)
 * @param {string} text file contents
 * @param {Array<{file:string, rule:string, match?:string, reason:string}>} [allow] documented exemptions
 * @returns {Array<{file:string, line:number, rule:string, message:string, match:string}>}
 */
export function scanText(file, text, allow = []) {
  const f = normalize(file)
  const scope = f.endsWith('.sql') ? 'sql' : 'ts'
  const body = scope === 'sql' ? stripSqlComments(text) : text
  // Name-literal SQL rules skip seed regions (markers read from the raw text) and default-seeding functions.
  const seedBody = scope === 'sql' ? mask(body, [...seedRegions(text), ...seedFunctionRanges(body)]) : body
  const allowed = normalizeAllow(allow).filter((a) => normalize(a.file) === f)
  const violations = []
  for (const rule of RULES) {
    if (rule.scope !== scope) continue
    if (rule.skipTests && isTestFile(f)) continue
    const src = rule.seedExempt ? seedBody : body
    for (const hit of rule.test(src, f)) {
      if (
        allowed.some(
          (a) => a.rule === rule.id && (!a.match || hit.match.toLowerCase().includes(a.match.toLowerCase())),
        )
      )
        continue
      violations.push({
        file: f,
        line: lineOf(src, hit.index),
        rule: rule.id,
        message: rule.message,
        match: hit.match,
      })
    }
  }
  return violations
}

const TS_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.html'])

function* walk(dir) {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else yield full
  }
}

export function scanRepo(root) {
  const violations = []
  const allowPath = path.join(root, 'scripts/forbidden-patterns.allow.json')
  const allow = fs.existsSync(allowPath) ? (JSON.parse(fs.readFileSync(allowPath, 'utf8')).entries ?? []) : []
  const targets = [
    { dir: 'src', accept: (p) => TS_EXT.has(path.extname(p)) },
    { dir: 'supabase/migrations', accept: (p) => p.endsWith('.sql') },
    {
      dir: 'supabase',
      accept: (p) => path.basename(p) === 'seed.sql' && path.dirname(p).endsWith('supabase'),
    },
  ]
  let scanned = 0
  for (const { dir, accept } of targets) {
    for (const file of walk(path.join(root, dir))) {
      if (!accept(file)) continue
      scanned++
      violations.push(...scanText(path.relative(root, file), fs.readFileSync(file, 'utf8'), allow))
    }
  }
  return { violations, scanned }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const { violations, scanned } = scanRepo(root)
  if (violations.length > 0) {
    for (const v of violations) {
      console.error(`${v.file}:${v.line}  [${v.rule}]  ${v.message}\n    matched: ${v.match}`)
    }
    console.error(`\nforbidden-patterns: ${violations.length} violation(s) in ${scanned} file(s)`)
    process.exit(1)
  }
  console.log(`forbidden-patterns: OK (${scanned} files scanned)`)
}
