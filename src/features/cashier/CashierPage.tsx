import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { FormError, FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { useAuth, useStepUp } from '@/features/auth'
import { EmptyState, ErrorState, PageSkeleton } from '@/features/shell/states'
import { iconForSlug } from '@/features/terminal/tile-icons'
import { formatEtb, parseDecimal } from '@/lib/domain/decimal'
import { formatInternationalDateTime } from '@/lib/domain/ethiopian-time'
import { errorCode } from '@/lib/supabase/menu-inventory-errors'
import { fetchOpenDay, ordersKeys } from '@/lib/supabase/orders'
import {
  confirmPayment,
  fetchDayPayments,
  fetchOrderDetail,
  fetchPaymentMethods,
  fetchReceipt,
  fetchUnpaidOrders,
  paymentsKeys,
  reversePayment,
  subscribeToCashier,
  type PaymentMethod,
  type PaymentRow,
  type Receipt,
} from '@/lib/supabase/payments'
import { Wallet } from 'lucide-react'
import { DEFINITIVE_PAYMENT_ERRORS, paymentErrorMessage } from './payment-errors'
import { ReceiptView } from './ReceiptView'

const newKey = () => crypto.randomUUID()

/**
 * Cashier (Phase 6). Unpaid orders of the open day; payment methods are the tenant's rows (name, colour, icon, cash-drawer and
 * reference flags), no method name is known to the code. The client sends the intent (order, method, reference, amount received);
 * fn_confirm_payment charges the order total, numbers the receipt and marks the order paid. One idempotency key per intent: a
 * retry after a network error returns the same receipt, never a second payment.
 */
export function CashierPage() {
  const { context, can } = useAuth()
  const rid = context?.restaurant?.id ?? ''
  const qc = useQueryClient()
  const openDayQuery = useQuery({
    queryKey: ordersKeys.openDay(rid),
    queryFn: fetchOpenDay,
    enabled: Boolean(rid),
    initialData: context?.open_day ?? null,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  })
  const openDay = openDayQuery.data ?? null
  const dayId = openDay?.id ?? ''
  const methods = useQuery({
    queryKey: paymentsKeys.methods(rid),
    queryFn: fetchPaymentMethods,
    enabled: Boolean(rid),
  })
  const unpaid = useQuery({
    queryKey: paymentsKeys.unpaid(rid, dayId),
    queryFn: () => fetchUnpaidOrders(dayId),
    enabled: Boolean(rid && dayId),
  })
  const canViewHistory = can('payments.view')
  const history = useQuery({
    queryKey: paymentsKeys.history(rid, dayId),
    queryFn: () => fetchDayPayments(dayId),
    enabled: Boolean(rid && dayId && canViewHistory),
  })

  const [orderId, setOrderId] = useState<string | null>(null)
  const [methodId, setMethodId] = useState<string | null>(null)
  const [reference, setReference] = useState('')
  const [tendered, setTendered] = useState('')
  const [error, setError] = useState<string | null>(null)
  // true after an attempt whose outcome is unknown: the intent is frozen until the SAME key gets a definitive answer
  const [unsure, setUnsure] = useState(false)
  const [receipt, setReceipt] = useState<Receipt | null>(null)
  const idemKey = useRef(newKey())

  const detail = useQuery({
    queryKey: paymentsKeys.order(rid, orderId ?? ''),
    queryFn: () => fetchOrderDetail(orderId ?? ''),
    enabled: Boolean(rid && orderId),
  })

  useEffect(() => {
    if (!rid) return
    const refresh = () => {
      void qc.invalidateQueries({ queryKey: ['cashier', rid] })
    }
    return subscribeToCashier(rid, refresh, refresh)
  }, [rid, qc])

  const method: PaymentMethod | undefined = useMemo(
    () => methods.data?.find((m) => m.id === methodId),
    [methods.data, methodId],
  )
  const total = detail.data?.total ?? null
  const tenderedValue = tendered.trim() === '' ? null : parseDecimal(tendered, 2)
  const tenderedInvalid = tendered.trim() !== '' && (tenderedValue === null || tenderedValue <= 0)
  const changePreview = tenderedValue !== null && total !== null ? tenderedValue - total : null

  const touch = () => {
    idemKey.current = newKey()
    setError(null)
  }
  const reset = () => {
    setOrderId(null)
    setMethodId(null)
    setReference('')
    setTendered('')
    setError(null)
    setUnsure(false)
    idemKey.current = newKey()
  }

  const pay = useMutation({
    mutationFn: () =>
      confirmPayment({
        orderId: orderId ?? '',
        paymentMethodId: methodId ?? '',
        reference: reference.trim() || null,
        tendered: method?.affects_cash_drawer ? tenderedValue : null,
        idempotencyKey: idemKey.current,
      }),
    onSuccess: (r) => {
      reset()
      setReceipt(r)
      toast.success(`Payment confirmed: receipt ${r.receipt_no}`)
      void qc.invalidateQueries({ queryKey: ['cashier', rid] })
      void qc.invalidateQueries({ queryKey: ordersKeys.mine(rid) })
    },
    onError: (e) => {
      const { code, detail: d } = errorCode(e)
      setError(paymentErrorMessage(e))
      setUnsure(!code || !DEFINITIVE_PAYMENT_ERRORS.has(code) || d === 'idempotency_pending')
      if (code === 'day_closed') void openDayQuery.refetch()
      if (code === 'order_not_payable' || code === 'not_found')
        void qc.invalidateQueries({ queryKey: ['cashier', rid] })
      if (code === 'invalid_input' && d === 'payment_method_id') void methods.refetch()
    },
  })

  if (methods.isPending) return <PageSkeleton label="Loading the cashier" />
  if (methods.isError)
    return <ErrorState title="Payment methods could not be loaded" onRetry={() => void methods.refetch()} />

  const needsReference = Boolean(method?.requires_reference) && reference.trim() === ''
  const shortTendered = changePreview !== null && changePreview < 0
  const canPay =
    Boolean(openDay && orderId && method && detail.data && detail.data.payment_status === 'unpaid') &&
    !needsReference &&
    !tenderedInvalid &&
    !shortTendered &&
    !pay.isPending

  return (
    <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_420px] lg:p-6">
      <section aria-labelledby="cashier-unpaid" className="min-w-0 space-y-3">
        <h1 id="cashier-unpaid" className="text-2xl font-semibold text-ink">
          Cashier
        </h1>
        {!openDay ? (
          <p
            role="alert"
            className="rounded-md border border-status-warning bg-status-warning/10 p-3 text-sm text-ink"
          >
            No business day is open. Payments can be taken once a manager opens the day.{' '}
            <button
              type="button"
              className="font-medium underline"
              onClick={() => void openDayQuery.refetch()}
            >
              Check again
            </button>
          </p>
        ) : unpaid.isPending ? (
          <PageSkeleton label="Loading unpaid orders" />
        ) : unpaid.isError ? (
          <ErrorState title="Unpaid orders could not be loaded" onRetry={() => void unpaid.refetch()} />
        ) : unpaid.data.length === 0 ? (
          <EmptyState title="No unpaid orders">New orders appear here as soon as they are sent.</EmptyState>
        ) : (
          <ul aria-label="Unpaid orders" className="space-y-2">
            {unpaid.data.map((o) => (
              <li key={o.id}>
                <button
                  type="button"
                  aria-pressed={orderId === o.id}
                  disabled={unsure || pay.isPending}
                  onClick={() => {
                    if (orderId === o.id) return
                    setOrderId(o.id)
                    setReference('')
                    setTendered('')
                    touch()
                  }}
                  className={`flex min-h-[56px] w-full items-center justify-between gap-3 rounded-md border px-4 py-2 text-left ${orderId === o.id ? 'border-primary bg-primary/5' : 'border-line bg-white'}`}
                >
                  <span>
                    <span className="block font-medium text-ink">{o.order_no}</span>
                    <span className="block text-xs text-muted-foreground">
                      {[
                        o.table_label_snapshot,
                        o.created_by_name_snapshot,
                        formatInternationalDateTime(o.created_at).slice(11),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                  <span className="font-semibold tabular-nums">{formatEtb(o.total)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section
        aria-labelledby="cashier-bill"
        className="space-y-4 rounded-lg border border-line bg-white p-4"
      >
        <h2 id="cashier-bill" className="text-lg font-semibold text-ink">
          Bill
        </h2>
        {!orderId ? (
          <p className="text-sm text-muted-foreground">Choose an order to take its payment.</p>
        ) : detail.isPending ? (
          <PageSkeleton label="Loading the order" />
        ) : detail.isError || !detail.data ? (
          <ErrorState title="The order could not be loaded" onRetry={() => void detail.refetch()} />
        ) : (
          <>
            <ul aria-label="Order lines" className="divide-y divide-line text-sm">
              {detail.data.order_items
                .filter((l) => l.item_status !== 'cancelled')
                .map((l) => (
                  <li key={l.id} className="flex justify-between gap-2 py-1.5">
                    <span className="min-w-0 break-words">
                      {l.qty} × {l.name_snapshot}
                    </span>
                    <span className="tabular-nums">{formatEtb(l.price_snapshot * l.qty)}</span>
                  </li>
                ))}
            </ul>
            <dl className="grid grid-cols-[1fr_auto] gap-x-3 text-sm">
              <dt>Subtotal</dt>
              <dd className="text-right tabular-nums">{formatEtb(detail.data.subtotal)}</dd>
              <dt>VAT ({detail.data.vat_rate_snapshot}%)</dt>
              <dd className="text-right tabular-nums">{formatEtb(detail.data.vat_amount)}</dd>
              <dt className="text-base font-semibold">Total</dt>
              <dd className="text-right text-base font-semibold tabular-nums">
                {formatEtb(detail.data.total)}
              </dd>
            </dl>

            <fieldset disabled={unsure || pay.isPending} className="space-y-3">
              <legend className="mb-2 text-sm font-medium text-ink">Payment method</legend>
              {(methods.data ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No payment method is active. Ask an administrator to add one.
                </p>
              ) : (
                <div role="radiogroup" aria-label="Payment method" className="grid grid-cols-2 gap-2">
                  {(methods.data ?? []).map((m) => {
                    const Icon = iconForSlug(m.icon, Wallet)
                    const selected = methodId === m.id
                    return (
                      <button
                        key={m.id}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        onClick={() => {
                          setMethodId(m.id)
                          if (!m.affects_cash_drawer) setTendered('')
                          touch()
                        }}
                        className={`flex min-h-[48px] items-center gap-2 rounded-md border px-3 text-sm font-medium ${selected ? 'border-primary bg-primary text-white' : 'border-line bg-white text-ink'}`}
                        style={!selected && m.color ? { borderColor: m.color } : undefined}
                      >
                        <Icon
                          aria-hidden="true"
                          className="h-4 w-4 shrink-0"
                          style={!selected && m.color ? { color: m.color } : undefined}
                        />
                        <span className="truncate">{m.name}</span>
                      </button>
                    )
                  })}
                </div>
              )}
              {method?.requires_reference && (
                <FormField
                  id="pay-reference"
                  label="Reference"
                  hint="The transaction or slip number (required for this method)."
                >
                  {(a11y) => (
                    <Input
                      {...a11y}
                      value={reference}
                      maxLength={120}
                      autoComplete="off"
                      onChange={(e) => {
                        setReference(e.target.value)
                        touch()
                      }}
                    />
                  )}
                </FormField>
              )}
              {method?.affects_cash_drawer && (
                <FormField
                  id="pay-tendered"
                  label="Amount received (ETB)"
                  hint="Optional. Used to show the change."
                  error={
                    tenderedInvalid
                      ? 'Enter an amount like 250 or 250.50.'
                      : shortTendered
                        ? 'Less than the total.'
                        : undefined
                  }
                >
                  {(a11y) => (
                    <Input
                      {...a11y}
                      inputMode="decimal"
                      value={tendered}
                      maxLength={14}
                      autoComplete="off"
                      onChange={(e) => {
                        setTendered(e.target.value)
                        touch()
                      }}
                    />
                  )}
                </FormField>
              )}
              {changePreview !== null && changePreview >= 0 && (
                <p className="text-sm text-ink" aria-live="polite">
                  Change: <span className="font-semibold tabular-nums">{formatEtb(changePreview)}</span>
                </p>
              )}
            </fieldset>
            <FormError message={error} />
            {unsure ? (
              <div className="flex flex-wrap gap-2">
                <Button type="button" onClick={() => pay.mutate()} disabled={pay.isPending}>
                  Try again
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={pay.isPending}
                  onClick={() => {
                    reset()
                    void qc.invalidateQueries({ queryKey: ['cashier', rid] })
                  }}
                >
                  Check the list instead
                </Button>
              </div>
            ) : (
              <Button type="button" className="w-full" disabled={!canPay} onClick={() => pay.mutate()}>
                {pay.isPending
                  ? 'Confirming…'
                  : `Confirm payment${total !== null ? ` ${formatEtb(total)}` : ''}`}
              </Button>
            )}
          </>
        )}
      </section>

      {canViewHistory && openDay && (
        <PaymentHistory
          rows={history.data}
          loading={history.isPending}
          failed={history.isError}
          onRetry={() => void history.refetch()}
          canReverse={can('payments.reverse')}
          onShow={setReceipt}
        />
      )}

      <Dialog open={receipt !== null} onOpenChange={(o) => !o && setReceipt(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader className="no-print">
            <DialogTitle>Receipt</DialogTitle>
            <DialogDescription>
              {receipt?.replayed ? 'This payment was already confirmed.' : 'Print or close.'}
            </DialogDescription>
          </DialogHeader>
          {receipt && <ReceiptView receipt={receipt} />}
          <DialogFooter className="no-print">
            <Button type="button" variant="outline" onClick={() => setReceipt(null)}>
              Close
            </Button>
            <Button type="button" onClick={() => window.print()}>
              Print
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function PaymentHistory({
  rows,
  loading,
  failed,
  onRetry,
  canReverse,
  onShow,
}: {
  rows: PaymentRow[] | undefined
  loading: boolean
  failed: boolean
  onRetry: () => void
  canReverse: boolean
  onShow: (r: Receipt) => void
}) {
  const qc = useQueryClient()
  const { context } = useAuth()
  const rid = context?.restaurant?.id ?? ''
  const stepUp = useStepUp()
  const [busy, setBusy] = useState<string | null>(null)
  const [reverseFor, setReverseFor] = useState<PaymentRow | null>(null)
  const [reason, setReason] = useState('')
  const [reverseError, setReverseError] = useState<string | null>(null)
  const [reverseUnsure, setReverseUnsure] = useState(false)
  const reverseKey = useRef(newKey())
  const reversedIds = useMemo(
    () => new Set((rows ?? []).map((r) => r.reversed_payment_id).filter(Boolean)),
    [rows],
  )

  const show = async (id: string) => {
    setBusy(id)
    try {
      onShow(await fetchReceipt(id))
    } catch (e) {
      toast.error(paymentErrorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  const reverse = useMutation({
    mutationFn: (p: PaymentRow) => stepUp.run(() => reversePayment(p.id, reason.trim(), reverseKey.current)),
    onSuccess: (r) => {
      setReverseFor(null)
      setReason('')
      setReverseUnsure(false)
      reverseKey.current = newKey()
      toast.success(`Payment reversed: ${r.receipt_no}`)
      void qc.invalidateQueries({ queryKey: ['cashier', rid] })
      onShow(r)
    },
    onError: (e) => {
      const { code } = errorCode(e)
      setReverseError(paymentErrorMessage(e))
      setReverseUnsure(!code || !DEFINITIVE_PAYMENT_ERRORS.has(code))
    },
  })

  const reasonOk = reason.trim().length >= 3 && reason.trim().length <= 300

  return (
    <section aria-labelledby="cashier-history" className="space-y-3 lg:col-span-2">
      <h2 id="cashier-history" className="text-lg font-semibold text-ink">
        Payments today
      </h2>
      {loading ? (
        <PageSkeleton label="Loading payments" />
      ) : failed ? (
        <ErrorState title="Payments could not be loaded" onRetry={onRetry} />
      ) : (rows ?? []).length === 0 ? (
        <EmptyState title="No payments yet" level={2}>
          Confirmed payments of the open day appear here.
        </EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-md border border-line bg-white">
          <table className="w-full text-sm">
            <caption className="sr-only">Payments of the open business day</caption>
            <thead className="bg-muted text-left">
              <tr>
                <th scope="col" className="px-3 py-2">
                  Receipt
                </th>
                <th scope="col" className="px-3 py-2">
                  Order
                </th>
                <th scope="col" className="px-3 py-2">
                  Method
                </th>
                <th scope="col" className="px-3 py-2 text-right">
                  Amount
                </th>
                <th scope="col" className="px-3 py-2">
                  Time
                </th>
                <th scope="col" className="px-3 py-2">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {(rows ?? []).map((p) => {
                const isReversal = p.kind === 'reversal'
                const reversed = reversedIds.has(p.id)
                return (
                  <tr key={p.id} className={isReversal ? 'text-status-cancelled' : undefined}>
                    <td className="px-3 py-2 font-medium">
                      {p.receipt_no}
                      {isReversal && <span className="ml-2 text-xs uppercase">reversal</span>}
                      {reversed && (
                        <span className="ml-2 text-xs uppercase text-status-cancelled">reversed</span>
                      )}
                    </td>
                    <td className="px-3 py-2">{p.orders?.order_no ?? ''}</td>
                    <td className="px-3 py-2">{p.method_name_snapshot}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {isReversal ? `−${formatEtb(p.amount)}` : formatEtb(p.amount)}
                    </td>
                    <td className="px-3 py-2">{formatInternationalDateTime(p.created_at).slice(11)}</td>
                    <td className="space-x-2 whitespace-nowrap px-3 py-2 text-right">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={busy === p.id}
                        onClick={() => void show(p.id)}
                      >
                        Receipt
                      </Button>
                      {canReverse && p.kind === 'order_payment' && !reversed && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setReverseFor(p)
                            setReason('')
                            setReverseError(null)
                            setReverseUnsure(false)
                            reverseKey.current = newKey()
                          }}
                        >
                          Reverse
                        </Button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <Dialog
        open={reverseFor !== null}
        onOpenChange={(o) => !o && !reverse.isPending && setReverseFor(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reverse payment {reverseFor?.receipt_no}</DialogTitle>
            <DialogDescription>
              A reversal of {formatEtb(reverseFor?.amount ?? 0)} is recorded and the order becomes unpaid
              again. The original payment is kept. Your authenticator code may be asked.
            </DialogDescription>
          </DialogHeader>
          <FormField id="reverse-reason" label="Reason" hint="3 to 300 characters; kept in the audit trail.">
            {(a11y) => (
              <Input
                {...a11y}
                value={reason}
                maxLength={300}
                disabled={reverseUnsure || reverse.isPending}
                onChange={(e) => {
                  setReason(e.target.value)
                  reverseKey.current = newKey()
                  setReverseError(null)
                }}
              />
            )}
          </FormField>
          <FormError message={reverseError} />
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={reverse.isPending}
              onClick={() => setReverseFor(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={!reasonOk || reverse.isPending}
              onClick={() => reverseFor && reverse.mutate(reverseFor)}
            >
              {reverseUnsure ? 'Try again' : 'Reverse payment'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {stepUp.dialog}
    </section>
  )
}
