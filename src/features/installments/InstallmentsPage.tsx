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
import { NativeSelect } from '@/components/ui/select'
import { useAuth } from '@/features/auth'
import { EmptyState, ErrorState, PageSkeleton } from '@/features/shell/states'
import { formatEtb, parseDecimal } from '@/lib/domain/decimal'
import { formatEthiopianDate } from '@/lib/domain/ethiopian-time'
import { FREQUENCIES, buildSchedule } from '@/lib/domain/installments'
import { errorCode } from '@/lib/supabase/menu-inventory-errors'
import { fetchOpenDay, ordersKeys } from '@/lib/supabase/orders'
import {
  fetchPaymentMethods,
  fetchTenantTimezone,
  fetchUnpaidOrders,
  paymentsKeys,
  type PaymentMethod,
  type Receipt,
} from '@/lib/supabase/payments'
import {
  confirmInstallment,
  generateVoucher,
  getVoucher,
  listVouchers,
  subscribeToVouchers,
  vouchersKeys,
  type ConfirmInstallmentInput,
  type GenerateVoucherInput,
  type Voucher,
} from '@/lib/supabase/vouchers'
import { DEFINITIVE_PAYMENT_ERRORS, paymentErrorMessage } from '@/features/cashier/payment-errors'
import { ReceiptView } from '@/features/cashier/ReceiptView'

const newKey = () => crypto.randomUUID()
const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'overdue', label: 'Overdue' },
  { id: 'settled', label: 'Settled' },
] as const
type Filter = (typeof FILTERS)[number]['id']

/** Fixed, platform-wide semantic colours (never tenant-branded). */
const STATUS_CLASS: Record<Voucher['status'], string> = {
  active: 'bg-status-warning/10 text-ink border-status-warning',
  overdue: 'bg-status-error/10 text-status-error border-status-error',
  settled: 'bg-status-success/10 text-status-success border-status-success',
}

/**
 * Installments (Phase 7). Vouchers with their computed status (active / overdue / settled), the schedule, progress and outstanding
 * balance; a new voucher turns an unpaid order of the open day into scheduled installments (live preview of the server rule); the
 * next installment is collected with a tenant payment-method row. Every money figure on paper comes from the server.
 */
export function InstallmentsPage() {
  const { context, can } = useAuth()
  const rid = context?.restaurant?.id ?? ''
  const qc = useQueryClient()
  const canManage = can('vouchers.manage')
  const [filter, setFilter] = useState<Filter>('all')
  const [openId, setOpenId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [receipt, setReceipt] = useState<Receipt | null>(null)
  const tz = useQuery({
    queryKey: paymentsKeys.timezone(rid),
    queryFn: fetchTenantTimezone,
    enabled: Boolean(rid),
    staleTime: 300_000,
  })
  const timeZone = tz.data ?? 'Africa/Addis_Ababa'
  const list = useQuery({
    queryKey: vouchersKeys.list(rid, filter),
    queryFn: () => listVouchers(filter),
    enabled: Boolean(rid),
  })

  useEffect(() => {
    if (!rid) return
    return subscribeToVouchers(rid, () => void qc.invalidateQueries({ queryKey: ['vouchers', rid] }))
  }, [rid, qc])

  return (
    <div className="space-y-4 p-4 lg:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-ink">Installments</h1>
        {canManage && <Button onClick={() => setCreating(true)}>New voucher</Button>}
      </div>
      <div role="group" aria-label="Status" className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
            className={`min-h-[44px] rounded-pill border px-4 text-sm font-medium ${filter === f.id ? 'border-primary bg-primary text-white' : 'border-line bg-white text-ink'}`}
          >
            {f.label}
          </button>
        ))}
      </div>
      {list.isPending ? (
        <PageSkeleton label="Loading vouchers" />
      ) : list.isError ? (
        <ErrorState title="Vouchers could not be loaded" onRetry={() => void list.refetch()} />
      ) : list.data.length === 0 ? (
        <EmptyState title="No vouchers">Installment vouchers appear here once issued.</EmptyState>
      ) : (
        <ul aria-label="Vouchers" className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {list.data.map((v) => {
            const pct = v.total > 0 ? Math.min(100, Math.round((v.paid_amount / v.total) * 100)) : 0
            return (
              <li key={v.id}>
                <button
                  type="button"
                  onClick={() => setOpenId(v.id)}
                  className="w-full space-y-2 rounded-lg border border-line bg-white p-4 text-left"
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-ink">{v.voucher_no}</span>
                    <span
                      className={`rounded-pill border px-2 py-0.5 text-xs font-medium capitalize ${STATUS_CLASS[v.status]}`}
                    >
                      {v.status}
                    </span>
                  </span>
                  <span className="block text-sm text-ink">{v.customer_name}</span>
                  <span className="block text-xs text-muted-foreground">
                    {v.order_no} · {v.paid_installments}/{v.installment_count} paid · outstanding{' '}
                    {formatEtb(v.outstanding)}
                  </span>
                  <span aria-hidden="true" className="block h-2 overflow-hidden rounded-full bg-muted">
                    <span className="block h-full bg-primary" style={{ width: `${pct}%` }} />
                  </span>
                  {v.next_due && (
                    <span className="block font-amharic text-xs text-muted-foreground">
                      Next: #{v.next_due.no} {formatEtb(v.next_due.amount)} ·{' '}
                      {formatEthiopianDate(v.next_due.due_date)}
                    </span>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {openId && (
        <VoucherDialog
          voucherId={openId}
          canManage={canManage}
          timeZone={timeZone}
          onClose={() => setOpenId(null)}
          onReceipt={setReceipt}
        />
      )}
      {creating && (
        <NewVoucherDialog
          onClose={() => setCreating(false)}
          onIssued={(v, down) => {
            setCreating(false)
            setOpenId(v.id)
            if (down) setReceipt(down)
          }}
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

function MethodPicker({
  methods,
  value,
  onChange,
  name,
}: {
  methods: PaymentMethod[]
  value: string | null
  onChange: (m: PaymentMethod) => void
  name: string
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {methods.map((m) => {
        const selected = value === m.id
        return (
          <label
            key={m.id}
            className={`flex min-h-[48px] cursor-pointer items-center gap-2 rounded-md border px-3 text-sm font-medium focus-within:ring-2 focus-within:ring-ring ${selected ? 'border-primary bg-primary text-white' : 'border-line bg-white text-ink'}`}
            style={!selected && m.color ? { borderColor: m.color } : undefined}
          >
            <input
              type="radio"
              name={name}
              value={m.id}
              checked={selected}
              className="sr-only"
              onChange={() => onChange(m)}
            />
            <span className="truncate">{m.name}</span>
          </label>
        )
      })}
    </div>
  )
}

function VoucherDialog({
  voucherId,
  canManage,
  timeZone,
  onClose,
  onReceipt,
}: {
  voucherId: string
  canManage: boolean
  timeZone: string
  onClose: () => void
  onReceipt: (r: Receipt) => void
}) {
  const { context } = useAuth()
  const rid = context?.restaurant?.id ?? ''
  const qc = useQueryClient()
  const v = useQuery({
    queryKey: vouchersKeys.one(rid, voucherId),
    queryFn: () => getVoucher(voucherId),
    enabled: Boolean(rid),
  })
  const methods = useQuery({
    queryKey: paymentsKeys.methods(rid),
    queryFn: fetchPaymentMethods,
    enabled: Boolean(rid && canManage),
  })
  const [methodId, setMethodId] = useState<string | null>(null)
  const [reference, setReference] = useState('')
  const [tendered, setTendered] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [unsure, setUnsure] = useState(false)
  const key = useRef(newKey())
  const last = useRef<ConfirmInstallmentInput | null>(null)
  const method = useMemo(() => methods.data?.find((m) => m.id === methodId), [methods.data, methodId])
  const next = v.data?.next_due ?? null
  const tenderedValue = tendered.trim() === '' ? null : parseDecimal(tendered, 2)
  const touch = () => {
    key.current = newKey()
    setError(null)
  }

  const collect = useMutation({
    mutationFn: (retry: boolean) => {
      const req: ConfirmInstallmentInput =
        retry && last.current
          ? last.current
          : {
              voucherId,
              paymentMethodId: methodId ?? '',
              reference: reference.trim() || null,
              installmentNo: next?.no ?? 0,
              tendered: method?.affects_cash_drawer ? tenderedValue : null,
              idempotencyKey: key.current,
            }
      last.current = req
      return confirmInstallment(req)
    },
    onSuccess: (r) => {
      last.current = null
      key.current = newKey()
      setUnsure(false)
      setReference('')
      setTendered('')
      setError(null)
      toast.success(`Installment collected: receipt ${r.receipt_no}`)
      void qc.invalidateQueries({ queryKey: ['vouchers', rid] })
      onReceipt(r)
    },
    onError: (e) => {
      const { code, detail } = errorCode(e)
      setError(installmentErrorMessage(e))
      if (code === 'invalid_installment_no' || code === 'voucher_already_settled') {
        // definitive: nothing was collected; the schedule moved on, so start a fresh attempt on the refreshed next installment
        setUnsure(false)
        last.current = null
        key.current = newKey()
        void v.refetch()
        return
      }
      setUnsure(!code || !DEFINITIVE_PAYMENT_ERRORS.has(code) || detail === 'idempotency_pending')
    },
  })

  const short = tenderedValue !== null && next !== null && tenderedValue < next.amount
  const needsRef = Boolean(method?.requires_reference) && reference.trim() === ''
  const canCollect = Boolean(next && method) && !needsRef && !short && !collect.isPending

  return (
    <Dialog open onOpenChange={(o) => !o && !collect.isPending && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Voucher {v.data?.voucher_no ?? ''}</DialogTitle>
          <DialogDescription>
            {v.data
              ? `${v.data.customer_name}${v.data.customer_phone ? ` · ${v.data.customer_phone}` : ''} · order ${v.data.order_no ?? ''}`
              : 'Loading'}
          </DialogDescription>
        </DialogHeader>
        {v.isPending ? (
          <PageSkeleton label="Loading the voucher" />
        ) : v.isError ? (
          <ErrorState title="The voucher could not be loaded" onRetry={() => void v.refetch()} />
        ) : (
          <>
            <dl className="grid grid-cols-[1fr_auto] gap-x-3 text-sm">
              <dt>Total</dt>
              <dd className="text-right tabular-nums">{formatEtb(v.data.total)}</dd>
              <dt>Down payment</dt>
              <dd className="text-right tabular-nums">{formatEtb(v.data.down_payment)}</dd>
              <dt>Paid so far</dt>
              <dd className="text-right tabular-nums">{formatEtb(v.data.paid_amount)}</dd>
              <dt className="font-semibold">Outstanding</dt>
              <dd className="text-right font-semibold tabular-nums">{formatEtb(v.data.outstanding)}</dd>
            </dl>
            <table className="w-full text-sm">
              <caption className="sr-only">Schedule</caption>
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Due</th>
                  <th scope="col" className="text-right">
                    Amount
                  </th>
                  <th scope="col" className="text-right">
                    State
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {(v.data.installments ?? []).map((i) => (
                  <tr key={i.no}>
                    <td>{i.no}</td>
                    <td className="font-amharic">{formatEthiopianDate(i.due_date)}</td>
                    <td className="text-right tabular-nums">{formatEtb(i.amount)}</td>
                    <td className="text-right">{i.paid ? 'Paid' : 'Open'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {canManage && next && (
              <fieldset disabled={unsure || collect.isPending} className="space-y-3">
                <legend className="mb-2 text-sm font-medium text-ink">
                  Collect installment {next.no}: {formatEtb(next.amount)}
                </legend>
                {methods.data && (
                  <MethodPicker
                    name="installment-method"
                    methods={methods.data}
                    value={methodId}
                    onChange={(m) => {
                      setMethodId(m.id)
                      if (!m.affects_cash_drawer) setTendered('')
                      touch()
                    }}
                  />
                )}
                {method?.requires_reference && (
                  <FormField id="inst-reference" label="Reference">
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
                    id="inst-tendered"
                    label="Amount received (ETB)"
                    error={short ? 'Less than the installment.' : undefined}
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
              </fieldset>
            )}
            <FormError message={error} />
          </>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={collect.isPending} onClick={onClose}>
            Close
          </Button>
          {canManage && next && (
            <Button
              type="button"
              disabled={unsure ? collect.isPending : !canCollect}
              onClick={() => collect.mutate(unsure)}
            >
              {unsure ? 'Try again' : 'Collect'}
            </Button>
          )}
        </DialogFooter>
        <p className="sr-only">Dates use the Ethiopian calendar in the {timeZone} time zone.</p>
      </DialogContent>
    </Dialog>
  )
}

function NewVoucherDialog({
  onClose,
  onIssued,
}: {
  onClose: () => void
  onIssued: (v: Voucher, down: Receipt | null) => void
}) {
  const { context } = useAuth()
  const rid = context?.restaurant?.id ?? ''
  const qc = useQueryClient()
  const openDay = useQuery({
    queryKey: ordersKeys.openDay(rid),
    queryFn: fetchOpenDay,
    enabled: Boolean(rid),
    initialData: context?.open_day ?? null,
  })
  const dayId = openDay.data?.id ?? ''
  const orders = useQuery({
    queryKey: paymentsKeys.unpaid(rid, dayId),
    queryFn: () => fetchUnpaidOrders(dayId),
    enabled: Boolean(rid && dayId),
  })
  const methods = useQuery({
    queryKey: paymentsKeys.methods(rid),
    queryFn: fetchPaymentMethods,
    enabled: Boolean(rid),
  })
  const [orderId, setOrderId] = useState('')
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [down, setDown] = useState('')
  const [downMethodId, setDownMethodId] = useState<string | null>(null)
  const [downRef, setDownRef] = useState('')
  const [count, setCount] = useState('3')
  const [interval, setIntervalDays] = useState('30')
  const [error, setError] = useState<string | null>(null)
  const [unsure, setUnsure] = useState(false)
  const key = useRef(newKey())
  const last = useRef<GenerateVoucherInput | null>(null)
  const touch = () => {
    key.current = newKey()
    setError(null)
  }

  const order = orders.data?.find((o) => o.id === orderId)
  const downValue = down.trim() === '' ? 0 : parseDecimal(down, 2)
  const n = Number.parseInt(count, 10)
  const days = Number.parseInt(interval, 10)
  const preview = order && downValue !== null ? buildSchedule(order.total, downValue, n, days) : null
  const downMethod = methods.data?.find((m) => m.id === downMethodId)

  const issue = useMutation({
    mutationFn: (retry: boolean) => {
      const req: GenerateVoucherInput =
        retry && last.current
          ? last.current
          : {
              orderId,
              customerName: name.trim(),
              customerPhone: phone.trim() || null,
              downPayment: downValue ?? 0,
              downMethodId: (downValue ?? 0) > 0 ? downMethodId : null,
              downReference: (downValue ?? 0) > 0 ? downRef.trim() || null : null,
              installmentCount: n,
              intervalDays: days,
              idempotencyKey: key.current,
            }
      last.current = req
      return generateVoucher(req)
    },
    onSuccess: (r) => {
      toast.success(`Voucher ${r.voucher.voucher_no} issued`)
      void qc.invalidateQueries({ queryKey: ['vouchers', rid] })
      void qc.invalidateQueries({ queryKey: ['cashier', rid] })
      onIssued(r.voucher, r.down_receipt)
    },
    onError: (e) => {
      const { code, detail } = errorCode(e)
      setError(installmentErrorMessage(e))
      setUnsure(!code || !DEFINITIVE_PAYMENT_ERRORS.has(code) || detail === 'idempotency_pending')
    },
  })

  const needsMethod = (downValue ?? 0) > 0 && !downMethod
  const needsRef = (downValue ?? 0) > 0 && Boolean(downMethod?.requires_reference) && downRef.trim() === ''
  const canIssue = Boolean(order && preview && name.trim()) && !needsMethod && !needsRef && !issue.isPending

  return (
    <Dialog open onOpenChange={(o) => !o && !issue.isPending && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New installment voucher</DialogTitle>
          <DialogDescription>
            An unpaid order of the open business day is split into scheduled installments.
          </DialogDescription>
        </DialogHeader>
        {!openDay.data ? (
          <p role="alert" className="text-sm text-ink">
            No business day is open.
          </p>
        ) : (
          <fieldset disabled={unsure || issue.isPending} className="space-y-3">
            <FormField id="v-order" label="Order">
              {(a11y) => (
                <NativeSelect
                  {...a11y}
                  value={orderId}
                  onChange={(e) => {
                    setOrderId(e.target.value)
                    touch()
                  }}
                >
                  <option value="">Choose an unpaid order</option>
                  {(orders.data ?? []).map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.order_no} · {formatEtb(o.total)}
                      {o.table_label_snapshot ? ` · ${o.table_label_snapshot}` : ''}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </FormField>
            <FormField id="v-name" label="Customer name" hint="First, middle and last name.">
              {(a11y) => (
                <Input
                  {...a11y}
                  value={name}
                  maxLength={80}
                  autoComplete="off"
                  onChange={(e) => {
                    setName(e.target.value)
                    touch()
                  }}
                />
              )}
            </FormField>
            <FormField id="v-phone" label="Phone (optional)">
              {(a11y) => (
                <Input
                  {...a11y}
                  type="tel"
                  value={phone}
                  maxLength={40}
                  autoComplete="off"
                  onChange={(e) => {
                    setPhone(e.target.value)
                    touch()
                  }}
                />
              )}
            </FormField>
            <div className="grid grid-cols-2 gap-3">
              <FormField id="v-count" label="Installments">
                {(a11y) => (
                  <Input
                    {...a11y}
                    inputMode="numeric"
                    value={count}
                    maxLength={2}
                    onChange={(e) => {
                      setCount(e.target.value.replace(/[^0-9]/g, ''))
                      touch()
                    }}
                  />
                )}
              </FormField>
              <FormField id="v-interval" label="Frequency">
                {(a11y) => (
                  <NativeSelect
                    {...a11y}
                    value={interval}
                    onChange={(e) => {
                      setIntervalDays(e.target.value)
                      touch()
                    }}
                  >
                    {FREQUENCIES.map((f) => (
                      <option key={f.days} value={String(f.days)}>
                        {f.label}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </FormField>
            </div>
            <FormField
              id="v-down"
              label="Down payment (ETB)"
              hint="Optional; less than the total."
              error={downValue === null ? 'Enter an amount like 100 or 100.50.' : undefined}
            >
              {(a11y) => (
                <Input
                  {...a11y}
                  inputMode="decimal"
                  value={down}
                  maxLength={14}
                  autoComplete="off"
                  onChange={(e) => {
                    setDown(e.target.value)
                    touch()
                  }}
                />
              )}
            </FormField>
            {(downValue ?? 0) > 0 && methods.data && (
              <>
                <fieldset>
                  <legend className="mb-2 text-sm font-medium text-ink">Down payment method</legend>
                  <MethodPicker
                    name="down-method"
                    methods={methods.data}
                    value={downMethodId}
                    onChange={(m) => {
                      setDownMethodId(m.id)
                      touch()
                    }}
                  />
                </fieldset>
                {downMethod?.requires_reference && (
                  <FormField id="v-down-ref" label="Reference">
                    {(a11y) => (
                      <Input
                        {...a11y}
                        value={downRef}
                        maxLength={120}
                        autoComplete="off"
                        onChange={(e) => {
                          setDownRef(e.target.value)
                          touch()
                        }}
                      />
                    )}
                  </FormField>
                )}
              </>
            )}
            {order && (
              <div aria-live="polite">
                {preview ? (
                  <table className="w-full text-sm">
                    <caption className="text-left text-sm font-medium text-ink">Schedule preview</caption>
                    <tbody className="divide-y divide-line">
                      {preview.map((l) => (
                        <tr key={l.no}>
                          <td>#{l.no}</td>
                          <td>in {l.dueInDays} days</td>
                          <td className="text-right tabular-nums">{formatEtb(l.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="text-sm text-status-error">
                    The down payment must be below the total and installments from 1 to 60.
                  </p>
                )}
              </div>
            )}
          </fieldset>
        )}
        <FormError message={error} />
        <DialogFooter>
          <Button type="button" variant="outline" disabled={issue.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={unsure ? issue.isPending : !canIssue}
            onClick={() => issue.mutate(unsure)}
          >
            {unsure ? 'Try again' : 'Issue voucher'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function installmentErrorMessage(err: unknown): string {
  const { code, detail } = errorCode(err)
  if (code === 'voucher_already_settled')
    return 'This voucher is already settled; nothing is left to collect.'
  if (code === 'invalid_installment_no')
    return 'That installment was just collected. The schedule has been refreshed.'
  if (code === 'invalid_input' && detail === 'customer_name')
    return 'Enter the customer name (at most 80 characters).'
  if (code === 'invalid_input' && detail === 'customer_phone')
    return 'The phone may contain digits, spaces, + ( ) and - only.'
  if (code === 'invalid_input' && detail === 'down_payment')
    return 'The down payment must be below the total.'
  if (code === 'invalid_input' && detail === 'down_method_id')
    return 'Choose an active method for the down payment.'
  if (code === 'invalid_input' && detail === 'installment_count')
    return 'Choose between 1 and 60 installments.'
  return paymentErrorMessage(err)
}
