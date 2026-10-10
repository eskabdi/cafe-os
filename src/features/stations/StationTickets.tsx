import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Bell, BellOff } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/features/auth'
import { orderErrorMessage } from '@/features/pos/order-errors'
import { EmptyState, ErrorState, PageSkeleton } from '@/features/shell/states'
import { ageBand, groupTickets, minutesSince, nextAction, type Ticket } from '@/lib/domain/kds'
import { fetchStationLines, kdsKey, setStationStatus, subscribeToStation } from '@/lib/supabase/kds'
import { cancelOrder } from '@/lib/supabase/orders'
import { armChime, chimeArmed, playChime, setSoundPreferred, soundPreferred } from '@/lib/utils/order-chime'

const AGE_CLASS = { ok: 'border-line', warning: 'border-status-warning', late: 'border-status-error' } as const
const STATUS_TEXT = { pending: 'New', preparing: 'In progress', ready: 'Ready' } as const
const ACTION_TEXT = { preparing: 'Start', ready: 'Ready' } as const

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
  const key = kdsKey(rid, stationId)
  const lines = useQuery({ queryKey: key, queryFn: () => fetchStationLines(stationId), enabled: Boolean(rid) })
  const [sound, setSound] = useState(() => soundPreferred() && chimeArmed())

  useEffect(() => {
    if (!rid) return
    return subscribeToStation(stationId, {
      onInsert: () => {
        if (soundPreferred()) playChime()
      },
      onChange: () => void qc.invalidateQueries({ queryKey: key }),
    })
    // key is derived from rid + stationId
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rid, stationId, qc])

  const advance = useMutation({
    mutationFn: (a: { orderId: string; status: 'preparing' | 'ready' }) => setStationStatus(a.orderId, stationId, a.status),
    onSettled: () => void qc.invalidateQueries({ queryKey: key }),
    onError: (e) => toast.error(orderErrorMessage(e)),
  })
  const cancel = useMutation({
    mutationFn: (orderId: string) => cancelOrder(orderId, 'cancelled at the station'),
    onSuccess: (r) => toast.success(`Order ${r.order_no} cancelled`),
    onSettled: () => void qc.invalidateQueries({ queryKey: key }),
    onError: (e) => toast.error(orderErrorMessage(e)),
  })

  const tickets = useMemo(() => groupTickets(lines.data ?? []), [lines.data])
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

  if (lines.isPending) return <PageSkeleton label="Loading tickets" />
  if (lines.isError) return <ErrorState title="Tickets could not be loaded" onRetry={() => void lines.refetch()} />

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
      {tickets.length === 0 ? (
        <EmptyState title="No open tickets" level={2}>
          New orders for this station appear here instantly.
        </EmptyState>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="Open tickets">
          <AnimatePresence initial={false}>
            {tickets.map((t: Ticket) => {
              const age = minutesSince(t.createdAt, now)
              const action = nextAction(t)
              const busy = (advance.isPending && advance.variables?.orderId === t.orderId) || (cancel.isPending && cancel.variables === t.orderId)
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
                      <p className="text-sm text-muted-foreground">
                        {t.tableLabel ? `Table ${t.tableLabel}` : t.orderType}
                      </p>
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
                      <Button className="flex-1" disabled={busy} onClick={() => advance.mutate({ orderId: t.orderId, status: action })}>
                        {ACTION_TEXT[action]}
                      </Button>
                    )}
                    {canCancel && t.status === 'pending' && (
                      <Button variant="outline" disabled={busy} onClick={() => cancel.mutate(t.orderId)}>
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
    </section>
  )
}
