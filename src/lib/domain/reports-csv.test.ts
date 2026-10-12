import { describe, expect, it } from 'vitest'
import { CSV_BOM, csvField, exportFilename, plainDecimal, toCsv } from './reports-csv'

type Row = { name: string; amount: number | null }
const cols = [
  { header: 'Name', value: (r: Row) => r.name },
  { header: 'Amount', value: (r: Row) => r.amount },
]

describe('toCsv', () => {
  it('starts with a UTF-8 BOM, uses CRLF and keeps Amharic text intact', () => {
    const csv = toCsv<Row>([{ name: 'ቡና', amount: 45 }], cols)
    expect(csv.startsWith(CSV_BOM)).toBe(true)
    expect(csv).toBe(`${CSV_BOM}Name,Amount\r\nቡና,45\r\n`)
    expect(toCsv<Row>([], cols, { bom: false })).toBe('Name,Amount\r\n')
  })
  it('quotes commas, quotes and line breaks (RFC 4180)', () => {
    expect(csvField('a,b')).toBe('"a,b"')
    expect(csvField('say "hi"')).toBe('"say ""hi"""')
    expect(csvField('line1\nline2')).toBe('"line1\nline2"')
    expect(csvField('plain')).toBe('plain')
  })
  it('neutralises formula injection in text cells', () => {
    expect(csvField('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`)
    expect(csvField('+1')).toBe("'+1")
    expect(csvField('-2+3')).toBe("'-2+3")
    expect(csvField('@SUM(A1)')).toBe("'@SUM(A1)")
    expect(csvField('\tcmd')).toBe("'\tcmd")
    expect(csvField('\rcmd')).toBe(`"'\rcmd"`)
    expect(csvField('Coffee = good')).toBe('Coffee = good')
  })
  it('writes numbers as plain decimals (negative numbers are numbers, not formulas)', () => {
    expect(csvField(1250.5)).toBe('1250.5')
    expect(csvField(414)).toBe('414')
    expect(csvField(-3)).toBe('-3')
    expect(csvField(0.1 + 0.2)).toBe('0.3')
    expect(plainDecimal(1e-7)).toBe('0')
    expect(plainDecimal(12345678.25)).toBe('12345678.25')
    expect(csvField(null)).toBe('')
    expect(csvField(undefined)).toBe('')
  })
})

describe('exportFilename', () => {
  it('<slug>-<report>-<from>_<to>.<ext> with safe characters only', () => {
    expect(exportFilename('demo-cafe', 'payments', '2026-10-12', '2026-10-18', 'csv')).toBe('demo-cafe-payments-2026-10-12_2026-10-18.csv')
    expect(exportFilename('../Evil Name', 'x/y', '2026-10-12', '2026-10-12', 'pdf')).toBe('evil-name-x-y-2026-10-12_2026-10-12.pdf')
  })
})
