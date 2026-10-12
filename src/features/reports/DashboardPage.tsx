import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/features/auth'
import { ErrorState, PageSkeleton } from '@/features/shell/states'
import { formatEtb } from '@/lib/domain/decimal'
import { formatEthiopianDateTime, formatEthiopianTime, formatInternationalDateTime } from '@/lib/domain/ethiopian-time'
import { fetchDashboard, reportsKeys, subscribeToActivity, type Dashboard } from '@/lib/supabase/reports'
import { HourlyChart, KpiTile, RankedBars } from './charts'

// The order lifecycle is a fixed platform state machine (orders.status check constraint), not a tenant domain.
const STATUS_LABEL: Readonly<Record<string, string>> = {
  submitted: 'New',
  preparing: 'Preparing',
  ready: 'Ready',
  served: 'Served',
  cancelled: 'Cancelled',
}

/** Coalesces a burst of Realtime events into one refetch. */
const REFRESH_DEBOUNCE_MS = 400

function useLiveDashboard(rid: string) {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: reportsKeys.dashboard(rid), queryFn: fetchDashboard, enabled: Boolean(rid) })
  useEffect(() => {
    if (!rid) return
    let t: ReturnType<typeof setTimeout> | undefined
    const off = subscribeToActivity(rid, () => {
      clearTimeout(t)
      t = setTimeout(() => void qc.invalidateQueries({ queryKey: reportsKeys.dashboard(rid) }), REFRESH_DEBOUNCE_MS)
    })
    return () => {
      clearTimeout(t)
      off()
    }
  }, [rid, qc])
  return q
}

function RecentActivity({ d }: { d: Dashboard }) {
  return (
    <section aria-labelledby="dash-recent" className="rounded-lg border border-line bg-white p-4">
      <h2 id="dash-recent" className="mb-2 text-sm font-medium text-ink">
        Live activity
      </h2>
      {d.recent.length === 0 ? (
        <p className="text-sm text-muted-foreground">No orders yet today.</p>
      ) : (
        <ul className="divide-y divide-line text-sm" aria-label="Recent orders">
          {d.recent.map((o) => (
            <li key={o.id} className="flex items-center justify-between gap-2 py-2">
              <span className="min-w-0">
                <span className="font-medium text-ink">{o.order_no}</span>
                {o.table_label && <span className="ml-2 text-muted-foreground">{o.table_label}</span>}
                <span className="ml-2 font-amharic text-xs text-muted-foreground">{formatEthiopianTime(o.created_at, d.timezone)}</span>
              </span>
              <span className="shrink-0 text-right">
                <span className={o.status === 'cancelled' ? 'text-status-cancelled' : 'text-ink'}>{STATUS_LABEL[o.status] ?? o.status}</span>
                {o.total != null && <span className="ml-2 tabular-nums text-muted-foreground">{formatEtb(o.total)}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * Dashboard (Phase 8): the open business day, live over Realtime (orders / payments) with query invalidation, no polling.
 * Floor figures for everyone with dashboard.view; money figures only when the server includes them (reports.view). No figure is
 * computed here.
 */
export function DashboardPage() {
  const { context } = useAuth()
  const rid = context?.restaurant?.id ?? ''
  const q = useLiveDashboard(rid)

  if (q.isPending) return <PageSkeleton label="Loading the dashboard" />
  if (q.isError) return <ErrorState title="The dashboard could not be loaded" onRetry={() => void q.refetch()} />
  const d = q.data
  const by = d.orders_by_status
  const live = (by.submitted ?? 0) + (by.preparing ?? 0) + (by.ready ?? 0)

  return (
    <div className="space-y-4 p-4 lg:p-6">
      <div>
        <h1 className="text-2xl font-semibold text-ink">Dashboard</h1>
        {d.open_day ? (
          <p className="text-sm text-muted-foreground">
            Business day {d.open_day.day_no} is open since{' '}
            <span className="font-amharic">{formatEthiopianDateTime(d.open_day.opened_at, d.timezone)}</span>{' '}
            <span>({formatInternationalDateTime(d.open_day.opened_at, d.timezone)})</span>
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">No business day is open.</p>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="floor-kpis">
        <KpiTile label="Live orders" value={String(live)} hint={`${by.ready ?? 0} ready to serve`} />
        <KpiTile label="Served" value={String(by.served ?? 0)} />
        <KpiTile label="Cancelled" value={String(by.cancelled ?? 0)} />
        {d.low_stock_count != null && (
          <KpiTile label="Low stock" value={String(d.low_stock_count)} hint="ingredients at or below their minimum" />
        )}
      </div>
      {d.money && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="money-kpis">
          <KpiTile label="Collected" value={formatEtb(d.money.gross_collected)} hint={d.money.cash_collected === null ? undefined : `cash ${formatEtb(d.money.cash_collected)}`} />
          <KpiTile label="Sales" value={formatEtb(d.money.sales_total)} hint={`${d.money.order_count} orders`} />
          <KpiTile label="Average order" value={formatEtb(d.money.avg_order_value)} />
          <KpiTile label="Unpaid" value={formatEtb(d.money.unpaid_total)} />
        </div>
      )}
      {(d.by_hour || d.by_payment_method) && (
        <div className="grid gap-4 lg:grid-cols-2">
          {d.by_hour && <HourlyChart data={d.by_hour} title="Orders by hour" />}
          {d.by_payment_method && (
            <RankedBars
              title="Collected by payment method"
              rows={d.by_payment_method.map((m) => ({ key: m.payment_method_id, label: m.name, value: m.amount, detail: `×${m.count}` }))}
              valueLabel={formatEtb}
            />
          )}
        </div>
      )}
      <RecentActivity d={d} />
    </div>
  )
}
