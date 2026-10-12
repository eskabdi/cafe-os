import { FileDown, FileText, Printer } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { ExportFormat } from '@/lib/supabase/reports'

/** Print / CSV / PDF buttons. Rendered only with reports.export (UX); the server re-checks on fn_log_report_export. */
export function ExportBar({
  busy,
  error,
  note,
  onExport,
}: {
  busy: ExportFormat | null
  error: string | null
  note: string | null
  onExport: (f: ExportFormat) => void
}) {
  return (
    <div className="no-print space-y-2">
      <div role="group" aria-label="Export" className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" disabled={busy !== null} onClick={() => onExport('print')}>
          <Printer aria-hidden="true" className="h-4 w-4" />
          Print
        </Button>
        <Button type="button" variant="outline" disabled={busy !== null} onClick={() => onExport('csv')}>
          <FileText aria-hidden="true" className="h-4 w-4" />
          {busy === 'csv' ? 'Exporting…' : 'Export CSV'}
        </Button>
        <Button type="button" variant="outline" disabled={busy !== null} onClick={() => onExport('pdf')}>
          <FileDown aria-hidden="true" className="h-4 w-4" />
          {busy === 'pdf' ? 'Exporting…' : 'Export PDF'}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-status-error">
          {error}
        </p>
      )}
      {note && (
        <p role="status" className="text-xs text-muted-foreground">
          {note}
        </p>
      )}
    </div>
  )
}
