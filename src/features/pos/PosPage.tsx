import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Minus, Plus, Search, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/select'
import { useAuth } from '@/features/auth'
import { EmptyState, ErrorState, PageSkeleton } from '@/features/shell/states'
import { addItem, itemCount, previewSubtotal, removeLine, setNote, setQty, toPayload, type Cart } from '@/lib/domain/cart'
import { formatEtb } from '@/lib/domain/decimal'
import { fetchMenuItems, menuItemsKey, subscribeToMenu } from '@/lib/supabase/menu'
import { errorCode } from '@/lib/supabase/menu-inventory-errors'
import {
  ORDER_TYPES,
  fetchDayOrders,
  fetchOpenDay,
  fetchTables,
  isFullOrder,
  ordersKeys,
  submitOrder,
  subscribeToOrders,
  type OrderType,
  type SubmitResult,
} from '@/lib/supabase/orders'
import { categoriesKey, fetchCategories } from '@/lib/supabase/reference-data'
import { orderErrorMessage } from './order-errors'

const ORDER_TYPE_LABEL: Record<OrderType, string> = { 'dine-in': 'Dine-in', takeaway: 'Takeaway', delivery: 'Delivery' }
const newKey = () => crypto.randomUUID()
/**
 * Answers that prove the order was NOT created (the database refused it). Anything else (network, timeout, gateway, unknown) is
 * ambiguous: the server MAY have committed it, so the same key must be resent before anything changes.
 */
const DEFINITIVE = new Set([
  'day_closed', 'insufficient_stock', 'item_unavailable', 'idempotency_conflict', 'invalid_state', 'invalid_input',
  'permission_denied', 'tenant_suspended', 'tenant_read_only', 'not_found', 'not_authenticated',
])

/**
 * Waiter POS (Phase 4). Categories and menu come from the tenant's rows (no name is known to the code); the cart is an intent
 * (item ids, quantities, notes). The server prices, adds VAT, numbers the order, routes lines to stations and consumes stock.
 * One idempotency key per cart: a retry after a network error returns the same order, never a second one.
 */
export function PosPage() {
  const { context } = useAuth()
  const rid = context?.restaurant?.id ?? ''
  const qc = useQueryClient()
  // the open day is re-read from the server (focus, retry, day_closed answers): a day opened after sign-in unlocks sending
  const openDayQuery = useQuery({
    queryKey: ordersKeys.openDay(rid),
    queryFn: fetchOpenDay,
    enabled: Boolean(rid),
    initialData: context?.open_day ?? null,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  })
  const openDay = openDayQuery.data ?? null
  const menu = useQuery({ queryKey: menuItemsKey(rid), queryFn: fetchMenuItems, enabled: Boolean(rid) })
  const categories = useQuery({ queryKey: categoriesKey(rid), queryFn: fetchCategories, enabled: Boolean(rid) })
  const tables = useQuery({ queryKey: ordersKeys.tables(rid), queryFn: fetchTables, enabled: Boolean(rid) })
  const dayOrders = useQuery({
    queryKey: [...ordersKeys.mine(rid), openDay?.id ?? ''],
    queryFn: () => fetchDayOrders(openDay?.id ?? ''),
    enabled: Boolean(rid && openDay),
  })
  const [cart, setCart] = useState<Cart>([])
  const [category, setCategory] = useState<string | 'all'>('all')
  const [search, setSearch] = useState('')
  const [orderType, setOrderType] = useState<OrderType>('dine-in')
  const [tableId, setTableId] = useState('')
  const [note, setOrderNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [last, setLast] = useState<SubmitResult | null>(null)
  // true after a send whose outcome is unknown: the cart and its fields are frozen until the SAME key gets a definitive answer
  const [unsure, setUnsure] = useState(false)
  // one key per cart; kept across retries until the order is confirmed
  const idemKey = useRef<string>(newKey())

  useEffect(() => {
    if (!rid) return
    const offMenu = subscribeToMenu(rid, (table) => {
      if (table === 'menu_items') void qc.invalidateQueries({ queryKey: menuItemsKey(rid) })
      if (table === 'categories') void qc.invalidateQueries({ queryKey: categoriesKey(rid) })
    })
    const offOrders = subscribeToOrders(rid, () => void qc.invalidateQueries({ queryKey: ordersKeys.mine(rid) }))
    return () => {
      offMenu()
      offOrders()
    }
  }, [rid, qc])

  const submit = useMutation({
    mutationFn: () =>
      submitOrder({
        items: toPayload(cart),
        idempotencyKey: idemKey.current,
        orderType,
        tableId: tableId || null,
        customerNote: note.trim() || null,
      }),
    onSuccess: (order) => {
      setLast(order)
      setCart([])
      setOrderNote('')
      setTableId('')
      setError(null)
      setUnsure(false)
      idemKey.current = newKey()
      toast.success(`Order ${order.order_no} sent`)
      void qc.invalidateQueries({ queryKey: ordersKeys.mine(rid) })
      void qc.invalidateQueries({ queryKey: ordersKeys.tables(rid) })
    },
    onError: (e) => {
      const { code, detail } = errorCode(e)
      setError(orderErrorMessage(e))
      // idempotency_pending: the first send is still running elsewhere, so its outcome is unknown too
      setUnsure(!code || !DEFINITIVE.has(code) || detail === 'idempotency_pending')
      if (code === 'day_closed') void openDayQuery.refetch()
      if (code === 'idempotency_conflict') void qc.invalidateQueries({ queryKey: ordersKeys.mine(rid) })
    },
  })

  const activeCategories = useMemo(() => (categories.data ?? []).filter((c) => c.is_active), [categories.data])
  const activeCategoryIds = useMemo(() => new Set(activeCategories.map((c) => c.id)), [activeCategories])
  const items = useMemo(() => {
    const q = search.trim().toLowerCase()
    return (menu.data ?? []).filter(
      (m) =>
        m.is_active &&
        activeCategoryIds.has(m.category_id) &&
        (category === 'all' || m.category_id === category) &&
        (!q || m.name.toLowerCase().includes(q)),
    )
  }, [menu.data, activeCategoryIds, category, search])

  // any change of the intent (cart, type, table, note) needs a new key; frozen while a send's outcome is unknown
  const touch = () => {
    idemKey.current = newKey()
    setError(null)
  }
  const change = (next: Cart) => {
    if (unsure) return
    setCart(next)
    touch()
  }
  const discardUnsure = () => {
    setUnsure(false)
    setError(null)
    setCart([])
    setOrderNote('')
    idemKey.current = newKey()
    void qc.invalidateQueries({ queryKey: ordersKeys.mine(rid) })
  }

  if (menu.isPending || categories.isPending) return <PageSkeleton label="Loading the menu" />
  if (menu.isError || categories.isError)
    return <ErrorState title="The menu could not be loaded" onRetry={() => void Promise.all([menu.refetch(), categories.refetch()])} />

  // while the tables load a dine-in order waits for them; if they cannot load, the server accepts an order without a table
  const needsTable = orderType === 'dine-in' && !tables.isError && (tables.isPending || (tables.data?.length ?? 0) > 0)
  const canSubmit = Boolean(openDay) && cart.length > 0 && !submit.isPending && (!needsTable || Boolean(tableId))

  return (
    <div className="grid gap-4 p-4 lg:grid-cols-[1fr_380px] lg:p-6">
      <section aria-labelledby="pos-menu" className="min-w-0 space-y-4">
        <h1 id="pos-menu" className="text-2xl font-semibold text-ink">
          New order
        </h1>
        {!openDay && (
          <p role="alert" className="rounded-md border border-status-warning bg-status-warning/10 p-3 text-sm text-ink">
            No business day is open. Orders can be prepared but not sent until a manager opens the day.{' '}
            <button type="button" className="font-medium underline" onClick={() => void openDayQuery.refetch()}>
              Check again
            </button>
          </p>
        )}
        <div className="relative">
          <Search aria-hidden="true" className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input aria-label="Search the menu" className="pl-9" value={search} maxLength={60} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div role="group" aria-label="Categories" className="flex flex-wrap gap-2">
          {[{ id: 'all', name: 'All', color: null as string | null }, ...activeCategories].map((c) => (
            <button
              key={c.id}
              type="button"
              aria-pressed={category === c.id}
              onClick={() => setCategory(c.id)}
              className={`min-h-[44px] rounded-pill border px-4 text-sm font-medium ${category === c.id ? 'border-primary bg-primary text-white' : 'border-line bg-white text-ink'}`}
              style={category !== c.id && c.color ? { borderColor: c.color } : undefined}
            >
              {c.name}
            </button>
          ))}
        </div>
        {items.length === 0 ? (
          <EmptyState title="Nothing here">No available item matches.</EmptyState>
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4" aria-label="Menu">
            {items.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => change(addItem(cart, m, newKey))}
                  className="flex min-h-[96px] w-full flex-col items-start justify-between rounded-card border border-line bg-white p-3 text-left hover:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="font-medium text-ink">
                    {m.emoji && <span aria-hidden="true">{m.emoji} </span>}
                    {m.name}
                  </span>
                  <span className="text-sm tabular-nums text-muted-foreground">{formatEtb(m.price)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <aside aria-labelledby="pos-cart" className="space-y-4 rounded-card border border-line bg-white p-4 lg:sticky lg:top-[calc(var(--shell-header-h,53px)+1rem)] lg:self-start">
        <h2 id="pos-cart" className="text-lg font-semibold text-ink">
          Order ({itemCount(cart)})
        </h2>
        <div className="grid grid-cols-2 gap-2">
          <NativeSelect
            aria-label="Order type"
            value={orderType}
            disabled={unsure}
            onChange={(e) => {
              setOrderType(e.target.value as OrderType)
              touch()
            }}
          >
            {ORDER_TYPES.map((t) => (
              <option key={t} value={t}>
                {ORDER_TYPE_LABEL[t]}
              </option>
            ))}
          </NativeSelect>
          {orderType === 'dine-in' && (
            <NativeSelect
              aria-label="Table"
              value={tableId}
              disabled={unsure}
              onChange={(e) => {
                setTableId(e.target.value)
                touch()
              }}
            >
              <option value="">Table…</option>
              {(tables.data ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                  {t.status === 'occupied' ? ' (occupied)' : ''}
                </option>
              ))}
            </NativeSelect>
          )}
        </div>
        {cart.length === 0 ? (
          <p className="text-sm text-muted-foreground">Tap menu items to add them.</p>
        ) : (
          <ul className="divide-y divide-line" aria-label="Order lines">
            {cart.map((l) => (
              <li key={l.key} className="space-y-2 py-2">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-medium text-ink">{l.name}</span>
                  <Button size="icon" variant="ghost" aria-label={`One less ${l.name}`} onClick={() => change(setQty(cart, l.key, l.qty - 1))}>
                    <Minus aria-hidden="true" className="h-4 w-4" />
                  </Button>
                  <span className="w-6 text-center tabular-nums" aria-label={`Quantity of ${l.name}`}>
                    {l.qty}
                  </span>
                  <Button size="icon" variant="ghost" aria-label={`One more ${l.name}`} onClick={() => change(setQty(cart, l.key, l.qty + 1))}>
                    <Plus aria-hidden="true" className="h-4 w-4" />
                  </Button>
                  <Button size="icon" variant="ghost" aria-label={`Remove ${l.name}`} onClick={() => change(removeLine(cart, l.key))}>
                    <Trash2 aria-hidden="true" className="h-4 w-4" />
                  </Button>
                </div>
                <Input
                  aria-label={`Note for ${l.name}`}
                  placeholder="Note (optional)"
                  value={l.note}
                  maxLength={200}
                  onChange={(e) => change(setNote(cart, l.key, e.target.value))}
                />
              </li>
            ))}
          </ul>
        )}
        <Input
          aria-label="Order note"
          placeholder="Order note (optional)"
          value={note}
          maxLength={300}
          disabled={unsure}
          onChange={(e) => {
            setOrderNote(e.target.value)
            touch()
          }}
        />
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">Subtotal (preview, VAT added by the server)</span>
          <span className="font-semibold tabular-nums text-ink" data-testid="pos-subtotal">
            {formatEtb(previewSubtotal(cart))}
          </span>
        </div>
        {error && (
          <p role="alert" className="text-sm font-medium text-status-error">
            {error}
          </p>
        )}
        <Button className="w-full" disabled={!canSubmit} onClick={() => submit.mutate()}>
          {submit.isPending ? 'Sending…' : unsure ? 'Send again' : 'Send order'}
        </Button>
        {unsure && (
          <p className="text-xs text-muted-foreground">
            The last send may have reached the kitchen. “Send again” never creates a second order.{' '}
            <button type="button" className="underline" onClick={discardUnsure}>
              Discard and check today’s orders
            </button>
          </p>
        )}
        {needsTable && !tableId && cart.length > 0 && <p className="text-xs text-muted-foreground">Choose a table for a dine-in order.</p>}
        {last && (
          <div className="rounded-md bg-status-success/10 p-3 text-sm text-ink" data-testid="pos-last-order">
            <p className="font-semibold">Order {last.order_no} sent</p>
            {isFullOrder(last) && (
              <p className="tabular-nums">
                Subtotal {formatEtb(last.subtotal)} · VAT {formatEtb(last.vat_amount)} · Total {formatEtb(last.total)}
              </p>
            )}
          </div>
        )}
        {openDay && dayOrders.isSuccess && dayOrders.data.length > 0 && (
          <details>
            <summary className="cursor-pointer text-sm font-medium text-ink">Today’s orders ({dayOrders.data.length})</summary>
            <ul className="mt-2 space-y-1 text-sm">
              {dayOrders.data.map((o) => (
                <li key={o.id} className="flex justify-between gap-2">
                  <span>
                    {o.order_no}
                    {o.table_label_snapshot ? ` · ${o.table_label_snapshot}` : ''} · {o.status}
                  </span>
                  <span className="tabular-nums">{formatEtb(o.total)}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </aside>
    </div>
  )
}
