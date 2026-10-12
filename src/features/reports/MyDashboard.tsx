import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/features/auth'
import { ErrorState, PageSkeleton } from '@/features/shell/states'
import { formatEtb } from '@/lib/domain/decimal'
import { periodRange, type Period } from '@/lib/domain/reports-period'
import { fetchTenantTimezone, paymentsKeys } from '@/lib/supabase/payments'
import {
  fetchMyDashboard,
  reportsKeys,
  subscribeToActivity,
  type MyDashboard as MyDashboardData,
} from '@/lib/supabase/reports'
import { HourlyChart, KpiTile } from './charts'
import { PeriodPicker } from './PeriodPicker'
import { useTenantToday } from './useTenantToday'

/** Coalesces a burst of Realtime events into one refetch (same as the main dashboard). */
const REFRESH_DEBOUNCE_MS = 400

const minutesText = (m: number | null) => (m === null ? '—' : `${m.toFixed(1)} min`)

function OwnOrdersSection({ w }: { w: NonNullable<MyDashboardData['own_orders']> }) {
  return (
    <section aria-labelledby="my-orders" className="space-y-3">
      <h2 id="my-orders" className="text-lg font-semibold text-ink">
        My orders
      </h2>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="my-waiter-kpis">
        <KpiTile label="Orders" value={String(w.order_count)} hint={`${w.open_count} open`} />
        <KpiTile
          label="My sales"
          value={formatEtb(w.sales_total)}
          hint={`unpaid ${formatEtb(w.unpaid_total)}`}
        />
        <KpiTile label="Average order" value={formatEtb(w.avg_order_value)} />
        <KpiTile
          label="Served"
          value={String(w.served_count)}
          hint={w.served_rate === null ? undefined : `${w.served_rate.toFixed(1)}% of orders taken`}
        />
        <KpiTile label="Cancelled" value={String(w.cancelled_count)} />
        <KpiTile label="Average time to serve" value={minutesText(w.avg_serve_minutes)} />
      </div>
      {w.order_count > 0 && <HourlyChart data={w.by_hour} title="My orders by hour" />}
    </section>
  )
}

function StationSection({ stations }: { stations: NonNullable<MyDashboardData['stations']> }) {
  return (
    <section aria-labelledby="my-stations" className="space-y-3">
      <h2 id="my-stations" className="text-lg font-semibold text-ink">
        My stations
      </h2>
      {stations.length === 0 ? (
        <p className="text-sm text-muted-foreground">No active station is assigned to your role.</p>
      ) : (
        stations.map((s) => (
          <div
            key={s.station_id}
            className="space-y-2"
            data-testid="my-station"
            data-station-id={s.station_id}
          >
            <h3 className="flex items-center gap-2 text-sm font-medium text-ink">
              <span
                aria-hidden="true"
                className="inline-block h-3 w-3 rounded-full border border-line"
                style={s.color ? { backgroundColor: s.color } : undefined}
              />
              {s.name}
            </h3>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
              <KpiTile label="Queue" value={String(s.queue)} hint="items not started" />
              <KpiTile label="In progress" value={String(s.in_progress)} />
              <KpiTile label="Ready" value={String(s.ready)} hint="waiting to be served" />
              <KpiTile label="Completed" value={String(s.completed)} hint="items in the period" />
              <KpiTile
                label="Average prep time"
                value={minutesText(s.avg_prep_minutes)}
                hint={`wait before start ${minutesText(s.avg_wait_minutes)}`}
              />
            </div>
          </div>
        ))
      )}
    </section>
  )
}

/**
 * Personal dashboard (docs/note.md task 2): the signed-in user's OWN figures from fn_my_dashboard, for today (tenant-local) or a
 * picked period. Live over Realtime (orders, payments and order lines) with query invalidation. No figure is computed here.
 */
export function MyDashboard({ ownOrders, ownStations }: { ownOrders: boolean; ownStations: boolean }) {
  const { context } = useAuth()
  const rid = context?.restaurant?.id ?? ''
  const qc = useQueryClient()
  const tz = useQuery({
    queryKey: paymentsKeys.timezone(rid),
    queryFn: fetchTenantTimezone,
    enabled: Boolean(rid),
    staleTime: 300_000,
  })
  const today = useTenantToday(tz.data ?? null)
  const [picked, setPicked] = useState<Period | null>(null)
  const period: Period = picked ?? { kind: 'daily', date: today }
  const range = periodRange(period)
  const q = useQuery({
    queryKey: reportsKeys.mine(rid, range.from, range.to),
    queryFn: () => fetchMyDashboard(range.from, range.to),
    enabled: Boolean(rid) && (tz.isSuccess || tz.isError),
  })
  useEffect(() => {
    if (!rid) return
    let t: ReturnType<typeof setTimeout> | undefined
    const off = subscribeToActivity(
      rid,
      () => {
        clearTimeout(t)
        t = setTimeout(
          () => void qc.invalidateQueries({ queryKey: reportsKeys.mine(rid) }),
          REFRESH_DEBOUNCE_MS,
        )
      },
      { items: ownStations },
    )
    return () => {
      clearTimeout(t)
      off()
    }
  }, [rid, qc, ownStations])

  return (
    <div className="space-y-4 p-4 lg:p-6">
      <div>
        <h1 className="text-2xl font-semibold text-ink">Dashboard</h1>
        <p className="text-sm text-muted-foreground">Your own figures for the selected period.</p>
      </div>
      <PeriodPicker value={period} today={today} onChange={setPicked} />
      {q.isPending ? (
        <PageSkeleton label="Loading the dashboard" />
      ) : q.isError ? (
        <ErrorState title="The dashboard could not be loaded" onRetry={() => void q.refetch()} />
      ) : (
        <>
          {q.data.day_count === 0 && (
            <p className="text-sm text-muted-foreground">No business day was opened in this period.</p>
          )}
          {ownOrders && q.data.own_orders && <OwnOrdersSection w={q.data.own_orders} />}
          {ownStations && q.data.stations && <StationSection stations={q.data.stations} />}
        </>
      )}
    </div>
  )
}
