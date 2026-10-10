import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Bell, BellOff } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useAuth } from '@/features/auth'
import { orderErrorMessage } from '@/features/pos/order-errors'
import { EmptyState, ErrorState, PageSkeleton } from '@/features/shell/states'
import { ageBand, groupTickets, minutesSince, nextAction, type Ticket } from '@/lib/domain/kds'
import { isTenantAdminRole } from '@/lib/domain/portal'
import { KDS_LIMIT, fetchStationLines, kdsKey, setStationStatus, subscribeToStation } from '@/lib/supabase/kds'
import { cancelOrder, fetchOpenDay, ordersKeys } from '@/lib/supabase/orders'
import { armChime, chimeArmed, onChimeStateChange, playChime, setSoundPreferred, soundPreferred } from '@/lib/utils/order-chime'

const AGE_CLASS = { ok: 'border-line', warning: 'border-status-warning', late: 'border-status-error' } as const
const STATUS_TEXT = { pending: 'New', preparing: 'In progress', ready: 'Ready' } as const
const ACTION_TEXT = { preparing: 'Start', ready: 'Ready' } as const
/** Lines of one order arrive as separate Realtime events: one chime and one refetch per burst. */
const BURST_MS = 250

/** Re-renders every 30 s so ticket ages stay current (a clock, not data polling: data arrives through Realtime). */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])
  return now
}

export function StationTickets({ stationId }: { stationId: string }) {
  const { context, can } = useAuth()
  const rid = context?.restaurant?.id ?? ''
  const qc = useQueryClient()
  const reduce = useReducedMotion()
  const now = useMinuteClock()
  const openDay = useQuery({
    queryKey: ordersKeys.openDay(rid),
    queryFn: fetchOpenDay,
    enabled: Boolean(rid),
    initialData: context?.open_day ?? null,
    refetchOnWindowFocus: true,
  })
  const dayId = openDay.data?.id ?? ''
  const key = kdsKey(rid, stationId, dayId)
  const lines = useQuery({ queryKey: key, queryFn: () => fetchStationLines(stationId, dayId), enabled: Boolean(rid && dayId) })
  const [sound, setSound] = useState(() => soundPreferred() && chimeArmed())
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const [confirmCancel, setConfirmCancel] = useState<Ticket | null>(null)
  const burst = useRef<{ timer: ReturnType<typeof setTimeout> | null; insert: boolean }>({ timer: null, insert: false })

  useEffect(() => {
    if (!rid) return
    const flush = () => {
      const b = burst.current
      if (b.insert && soundPreferred()) playChime()
      b.insert = false
      b.timer = null
      void qc.invalidateQueries({ queryKey: ['kds', rid, stationId] })
    }
    const schedule = (insert: boolean) => {
      const b = burst.current
      b.insert = b.insert || insert
      if (!b.timer) b.timer = setTimeout(flush, BURST_MS)
    }
    const off = subscribeToStation(stationId, {
      onInsert: () => schedule(true),
      onChange: () => schedule(false),
      // (re)joined after a drop: fetch whatever was fired meanwhile, and re-check the open day
      onSubscribed: () => {
        void qc.invalidateQueries({ queryKey: ['kds', rid, stationId] })
        void qc.invalidateQueries({ queryKey: ordersKeys.openDay(rid) })
      },
    })
    return () => {
      off()
      if (burst.current.timer) clearTimeout(burst.current.timer)
      burst.current = { timer: null, insert: false }
    }
  }, [rid, stationId, qc])

  // the button never claims sound the browser has suspended
  useEffect(() => onChimeStateChange(() => setSound(soundPreferred() && chimeArmed())), [sound])

  const withBusy = async (orderId: string, work: () => Promise<unknown>) => {
    setBusy((s) => new Set(s).add(orderId))
    try {
      await work()
    } catch (e) {
      toast.error(orderErrorMessage(e))
    } finally {
      setBusy((s) => {
        const n = new Set(s)
        n.delete(orderId)
        return n
      })
      void qc.invalidateQueries({ queryKey: ['kds', rid, stationId] })
    }
  }
  const advance = useMutation({ mutationFn: (a: { orderId: string; status: 'preparing' | 'ready' }) => setStationStatus(a.orderId, stationId, a.status) })
  const cancel = useMutation({ mutationFn: (orderId: string) => cancelOrder(orderId, 'cancelled at the station') })

  const tickets = useMemo(() => groupTickets(lines.data?.lines ?? []), [lines.data])
  const toggleSound = () => {
    if (sound) {
      setSoundPreferred(false)
      setSound(false)
      return
    }
    const ok = armChime()
    setSoundPreferred(true)
    setSound(ok)
    if (ok) playChime()
    else toast.error('Sound is not available on this device.')
  }

  if (openDay.isSuccess && !openDay.data) {
    return (
      <EmptyState title="No business day is open" level={2}>
        Tickets appear here once a manager opens the day.
      </EmptyState>
    )
  }
  if (!rid || openDay.isPending || lines.isPending) return <PageSkeleton label="Loading tickets" />
  if (lines.isError || openDay.isError)
    return <ErrorState title="Tickets could not be loaded" onRetry={() => void Promise.all([openDay.refetch(), lines.refetch()])} />

  // the server is the authority (has_station_access); the buttons appear only where they can succeed
  const operates = (context?.station_ids ?? []).includes(stationId) || isTenantAdminRole(context?.role)
  const canCancel = can('orders.cancel')
  return (
    <section aria-label="Tickets" className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {tickets.length} open {tickets.length === 1 ? 'ticket' : 'tickets'}
        </p>
        <Button variant="outline" onClick={toggleSound} aria-pressed={sound}>
          {sound ? <Bell aria-hidden="true" className="h-4 w-4" /> : <BellOff aria-hidden="true" className="h-4 w-4" />}
          {sound ? 'Sound on' : 'Turn sound on'}
        </Button>
      </div>
      {lines.data?.truncated && (
        <p role="status" className="rounded-md border border-status-warning bg-status-warning/10 p-2 text-sm text-ink">
          Showing the newest {KDS_LIMIT} lines. Finish or serve older tickets to see the rest.
        </p>
      )}
      {!operates && (
        <p className="text-sm text-muted-foreground">View only: this station is not assigned to your role.</p>
      )}
      {tickets.length === 0 ? (
        <EmptyState title="No open tickets" level={2}>
          New orders for this station appear here instantly.
        </EmptyState>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="Open tickets">
          <AnimatePresence initial={false}>
            {tickets.map((t: Ticket) => {
              const age = minutesSince(t.createdAt, now)
              const action = operates ? nextAction(t) : null
              const isBusy = busy.has(t.orderId)
              return (
                <motion.li
                  key={t.orderId}
                  layout={!reduce}
                  initial={reduce ? false : { opacity: 0, y: -12, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
                  transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                  className={`flex flex-col gap-3 rounded-card border-2 bg-white p-4 ${AGE_CLASS[ageBand(age)]}`}
                  data-testid="kds-ticket"
                  data-order-id={t.orderId}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-lg font-semibold text-ink">{t.orderNo}</p>
                      <p className="text-sm text-muted-foreground">{t.tableLabel ? `Table ${t.tableLabel}` : t.orderType}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-medium text-ink">{STATUS_TEXT[t.status]}</p>
                      <p className="text-xs tabular-nums text-muted-foreground">{age} min</p>
                    </div>
                  </div>
                  <ul className="space-y-1">
                    {t.lines.map((l) => (
                      <li key={l.id} className="text-ink">
                        <span className="font-semibold tabular-nums">{l.qty}×</span> {l.name}
                        {l.note && <span className="block text-sm italic text-muted-foreground">{l.note}</span>}
                      </li>
                    ))}
                  </ul>
                  <div className="mt-auto flex gap-2">
                    {action && (
                      <Button
                        className="flex-1"
                        disabled={isBusy}
                        onClick={() => void withBusy(t.orderId, () => advance.mutateAsync({ orderId: t.orderId, status: action }))}
                      >
                        {ACTION_TEXT[action]}
                      </Button>
                    )}
                    {/* the server cancels only a whole, untouched order: offer it only then */}
                    {canCancel && t.orderStatus === 'submitted' && t.status === 'pending' && (
                      <Button variant="outline" disabled={isBusy} onClick={() => setConfirmCancel(t)}>
                        Cancel
                      </Button>
                    )}
                  </div>
                </motion.li>
              )
            })}
          </AnimatePresence>
        </ul>
      )}
      <ConfirmDialog
        open={confirmCancel !== null}
        title={`Cancel order ${confirmCancel?.orderNo ?? ''}?`}
        description="The WHOLE order is cancelled, at every station, and its stock is returned. This cannot be undone."
        confirmLabel="Cancel the order"
        busy={confirmCancel ? busy.has(confirmCancel.orderId) : false}
        onConfirm={() => {
          const t = confirmCancel
          if (!t) return
          setConfirmCancel(null)
          void withBusy(t.orderId, async () => {
            const r = await cancel.mutateAsync(t.orderId)
            toast.success(`Order ${r.order_no} cancelled`)
          })
        }}
        onCancel={() => setConfirmCancel(null)}
      />
    </section>
  )
}
