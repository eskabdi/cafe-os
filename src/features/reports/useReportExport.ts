import { useEffect, useState } from 'react'
import { formatEthiopianDateTime, formatInternationalDateTime } from '@/lib/domain/ethiopian-time'
import { exportFilename } from '@/lib/domain/reports-csv'
import { logReportExport, type ExportFormat } from '@/lib/supabase/reports'
import {
  downloadBlob,
  exportErrorMessage,
  reportToCsv,
  type ExportMeta,
  type GeneratedAt,
  waitForImage,
} from './report-export'
import type { ReportView } from './report-model'

export interface PrintJob {
  view: ReportView
  meta: ExportMeta
  generated: GeneratedAt
}

/**
 * Export flow: fn_log_report_export is called FIRST and must succeed (reports.export, audited server-side); only then is the
 * CSV / PDF built or the print dialog opened. A refused or failed log shows a fixed message and produces nothing.
 */
export function useReportExport() {
  const [busy, setBusy] = useState<ExportFormat | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [printJob, setPrintJob] = useState<PrintJob | null>(null)

  // the print layout is mounted first, then printed once its logo has loaded / failed (bounded wait), so the printout is
  // never missing a logo that was merely still loading; window.print() blocks until the dialog closes
  useEffect(() => {
    if (!printJob) return
    let cancelled = false
    const logo = document.querySelector<HTMLImageElement>('.report-print img.report-print-logo')
    void waitForImage(logo).then(() => {
      if (cancelled) return
      window.print()
      setPrintJob(null)
    })
    return () => {
      cancelled = true
    }
  }, [printJob])

  async function run(format: ExportFormat, view: ReportView, meta: ExportMeta): Promise<void> {
    if (busy) return
    setBusy(format)
    setError(null)
    setNote(null)
    let exportedAt: string
    try {
      exportedAt = (await logReportExport(view.type, meta.from, meta.to, format)).exported_at
    } catch (e) {
      setError(exportErrorMessage(e))
      setBusy(null)
      return
    }
    const generated: GeneratedAt = {
      ethiopian: formatEthiopianDateTime(exportedAt, meta.timezone),
      international: formatInternationalDateTime(exportedAt, meta.timezone),
    }
    try {
      if (format === 'csv') {
        const csv = reportToCsv(view, meta, generated)
        downloadBlob(
          new Blob([csv], { type: 'text/csv;charset=utf-8' }),
          exportFilename(meta.slug, view.type, meta.from, meta.to, 'csv'),
        )
      } else if (format === 'pdf') {
        const { renderReportPdf, FALLBACK_NOTE } = await import('./report-pdf')
        const pdf = await renderReportPdf(view, meta, generated)
        downloadBlob(pdf.blob, exportFilename(meta.slug, view.type, meta.from, meta.to, 'pdf'))
        if (!pdf.amharicFont) setNote(FALLBACK_NOTE)
      } else {
        setPrintJob({ view, meta, generated })
      }
    } catch {
      setError('The export could not be created. Try again.')
    } finally {
      setBusy(null)
    }
  }

  return { run, busy, error, note, printJob }
}
