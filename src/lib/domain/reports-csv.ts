// CSV export (RFC 4180) for the reports. Pure: builds the text only; the download is the caller's job.
//  * CRLF line endings, fields quoted when they contain a comma, quote, CR or LF; quotes doubled.
//  * UTF-8 byte-order mark first so Excel reads Amharic names correctly.
//  * CSV / formula injection: a TEXT cell starting with = + - @ TAB or CR is prefixed with ' so a spreadsheet never
//    evaluates tenant-entered data (OWASP). Numbers are written as plain decimals (no grouping, no exponent, no currency).

export const CSV_BOM = '﻿'

export type CsvCell = string | number | null | undefined

export interface CsvColumn<T> {
  header: string
  value: (row: T) => CsvCell
}

const FORMULA_START = /^[=+\-@\t\r]/

/** A finite number as a plain decimal ("1250.5", "-3", "0.125"): no exponent, no float noise beyond 6 decimals. */
export function plainDecimal(n: number): string {
  if (!Number.isFinite(n)) return ''
  const fixed = n.toFixed(6).replace(/\.?0+$/, '')
  return fixed === '-0' ? '0' : fixed
}

/** One field: numbers as plain decimals, text neutralised and quoted when needed. */
export function csvField(cell: CsvCell): string {
  if (cell === null || cell === undefined) return ''
  if (typeof cell === 'number') return plainDecimal(cell)
  const text = FORMULA_START.test(cell) ? `'${cell}` : cell
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function csvLine(cells: readonly CsvCell[]): string {
  return cells.map(csvField).join(',')
}

/** A table as CSV text (header row first). `bom` prepends the UTF-8 byte-order mark (once per file). */
export function toCsv<T>(
  rows: readonly T[],
  columns: readonly CsvColumn<T>[],
  opts: { bom?: boolean } = {},
): string {
  const lines = [
    csvLine(columns.map((c) => c.header)),
    ...rows.map((r) => csvLine(columns.map((c) => c.value(r)))),
  ]
  return `${opts.bom === false ? '' : CSV_BOM}${lines.join('\r\n')}\r\n`
}

const SAFE_PART = /[^a-z0-9-]+/g

/** "<slug>-<report>-<from>_<to>.csv" with every part reduced to [a-z0-9-] (no path or header injection). */
export function exportFilename(
  slug: string,
  report: string,
  from: string,
  to: string,
  ext: 'csv' | 'pdf',
): string {
  const clean = (s: string) =>
    s
      .toLowerCase()
      .replace(SAFE_PART, '-')
      .replace(/^-+|-+$/g, '') || 'x'
  return `${clean(slug)}-${clean(report)}-${clean(from)}_${clean(to)}.${ext}`
}
