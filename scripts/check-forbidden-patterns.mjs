#!/usr/bin/env node
/**
 * Scans src/ and supabase/migrations for patterns the project forbids
 * (execution prompt hard rules, see CLAUDE.md). Wired into `pnpm lint`.
 * Pure `scanText` is exported for unit tests.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Files allowed to use localStorage (per-viewer UI prefs only). */
export const LOCAL_STORAGE_ALLOWLIST = ['src/lib/utils/ui-prefs.ts']

const DOMAIN_TYPE_NAME =
  /(station|category|categories|pay_?method|payment_?method|table_?area|expense_?category|staff_?role)/i
const STATION_NAMES = 'kitchen|bar|pastry|grill|juice|barista'

/** @type {Array<{id:string, scope:'ts'|'sql', message:string, test:(text:string, file:string)=>Array<{index:number, match:string}>}>} */
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
    id: 'local-storage',
    scope: 'ts',
    message: `localStorage is only allowed in: ${LOCAL_STORAGE_ALLOWLIST.join(', ')}. It is never a domain database.`,
    test(text, file) {
      if (LOCAL_STORAGE_ALLOWLIST.includes(normalize(file))) return []
      return regexTest(/\blocalStorage\b/g)(text)
    },
  },
  {
    id: 'service-role-in-client',
    scope: 'ts',
    message: 'service_role / SERVICE_ROLE must never appear in src/ (browser code).',
    test: regexTest(/service_role|SERVICE_ROLE/gi),
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
    id: 'hardcoded-station-name',
    scope: 'ts',
    message: 'Hardcoded station-name comparison. Stations are UUID rows; never branch on their names.',
    test: regexTest(
      new RegExp(
        `(?:[!=]==?\\s*|\\bcase\\s+)["'\`](?:${STATION_NAMES})["'\`]|["'\`](?:${STATION_NAMES})["'\`]\\s*[!=]==?`,
        'gi',
      ),
    ),
  },
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

function lineOf(text, index) {
  let line = 1
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++
  return line
}

/**
 * @param {string} file repo-relative path (decides scope)
 * @param {string} text file contents
 * @returns {Array<{file:string, line:number, rule:string, message:string, match:string}>}
 */
export function scanText(file, text) {
  const f = normalize(file)
  const scope = f.endsWith('.sql') ? 'sql' : 'ts'
  const body = scope === 'sql' ? stripSqlComments(text) : text
  const violations = []
  for (const rule of RULES) {
    if (rule.scope !== scope) continue
    for (const hit of rule.test(body, f)) {
      violations.push({
        file: f,
        line: lineOf(body, hit.index),
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
  const targets = [
    { dir: 'src', accept: (p) => TS_EXT.has(path.extname(p)) },
    { dir: 'supabase/migrations', accept: (p) => p.endsWith('.sql') },
  ]
  let scanned = 0
  for (const { dir, accept } of targets) {
    for (const file of walk(path.join(root, dir))) {
      if (!accept(file)) continue
      scanned++
      violations.push(...scanText(path.relative(root, file), fs.readFileSync(file, 'utf8')))
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
