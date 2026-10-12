import { useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { FormError, FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/select'
import { useAuth } from '@/features/auth'
import { ErrorState, PageSkeleton } from '@/features/shell/states'
import { cashVarianceTone, stockVarianceTone, type VarianceTone } from '@/lib/domain/day-close'
import { formatEtb, formatQty, parseDecimal } from '@/lib/domain/decimal'
import { formatEthiopianDateTime } from '@/lib/domain/ethiopian-time'
import {
  addExpense,
  closeDay,
  dayKeys,
  fetchClosePreview,
  fetchDays,
  fetchExpenseCategories,
  fetchExpenses,
  openDay,
  type CloseDayInput,
  type Day,
} from '@/lib/supabase/day'
import { errorCode } from '@/lib/supabase/menu-inventory-errors'
import { fetchOpenDay, ordersKeys } from '@/lib/supabase/orders'
import { fetchPaymentMethods, fetchTenantTimezone, paymentsKeys } from '@/lib/supabase/payments'

const newKey = () => crypto.randomUUID()
/** Fixed semantic colours (never tenant-branded). */
const TONE_CLASS: Record<VarianceTone, string> = {
  balanced: 'text-status-success',
  minor: 'text-status-warning',
  major: 'text-status-error',
}
/** "ETB +5.00" / "ETB -11.00" / "ETB 0.00". */
const signed = (v: number) => (v > 0 ? formatEtb(v).replace('ETB ', 'ETB +') : formatEtb(v))
/** Dates are shown in the Ethiopian calendar and clock, in the restaurant's time zone. */
function useTenantTz(): string {
  const { context } = useAuth()
  const rid = context?.restaurant?.id ?? ''
  const tz = useQuery({
    queryKey: paymentsKeys.timezone(rid),
    queryFn: fetchTenantTimezone,
    enabled: Boolean(rid),
    staleTime: 3_600_000,
  })
  return tz.data ?? 'Africa/Addis_Ababa'
}

function dayErrorMessage(err: unknown): string {
  const { code, detail } = errorCode(err)
  if (code === 'day_close_blocked') {
    const n = detail?.startsWith('unpaid_orders:') ? detail.slice('unpaid_orders:'.length) : null
    return `The day cannot close while ${n ?? 'some'} order(s) are unpaid. Take their payments, put them on an installment voucher, or cancel them.`
  }
  if (code === 'day_closed') return 'There is no open business day.'
  if (code === 'invalid_state' && detail === 'day_open') return 'A business day is already open.'
  if (code === 'invalid_input' && detail === 'counted_cash')
    return 'Enter the counted cash (0 or more, at most 2 decimals).'
  if (code === 'invalid_input' && detail === 'station_counts')
    return 'A stock count is not valid (0 or more, at most 3 decimals).'
  if (code === 'invalid_input' && detail === 'opening_float')
    return 'Enter the opening float (0 or more, at most 2 decimals).'
  if (code === 'permission_denied') return 'You do not have permission to do this.'
  if (code === 'idempotency_conflict')
    return 'An earlier attempt may already have gone through. Refresh before trying again.'
  if (code === 'tenant_suspended' || code === 'tenant_read_only')
    return 'This restaurant account cannot change the business day right now.'
  return 'We could not confirm whether this went through. Press the button again: it will not be done twice.'
}

/**
 * Day close (Phase 9). Expenses of the day, the close sheet (server preview: collections by method, expenses by category, expected
 * cash), the cash count and per-ingredient station counts with live variance, the atomic close, the printable balance sheet, and the
 * new-day workflow (the only way forward: a closed day never reopens). History of closed days stays readable.
 */
export function DayClosePage() {
  const tz = useTenantTz()
  const { context, can } = useAuth()
  const rid = context?.restaurant?.id ?? ''
  const qc = useQueryClient()
  const openDayQ = useQuery({
    queryKey: ordersKeys.openDay(rid),
    queryFn: fetchOpenDay,
    enabled: Boolean(rid),
    initialData: context?.open_day ?? null,
  })
  // fn_list_days needs reports.view or day_close.execute: a day.open-only role never calls it
  const canHistory = can('reports.view') || can('day_close.execute')
  const history = useQuery({
    queryKey: dayKeys.history(rid),
    queryFn: fetchDays,
    enabled: Boolean(rid) && canHistory,
  })
  const [sheet, setSheet] = useState<Day | null>(null)
  const refreshAll = () => {
    void qc.invalidateQueries({ queryKey: ['day', rid] })
    void qc.invalidateQueries({ queryKey: ordersKeys.openDay(rid) })
    void qc.invalidateQueries({ queryKey: ['cashier', rid] })
  }

  return (
    <div className="space-y-6 p-4 lg:p-6">
      <h1 className="text-2xl font-semibold text-ink">Day close</h1>
      {sheet ? (
        <BalanceSheet day={sheet} onDone={() => setSheet(null)} />
      ) : openDayQ.data ? (
        <>
          {(can('expenses.manage') || can('expenses.view')) && (
            <ExpensesCard dayId={openDayQ.data.id} canManage={can('expenses.manage')} />
          )}
          {can('day_close.execute') ? (
            <CloseCard
              onClosed={(d) => {
                setSheet(d)
                refreshAll()
              }}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              Business day {openDayQ.data.day_no} is open. Closing it needs the &ldquo;Close the business
              day&rdquo; permission.
            </p>
          )}
        </>
      ) : (
        can('day.open') && <OpenDayCard onOpened={refreshAll} />
      )}
      {canHistory && (
        <section aria-labelledby="day-history" className="space-y-2">
          <h2 id="day-history" className="text-lg font-semibold text-ink">
            Past days
          </h2>
          {history.isPending ? (
            <PageSkeleton label="Loading past days" />
          ) : history.isError ? (
            <ErrorState title="Past days could not be loaded" onRetry={() => void history.refetch()} />
          ) : (
            <div className="overflow-x-auto rounded-md border border-line bg-white">
              <table className="w-full text-sm">
                <caption className="sr-only">Business days</caption>
                <thead className="bg-muted text-left">
                  <tr>
                    <th scope="col" className="px-3 py-2">
                      Day
                    </th>
                    <th scope="col" className="px-3 py-2">
                      Closed
                    </th>
                    <th scope="col" className="px-3 py-2 text-right">
                      Collected
                    </th>
                    <th scope="col" className="px-3 py-2 text-right">
                      Expenses
                    </th>
                    <th scope="col" className="px-3 py-2 text-right">
                      Cash variance
                    </th>
                    <th scope="col" className="px-3 py-2">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {history.data.map((d) => (
                    <tr key={d.id}>
                      <td className="px-3 py-2 font-medium">
                        {d.day_no}
                        {d.status === 'open' && (
                          <span className="ml-2 text-xs text-status-success">open</span>
                        )}
                      </td>
                      <td className="px-3 py-2 font-amharic">
                        {d.closed_at ? formatEthiopianDateTime(d.closed_at, tz) : '—'}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {d.gross_collected != null ? formatEtb(d.gross_collected) : '—'}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {d.expenses_total != null ? formatEtb(d.expenses_total) : '—'}
                      </td>
                      <td
                        className={`px-3 py-2 text-right tabular-nums ${d.cash_variance != null ? TONE_CLASS[cashVarianceTone(d.cash_variance)] : ''}`}
                      >
                        {d.cash_variance != null ? signed(d.cash_variance) : '—'}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {d.status === 'closed' && (
                          <Button type="button" size="sm" variant="outline" onClick={() => setSheet(d)}>
                            Balance sheet
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  )
}

function ExpensesCard({ dayId, canManage }: { dayId: string; canManage: boolean }) {
  const { context } = useAuth()
  const rid = context?.restaurant?.id ?? ''
  const qc = useQueryClient()
  const cats = useQuery({
    queryKey: dayKeys.expenseCategories(rid),
    queryFn: fetchExpenseCategories,
    enabled: Boolean(rid),
  })
  const methods = useQuery({
    queryKey: paymentsKeys.methods(rid),
    queryFn: fetchPaymentMethods,
    enabled: Boolean(rid && canManage),
  })
  const list = useQuery({
    queryKey: dayKeys.expenses(rid, dayId),
    queryFn: () => fetchExpenses(dayId),
    enabled: Boolean(rid),
  })
  const [cat, setCat] = useState('')
  const [method, setMethod] = useState('')
  const [amount, setAmount] = useState('')
  const [desc, setDesc] = useState('')
  const [error, setError] = useState<string | null>(null)
  const amountValue = parseDecimal(amount, 2)
  const catName = useMemo(() => new Map((cats.data ?? []).map((c) => [c.id, c.name])), [cats.data])

  const add = useMutation({
    mutationFn: () =>
      addExpense({
        restaurantId: rid,
        categoryId: cat,
        paymentMethodId: method,
        amount: amountValue ?? 0,
        description: desc.trim() || null,
      }),
    onSuccess: () => {
      setAmount('')
      setDesc('')
      setError(null)
      toast.success('Expense recorded')
      void qc.invalidateQueries({ queryKey: ['day', rid] })
    },
    onError: (e) =>
      setError(
        e instanceof Error && e.message === 'day_closed'
          ? 'There is no open business day.'
          : 'The expense could not be recorded.',
      ),
  })

  return (
    <section aria-labelledby="day-expenses" className="space-y-3 rounded-lg border border-line bg-white p-4">
      <h2 id="day-expenses" className="text-lg font-semibold text-ink">
        Expenses today
      </h2>
      {canManage && (
        <form
          className="grid gap-3 md:grid-cols-[1fr_1fr_140px_1fr_auto] md:items-end"
          onSubmit={(e) => {
            e.preventDefault()
            if (cat && method && amountValue && amountValue > 0) add.mutate()
          }}
        >
          <FormField id="exp-cat" label="Category">
            {(a11y) => (
              <NativeSelect {...a11y} value={cat} onChange={(e) => setCat(e.target.value)}>
                <option value="">Choose</option>
                {(cats.data ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </NativeSelect>
            )}
          </FormField>
          <FormField id="exp-method" label="Paid with">
            {(a11y) => (
              <NativeSelect {...a11y} value={method} onChange={(e) => setMethod(e.target.value)}>
                <option value="">Choose</option>
                {(methods.data ?? []).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </NativeSelect>
            )}
          </FormField>
          <FormField id="exp-amount" label="Amount (ETB)">
            {(a11y) => (
              <Input
                {...a11y}
                inputMode="decimal"
                value={amount}
                maxLength={14}
                onChange={(e) => setAmount(e.target.value)}
              />
            )}
          </FormField>
          <FormField id="exp-desc" label="Description (optional)">
            {(a11y) => (
              <Input {...a11y} value={desc} maxLength={300} onChange={(e) => setDesc(e.target.value)} />
            )}
          </FormField>
          <Button
            type="submit"
            disabled={!cat || !method || !amountValue || amountValue <= 0 || add.isPending}
          >
            Add
          </Button>
        </form>
      )}
      <FormError message={error} />
      {list.data && list.data.length > 0 ? (
        <ul className="divide-y divide-line text-sm" aria-label="Expenses of the day">
          {list.data.map((x) => (
            <li key={x.id} className="flex justify-between gap-2 py-1.5">
              <span className="min-w-0 truncate">
                {catName.get(x.expense_category_id) ?? '—'}
                {x.description && <span className="ml-2 text-muted-foreground">{x.description}</span>}
              </span>
              <span className="shrink-0 tabular-nums">
                {formatEtb(x.amount)}{' '}
                <span className="text-xs text-muted-foreground">{x.method_name_snapshot}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No expenses recorded today.</p>
      )}
    </section>
  )
}

function CloseCard({ onClosed }: { onClosed: (d: Day) => void }) {
  const tz = useTenantTz()
  const { context } = useAuth()
  const rid = context?.restaurant?.id ?? ''
  const preview = useQuery({
    queryKey: dayKeys.preview(rid),
    queryFn: fetchClosePreview,
    enabled: Boolean(rid),
  })
  const [cash, setCash] = useState('')
  const [counts, setCounts] = useState<Record<string, string>>({})
  const [note, setNote] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [unsure, setUnsure] = useState(false)
  const key = useRef(newKey())
  const last = useRef<CloseDayInput | null>(null)
  const cashValue = parseDecimal(cash, 2)

  const close = useMutation({
    mutationFn: (retry: boolean) => {
      const req: CloseDayInput =
        retry && last.current
          ? last.current
          : {
              countedCash: cashValue ?? 0,
              stationCounts: Object.entries(counts).flatMap(([id, v]) => {
                const n = parseDecimal(v, 3)
                return v.trim() !== '' && n !== null ? [{ ingredient_id: id, counted: n }] : []
              }),
              note: note.trim() || null,
              idempotencyKey: key.current,
            }
      last.current = req
      return closeDay(req)
    },
    onSuccess: (d) => {
      setConfirm(false)
      setUnsure(false)
      toast.success(`Business day ${d.day_no} closed`)
      onClosed(d)
    },
    onError: (e) => {
      const { code } = errorCode(e)
      setError(dayErrorMessage(e))
      // a definitive refusal starts a fresh attempt; an unknown outcome keeps the frozen request for the retry
      setUnsure(!code)
      if (code) {
        last.current = null
        key.current = newKey()
      }
      if (code === 'day_close_blocked') void preview.refetch()
    },
  })

  if (preview.isPending) return <PageSkeleton label="Preparing the close sheet" />
  if (preview.isError)
    return <ErrorState title="The close sheet could not be prepared" onRetry={() => void preview.refetch()} />
  const p = preview.data
  const cashVar = cashValue !== null ? cashValue - p.expected_cash : null
  const touch = () => {
    if (unsure) return
    key.current = newKey()
    last.current = null
    setError(null)
  }

  return (
    <section aria-labelledby="day-close" className="space-y-4 rounded-lg border border-line bg-white p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="day-close" className="text-lg font-semibold text-ink">
          Close business day {p.day_no}
        </h2>
        <span className="font-amharic text-sm text-muted-foreground">
          opened {formatEthiopianDateTime(p.opened_at, tz)}
        </span>
      </div>
      {p.unpaid_orders > 0 && (
        <p
          role="alert"
          className="rounded-md border border-status-warning bg-status-warning/10 p-3 text-sm text-ink"
        >
          {p.unpaid_orders} order(s) are still unpaid. They must be paid, put on an installment voucher, or
          cancelled before the day can close.
        </p>
      )}
      <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm md:max-w-md">
        <dt>Orders</dt>
        <dd className="text-right tabular-nums">{p.order_count}</dd>
        <dt>Collected</dt>
        <dd className="text-right tabular-nums">{formatEtb(p.gross_collected)}</dd>
        <dt>Expenses</dt>
        <dd className="text-right tabular-nums">{formatEtb(p.expenses_total)}</dd>
        <dt>Opening float</dt>
        <dd className="text-right tabular-nums">{formatEtb(p.opening_float)}</dd>
        <dt>+ cash collected</dt>
        <dd className="text-right tabular-nums">{formatEtb(p.cash_collected)}</dd>
        <dt>− cash expenses</dt>
        <dd className="text-right tabular-nums">{formatEtb(p.cash_expenses)}</dd>
        <dt className="font-semibold">Expected in the drawer</dt>
        <dd className="text-right font-semibold tabular-nums">{formatEtb(p.expected_cash)}</dd>
      </dl>
      <div className="grid gap-4 md:grid-cols-2">
        <FormField
          id="close-cash"
          label="Counted cash (ETB)"
          error={
            cash.trim() !== '' && cashValue === null ? 'Enter an amount like 2500 or 2500.50.' : undefined
          }
        >
          {(a11y) => (
            <Input
              {...a11y}
              inputMode="decimal"
              value={cash}
              maxLength={14}
              onChange={(e) => {
                setCash(e.target.value)
                touch()
              }}
            />
          )}
        </FormField>
        <p className="self-end text-sm" aria-live="polite">
          {cashVar !== null && (
            <>
              Variance:{' '}
              <span className={`font-semibold tabular-nums ${TONE_CLASS[cashVarianceTone(cashVar)]}`}>
                {signed(cashVar)}
              </span>
            </>
          )}
        </p>
      </div>
      {p.station_snapshot.map((st) => (
        <fieldset key={st.station_id} className="rounded-md border border-line p-3">
          <legend className="px-1 text-sm font-medium text-ink">{st.name} — stock count</legend>
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th scope="col">Ingredient</th>
                <th scope="col" className="text-right">
                  Expected
                </th>
                <th scope="col" className="text-right">
                  Counted
                </th>
                <th scope="col" className="text-right">
                  Variance
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {st.items.map((it) => {
                const raw = counts[it.ingredient_id] ?? ''
                const n = raw.trim() === '' ? it.expected : parseDecimal(raw, 3)
                const v = n !== null ? n - it.expected : null
                return (
                  <tr key={it.ingredient_id}>
                    <td className="py-1">{it.name}</td>
                    <td className="py-1 text-right tabular-nums">
                      {formatQty(it.expected)} {it.unit}
                    </td>
                    <td className="py-1 text-right">
                      <Input
                        aria-label={`Counted ${it.name} (${it.unit})`}
                        className="ml-auto h-9 w-28 text-right"
                        inputMode="decimal"
                        placeholder={formatQty(it.expected)}
                        value={raw}
                        maxLength={14}
                        onChange={(e) => {
                          setCounts((c) => ({ ...c, [it.ingredient_id]: e.target.value }))
                          touch()
                        }}
                      />
                    </td>
                    <td
                      className={`py-1 text-right tabular-nums ${v !== null ? TONE_CLASS[stockVarianceTone(v, it.expected)] : 'text-status-error'}`}
                    >
                      {v !== null ? `${v > 0 ? '+' : ''}${formatQty(v)}` : 'invalid'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </fieldset>
      ))}
      <FormField id="close-note" label="Note (optional)">
        {(a11y) => (
          <Input
            {...a11y}
            value={note}
            maxLength={500}
            onChange={(e) => {
              setNote(e.target.value)
              touch()
            }}
          />
        )}
      </FormField>
      <FormError message={error} />
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={cashValue === null || p.unpaid_orders > 0 || close.isPending}
          onClick={() => setConfirm(true)}
        >
          Close the day
        </Button>
        {unsure && !close.isPending && (
          <Button type="button" variant="outline" onClick={() => close.mutate(true)}>
            Try again
          </Button>
        )}
      </div>
      <ConfirmDialog
        open={confirm}
        title={`Close business day ${p.day_no}?`}
        description="The day's figures are frozen and cannot be edited afterwards. Orders, payments and stock movements need a new day."
        confirmLabel="Close and freeze"
        busy={close.isPending}
        error={error}
        onConfirm={() => close.mutate(unsure)}
        onCancel={() => setConfirm(false)}
      />
    </section>
  )
}

function OpenDayCard({ onOpened }: { onOpened: () => void }) {
  const [float, setFloat] = useState('')
  const [error, setError] = useState<string | null>(null)
  const key = useRef(newKey())
  const value = parseDecimal(float, 2)
  const open = useMutation({
    mutationFn: () => openDay(value ?? 0, key.current),
    onSuccess: (d) => {
      key.current = newKey()
      toast.success(`Business day ${d.day_no} opened`)
      onOpened()
    },
    onError: (e) => setError(dayErrorMessage(e)),
  })
  return (
    <section aria-labelledby="day-open" className="space-y-3 rounded-lg border border-line bg-white p-4">
      <h2 id="day-open" className="text-lg font-semibold text-ink">
        Open a new business day
      </h2>
      <p className="text-sm text-muted-foreground">
        No business day is open. Orders, payments and stock movements start once a day is opened.
      </p>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (value !== null) open.mutate()
        }}
      >
        <FormField id="open-float" label="Opening float (ETB)">
          {(a11y) => (
            <Input
              {...a11y}
              inputMode="decimal"
              value={float}
              maxLength={14}
              onChange={(e) => {
                setFloat(e.target.value)
                key.current = newKey()
                setError(null)
              }}
            />
          )}
        </FormField>
        <Button type="submit" disabled={value === null || open.isPending}>
          Open day
        </Button>
      </form>
      <FormError message={error} />
    </section>
  )
}

function BalanceSheet({ day, onDone }: { day: Day; onDone: () => void }) {
  const tz = useTenantTz()
  return (
    <section
      aria-label={`Balance sheet day ${day.day_no}`}
      className="receipt-print space-y-3 rounded-lg border border-line bg-white p-4 text-sm"
    >
      <h2 className="text-lg font-semibold text-ink">Balance sheet — business day {day.day_no}</h2>
      <p className="font-amharic text-muted-foreground">
        {formatEthiopianDateTime(day.opened_at, tz)} →{' '}
        {day.closed_at ? formatEthiopianDateTime(day.closed_at, tz) : ''}
        {day.closed_by ? ` · closed by ${day.closed_by}` : ''}
      </p>
      <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 md:max-w-md">
        <dt>Orders</dt>
        <dd className="text-right tabular-nums">{day.order_count}</dd>
        <dt>Collected</dt>
        <dd className="text-right tabular-nums">{formatEtb(day.gross_collected ?? 0)}</dd>
        <dt>Expenses</dt>
        <dd className="text-right tabular-nums">{formatEtb(day.expenses_total ?? 0)}</dd>
        <dt className="font-semibold">Net</dt>
        <dd className="text-right font-semibold tabular-nums">{formatEtb(day.net_profit ?? 0)}</dd>
        <dt>Expected cash</dt>
        <dd className="text-right tabular-nums">{formatEtb(day.expected_cash ?? 0)}</dd>
        <dt>Counted cash</dt>
        <dd className="text-right tabular-nums">{formatEtb(day.counted_cash ?? 0)}</dd>
        <dt>Cash variance</dt>
        <dd
          className={`text-right font-semibold tabular-nums ${TONE_CLASS[cashVarianceTone(day.cash_variance ?? 0)]}`}
        >
          {signed(day.cash_variance ?? 0)}
        </dd>
      </dl>
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <h3 className="font-medium">By payment method</h3>
          <ul>
            {(day.payment_snapshot ?? []).map((m) => (
              <li key={m.payment_method_id} className="flex justify-between">
                <span>{m.name}</span>
                <span className="tabular-nums">{formatEtb(m.amount)}</span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="font-medium">Expenses by category</h3>
          <ul>
            {(day.expense_snapshot ?? []).map((m) => (
              <li key={m.expense_category_id} className="flex justify-between">
                <span>{m.name}</span>
                <span className="tabular-nums">{formatEtb(m.amount)}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div>
        <h3 className="font-medium">Stations</h3>
        <ul>
          {(day.station_snapshot ?? []).map((s) => (
            <li key={s.station_id} className="flex justify-between">
              <span>{s.name}</span>
              <span className="tabular-nums">
                {formatQty(s.counted)} / {formatQty(s.expected)} ({s.variance > 0 ? '+' : ''}
                {formatQty(s.variance)})
              </span>
            </li>
          ))}
        </ul>
      </div>
      {day.close_note && <p>Note: {day.close_note}</p>}
      <div className="no-print flex gap-2">
        <Button type="button" variant="outline" onClick={onDone}>
          Done
        </Button>
        <Button type="button" onClick={() => window.print()}>
          Print
        </Button>
      </div>
    </section>
  )
}
