import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '@/features/auth'
import { ErrorState, PageSkeleton } from '@/features/shell/states'
import { periodLabel, periodRange, todayIn, type Period } from '@/lib/domain/reports-period'
import { fetchReportPeriod, periodReportKey, type ReportType } from '@/lib/supabase/reports'
import { RpcError } from '@/lib/supabase/rpc'
import { fetchTenantLogoUrl } from '@/lib/supabase/tenant-logo'
import { ExportBar } from './ExportBar'
import { PeriodPicker } from './PeriodPicker'
import { buildReportView, canExportView } from './report-model'
import type { ExportMeta } from './report-export'
import { ReportPanel } from './ReportPanel'
import { ReportPrintLayout } from './ReportPrintLayout'
import { ReportTabs } from './ReportTabs'
import { useReportExport } from './useReportExport'

const TENANT_TZ = 'Africa/Addis_Ababa'

/**
 * Reports: ten report types for a Daily / Weekly / Ethiopian-monthly / Custom period. Every figure comes from
 * fn_report_period; sections the caller may not see come back null and render a neutral notice. Print / CSV / PDF are
 * offered with reports.export and always audited (fn_log_report_export) before anything is produced.
 */
export function ReportsPage() {
  const { context, can } = useAuth()
  const rid = context?.restaurant?.id ?? ''
  const slug = context?.restaurant?.slug ?? ''
  const today = useMemo(() => todayIn(TENANT_TZ), [])
  const [period, setPeriod] = useState<Period>({ kind: 'daily', date: today })
  const [type, setType] = useState<ReportType>('summary')
  const range = periodRange(period)
  const canExport = can('reports.export')
  const exporter = useReportExport()

  const q = useQuery({
    queryKey: periodReportKey(rid, range.from, range.to),
    queryFn: () => fetchReportPeriod(range.from, range.to),
    enabled: Boolean(rid),
  })
  const logo = useQuery({
    queryKey: ['tenant-logo', slug],
    queryFn: () => fetchTenantLogoUrl(slug),
    enabled: canExport && Boolean(slug),
    staleTime: 5 * 60_000,
    retry: false,
  })

  const view = q.data ? buildReportView(type, q.data) : null
  const meta: ExportMeta | null = q.data
    ? {
        restaurantName: context?.restaurant?.name ?? '',
        slug,
        from: q.data.period.from,
        to: q.data.period.to,
        period: periodLabel(period),
        timezone: q.data.timezone,
        logoUrl: logo.data ?? null,
      }
    : null
  const periodError = q.error instanceof RpcError && q.error.code === 'invalid_input'

  return (
    <div className="space-y-4 p-4 lg:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h1 className="text-2xl font-semibold text-ink">Reports</h1>
        {canExport && view && meta && q.data && canExportView(type, q.data.restricted) && (
          <ExportBar
            busy={exporter.busy}
            error={exporter.error}
            note={exporter.note}
            onExport={(f) => void exporter.run(f, view, meta)}
          />
        )}
      </div>
      <PeriodPicker value={period} today={today} onChange={setPeriod} />
      <ReportTabs value={type} onChange={setType} />
      {q.isPending ? (
        <PageSkeleton label="Loading the report" />
      ) : q.isError ? (
        <ErrorState
          title={
            periodError
              ? 'This period cannot be reported (at most 366 days).'
              : 'The report could not be loaded'
          }
          onRetry={() => void q.refetch()}
        />
      ) : (
        view && <ReportPanel view={view} report={q.data} trend={period.kind !== 'daily'} />
      )}
      {exporter.printJob && <ReportPrintLayout {...exporter.printJob} />}
    </div>
  )
}
