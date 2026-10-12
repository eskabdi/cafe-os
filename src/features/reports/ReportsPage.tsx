import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '@/features/auth'
import { ErrorState, PageSkeleton } from '@/features/shell/states'
import { formatEtb } from '@/lib/domain/decimal'
import { describeDays, type DayRange } from '@/lib/domain/reports'
import { fetchReport, reportsKeys, type Report } from '@/lib/supabase/reports'
import { HourlyChart, KpiTile, RankedBars } from './charts'
import { DayRangeForm } from './DayRangeForm'
import { InventorySection } from './InventorySection'

function ReportKpis({ k }: { k: Report['kpis'] }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="report-kpis">
      <KpiTile label="Collected" value={formatEtb(k.gross_collected)} hint={`cash ${formatEtb(k.cash_collected)}`} />
      <KpiTile label="Expenses" value={formatEtb(k.expenses_total)} />
      <KpiTile label="Net position" value={formatEtb(k.net_position)} hint="collected minus expenses" />
      <KpiTile label="Sales" value={formatEtb(k.sales_total)} hint={`${k.order_count} orders · ${k.items_sold} items`} />
      <KpiTile label="Average order" value={formatEtb(k.avg_order_value)} />
      <KpiTile label="Cancelled orders" value={String(k.cancelled_count)} />
      <KpiTile label="Unpaid" value={formatEtb(k.unpaid_total)} />
      <KpiTile label="Installments outstanding" value={formatEtb(k.vouchers_outstanding)} hint={`${k.vouchers_overdue} overdue vouchers`} />
    </div>
  )
}

function ReportBody({ r }: { r: Report }) {
  return (
    <>
      <p className="text-sm text-muted-foreground" data-testid="report-days">
        {describeDays(r.days, r.timezone)}
      </p>
      <ReportKpis k={r.kpis} />
      <div className="grid gap-4 lg:grid-cols-2">
        <HourlyChart data={r.by_hour} title="Orders by hour" />
        <RankedBars
          title="Collected by payment method"
          rows={r.by_payment_method.map((m) => ({ key: m.payment_method_id, label: m.name, value: m.amount, detail: `×${m.count}` }))}
          valueLabel={formatEtb}
        />
        <RankedBars
          title="Sales by category (before VAT)"
          rows={r.by_category.map((c, i) => ({
            key: c.category_id ?? `none-${i}`,
            label: c.name ?? 'Uncategorised',
            value: c.amount,
            detail: `${c.qty} sold`,
          }))}
          valueLabel={formatEtb}
        />
        <RankedBars
          title="Sales by staff"
          rows={r.by_waiter.map((w, i) => ({ key: w.user_id ?? `none-${i}`, label: w.name ?? 'Unknown', value: w.sales, detail: `${w.orders} orders` }))}
          valueLabel={formatEtb}
        />
        <RankedBars
          title="Expenses by category"
          rows={r.by_expense_category.map((e) => ({ key: e.expense_category_id, label: e.name ?? '—', value: e.amount, detail: `×${e.count}` }))}
          valueLabel={formatEtb}
        />
        <InventorySection inventory={r.inventory} />
      </div>
    </>
  )
}

/**
 * Reports (Phase 8): the current business day or a range of day numbers. All aggregations come from fn_report (the gate compares
 * them with a hand-calculated fixture); names are the rows' / snapshots', never known to the code.
 */
export function ReportsPage() {
  const { context } = useAuth()
  const rid = context?.restaurant?.id ?? ''
  const [range, setRange] = useState<DayRange>({ from: null, to: null })
  const q = useQuery({
    queryKey: reportsKeys.report(rid, range.from, range.to),
    queryFn: () => fetchReport(range.from, range.to),
    enabled: Boolean(rid),
  })

  return (
    <div className="space-y-4 p-4 lg:p-6">
      <h1 className="text-2xl font-semibold text-ink">Reports</h1>
      <DayRangeForm onApply={setRange} />
      {q.isPending ? (
        <PageSkeleton label="Loading the report" />
      ) : q.isError ? (
        <ErrorState title="The report could not be loaded" onRetry={() => void q.refetch()} />
      ) : (
        <ReportBody r={q.data} />
      )}
    </div>
  )
}
