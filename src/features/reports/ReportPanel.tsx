import { formatEtb } from '@/lib/domain/decimal'
import { ethiopianDateLabel, isIsoDate } from '@/lib/domain/reports-period'
import type { PeriodReport, ReportType } from '@/lib/supabase/reports'
import { DayTrendChart, HourlyChart, RankedBars, type RankedRow } from './charts'
import { REPORT_TITLES, type ReportView } from './report-model'
import { KpiGrid, ReportTableView } from './ReportTableView'
import { PANEL_ID, tabId } from './ReportTabs'

const top = (rows: RankedRow[], n = 10) => rows.slice(0, n)

/** The optional chart of a report type (one hue, one axis, an sr-only table); nothing for a withheld section. */
function ReportChart({ type, r, trend }: { type: ReportType; r: PeriodReport; trend: boolean }) {
  const blocked = (s: (typeof r.restricted)[number]) => r.restricted.includes(s)
  switch (type) {
    case 'summary':
    case 'revenue':
      if (!trend || !r.by_day) return null
      return (
        <DayTrendChart
          title="Sales trend"
          valueLabel={formatEtb}
          rows={r.by_day.map((d) => ({
            key: d.day_session_id,
            date: d.date,
            ethiopian: isIsoDate(d.date) ? ethiopianDateLabel(d.date) : d.date,
            value: d.sales,
          }))}
        />
      )
    case 'hourly':
      return r.by_hour ? <HourlyChart data={r.by_hour} title="Hourly orders" /> : null
    case 'payments':
      if (blocked('payments') || !r.by_payment_method) return null
      return (
        <RankedBars
          title="Payment method ranking"
          valueLabel={formatEtb}
          rows={r.by_payment_method.map((m) => ({
            key: m.payment_method_id,
            label: m.name,
            value: m.amount,
            detail: `×${m.count}`,
          }))}
        />
      )
    case 'staff':
      if (blocked('staff') || !r.by_waiter) return null
      return (
        <RankedBars
          title="Staff ranking"
          valueLabel={formatEtb}
          rows={top(
            r.by_waiter.map((w, i) => ({
              key: w.user_id ?? `none-${i}`,
              label: w.name ?? 'Unknown',
              value: w.sales,
              detail: `${w.orders} orders`,
            })),
          )}
        />
      )
    case 'expenses':
      if (blocked('expenses') || !r.by_expense_category) return null
      return (
        <RankedBars
          title="Expense ranking"
          valueLabel={formatEtb}
          rows={r.by_expense_category.map((e) => ({
            key: e.expense_category_id,
            label: e.name ?? '—',
            value: e.amount,
            detail: `×${e.count}`,
          }))}
        />
      )
    case 'items':
      if (!r.by_item) return null
      return (
        <RankedBars
          title="Top items"
          valueLabel={formatEtb}
          rows={top(
            r.by_item.map((i, n) => ({
              key: i.menu_item_id ?? `none-${n}`,
              label: i.name ?? '—',
              value: i.amount,
              detail: `${i.qty} sold`,
            })),
          )}
        />
      )
    default:
      return null
  }
}

/** One report type: KPIs, an optional chart and its tables, inside the tabpanel of the selected tab. */
export function ReportPanel({
  view,
  report,
  trend,
}: {
  view: ReportView
  report: PeriodReport
  trend: boolean
}) {
  return (
    <div
      role="tabpanel"
      id={PANEL_ID}
      aria-labelledby={tabId(view.type)}
      tabIndex={0}
      className="space-y-4 focus-visible:outline-none"
    >
      <h2 className="sr-only">{REPORT_TITLES[view.type]}</h2>
      <KpiGrid kpis={view.kpis} />
      <ReportChart type={view.type} r={report} trend={trend} />
      <div className="grid gap-4 xl:grid-cols-2">
        {view.tables.map((t) => (
          <ReportTableView key={t.id} t={t} className={t.columns.length > 4 ? 'xl:col-span-2' : undefined} />
        ))}
      </div>
    </div>
  )
}
