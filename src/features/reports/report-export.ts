import { csvLine, CSV_BOM, toCsv } from '@/lib/domain/reports-csv'
import type { PeriodLabel } from '@/lib/domain/reports-period'
import { RpcError } from '@/lib/supabase/rpc'
import { formatKpi, RESTRICTED_NOTICE, type ReportView } from './report-model'

/** What every export header shows (print, CSV, PDF). */
export interface ExportMeta {
  restaurantName: string
  slug: string
  from: string
  to: string
  period: PeriodLabel
  timezone: string
  logoUrl: string | null
}

export interface GeneratedAt {
  ethiopian: string
  international: string
}

/**
 * The whole report as one CSV file: a short header block, the key figures, then every table under its title. Amounts are
 * written as plain decimals (ETB); withheld sections carry the neutral notice, never data.
 */
export function reportToCsv(view: ReportView, meta: ExportMeta, generated: GeneratedAt): string {
  const head = [
    csvLine(['Restaurant', meta.restaurantName]),
    csvLine(['Report', view.title]),
    csvLine(['Period (Ethiopian)', meta.period.ethiopian]),
    csvLine(['Period (Gregorian)', meta.from, meta.to]),
    csvLine(['Generated', generated.ethiopian, generated.international]),
    csvLine(['Currency', 'ETB']),
  ]
  const parts = [head.join('\r\n') + '\r\n']
  if (view.kpis.length > 0) {
    parts.push(
      csvLine(['Key figures']) + '\r\n',
      toCsv(view.kpis, [{ header: 'Metric', value: (k) => k.label }, { header: 'Value', value: (k) => (k.value === null ? formatKpi(k) : k.value) }], {
        bom: false,
      }),
    )
  }
  for (const t of view.tables) {
    parts.push(csvLine([t.title]) + '\r\n')
    if (t.restricted) parts.push(csvLine([RESTRICTED_NOTICE]) + '\r\n')
    else parts.push(toCsv(t.rows, t.columns.map((c) => ({ header: c.header, value: (row: (typeof t.rows)[number]) => row[c.key] ?? null })), { bom: false }))
  }
  return CSV_BOM + parts.join('\r\n')
}

/** Saves a Blob through a temporary object URL (revoked right after the download starts). */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Safe, fixed copy for a refused export (no server text is ever shown). */
export function exportErrorMessage(e: unknown): string {
  const code = e instanceof RpcError ? e.code : ''
  if (code === 'permission_denied') return 'You do not have permission to export reports. Nothing was exported.'
  if (code === 'invalid_input') return 'This period cannot be exported. Nothing was exported.'
  if (code === 'tenant_suspended') return 'The restaurant is suspended. Nothing was exported.'
  return 'The export could not be recorded, so nothing was exported. Try again.'
}
