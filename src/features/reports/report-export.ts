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
      toCsv(
        view.kpis,
        [
          { header: 'Metric', value: (k) => k.label },
          { header: 'Value', value: (k) => (k.value === null ? formatKpi(k) : k.value) },
        ],
        {
          bom: false,
        },
      ),
    )
  }
  for (const t of view.tables) {
    parts.push(csvLine([t.title]) + '\r\n')
    if (t.restricted) parts.push(csvLine([RESTRICTED_NOTICE]) + '\r\n')
    else
      parts.push(
        toCsv(
          t.rows,
          t.columns.map((c) => ({
            header: c.header,
            value: (row: (typeof t.rows)[number]) => row[c.key] ?? null,
          })),
          { bom: false },
        ),
      )
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

/** The print dialog waits at most this long for the logo (then prints without it rather than hanging). */
export const PRINT_LOGO_TIMEOUT_MS = 3000

/**
 * Resolves once the image is decoded, has failed, or after `timeoutMs`, whichever comes first; never rejects. Uses
 * img.decode() where available, the load / error events otherwise. A null image (no logo) resolves at once.
 */
export async function waitForImage(img: HTMLImageElement | null, timeoutMs = PRINT_LOGO_TIMEOUT_MS): Promise<void> {
  if (!img) return
  if (img.complete && img.naturalWidth > 0) return
  const settled: Promise<unknown> =
    typeof img.decode === 'function'
      ? img.decode().catch(() => undefined)
      : new Promise<void>((resolve) => {
          img.addEventListener('load', () => resolve(), { once: true })
          img.addEventListener('error', () => resolve(), { once: true })
        })
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs)
  })
  try {
    await Promise.race([settled, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** Safe, fixed copy for a refused export (no server text is ever shown). */
export function exportErrorMessage(e: unknown): string {
  const code = e instanceof RpcError ? e.code : ''
  if (code === 'permission_denied')
    return 'You do not have permission to export reports. Nothing was exported.'
  if (code === 'invalid_input') return 'This period cannot be exported. Nothing was exported.'
  if (code === 'tenant_suspended') return 'The restaurant is suspended. Nothing was exported.'
  if (code === 'rate_limited')
    return 'Too many exports in the last minute. Wait a minute and try again. Nothing was exported.'
  return 'The export could not be recorded, so nothing was exported. Try again.'
}
