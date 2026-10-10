import { useEffect, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { PageHeader } from '@/components/portal/page-header'
import { StatusBadge, statusText } from '@/components/portal/status-badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { FormError, FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/select'
import { useStepUp } from '@/features/auth'
import { EmptyState, ErrorState, PageSkeleton } from '@/features/shell/states'
import { formatEtb, parseDecimal } from '@/lib/domain/decimal'
import { formatDate } from '@/lib/domain/portal'
import {
  INVOICE_STATUSES,
  PLATFORM_BILLING_CHANNELS,
  type Invoice,
  type InvoiceStatus,
  type PlatformBillingChannel,
} from '@/lib/supabase/platform'
import { portalErrorMessage } from '@/lib/supabase/portal-errors'
import { useCreateInvoice, useInvoices, useSetInvoiceStatus, useTenantList } from '../usePlatform'

const isInvoiceStatus = (v: string): v is InvoiceStatus => (INVOICE_STATUSES as readonly string[]).includes(v)
const CHANNEL_TEXT = (c: string) => c.replace(/_/g, ' ')
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function CreateInvoiceDialog({ open, tenantId, onClose, run }: { open: boolean; tenantId: string; onClose: () => void; run: ReturnType<typeof useStepUp>['run'] }) {
  const tenants = useTenantList({ limit: 100, offset: 0 })
  const create = useCreateInvoice()
  const [rid, setRid] = useState(tenantId)
  const [amount, setAmount] = useState('')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [reference, setReference] = useState('')
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (open) {
      setRid(tenantId)
      setAmount('')
      setStart('')
      setEnd('')
      setReference('')
      setError(null)
    }
  }, [open, tenantId])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const n = parseDecimal(amount, 2)
    if (!rid) return setError('Choose a tenant.')
    if (n === null || n > 10_000_000) return setError('Enter an amount from 0 to 10,000,000 ETB with at most 2 decimals.')
    if (!DATE_RE.test(start) || !DATE_RE.test(end) || end < start) return setError('Enter a period: end on or after start.')
    if (reference.trim().length > 120) return setError('The reference can be at most 120 characters.')
    setError(null)
    try {
      await run(() => create.mutateAsync({ restaurantId: rid, amount: n, periodStart: start, periodEnd: end, reference: reference.trim() || null }))
      toast.success('Invoice created')
      onClose()
    } catch (err) {
      setError(portalErrorMessage(err))
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !create.isPending && onClose()}>
      <DialogContent>
        <form onSubmit={(e) => void submit(e)} noValidate className="space-y-4">
          <DialogHeader>
            <DialogTitle>New invoice</DialogTitle>
            <DialogDescription>A pending subscription invoice in ETB. One live invoice per tenant and period.</DialogDescription>
          </DialogHeader>
          <FormField id="inv-tenant" label="Tenant">
            {(a) => (
              <NativeSelect {...a} value={rid} onChange={(e) => setRid(e.target.value)}>
                <option value="">Choose a tenant</option>
                {(tenants.data?.items ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.slug})
                  </option>
                ))}
              </NativeSelect>
            )}
          </FormField>
          <FormField id="inv-amount" label="Amount (ETB)">
            {(a) => <Input {...a} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}
          </FormField>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField id="inv-start" label="Period start">
              {(a) => <Input {...a} type="date" value={start} onChange={(e) => setStart(e.target.value)} />}
            </FormField>
            <FormField id="inv-end" label="Period end">
              {(a) => <Input {...a} type="date" value={end} onChange={(e) => setEnd(e.target.value)} />}
            </FormField>
          </div>
          <FormField id="inv-ref" label="Reference (optional)">
            {(a) => <Input {...a} maxLength={120} value={reference} onChange={(e) => setReference(e.target.value)} />}
          </FormField>
          <FormError message={error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={create.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? 'Creating…' : 'Create invoice'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function InvoiceStatusDialog({ invoice, onClose, run }: { invoice: Invoice | null; onClose: () => void; run: ReturnType<typeof useStepUp>['run'] }) {
  const set = useSetInvoiceStatus()
  const [status, setStatus] = useState<'paid' | 'overdue' | 'void'>('paid')
  const [method, setMethod] = useState<PlatformBillingChannel | ''>('')
  const [reference, setReference] = useState('')
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (invoice) {
      setStatus('paid')
      setMethod('')
      setReference(invoice.reference ?? '')
      setError(null)
    }
  }, [invoice])
  if (!invoice) return null
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (status === 'paid' && !method) return setError('Choose the payment channel for a paid invoice.')
    setError(null)
    try {
      await run(() =>
        set.mutateAsync({ id: invoice.id, status, method: status === 'paid' ? (method as PlatformBillingChannel) : null, reference: reference.trim() || null }),
      )
      toast.success(`Invoice marked ${statusText(status).toLowerCase()}`)
      onClose()
    } catch (err) {
      setError(portalErrorMessage(err))
    }
  }
  return (
    <Dialog open onOpenChange={(next) => !next && !set.isPending && onClose()}>
      <DialogContent>
        <form onSubmit={(e) => void submit(e)} noValidate className="space-y-4">
          <DialogHeader>
            <DialogTitle>Update invoice</DialogTitle>
            <DialogDescription>
              {invoice.restaurant.name}: {formatEtb(invoice.amount)} for {formatDate(invoice.period_start)} – {formatDate(invoice.period_end)}. Paid
              and void are final.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="inv-status">New status</Label>
            <NativeSelect id="inv-status" value={status} onChange={(e) => setStatus(e.target.value as 'paid' | 'overdue' | 'void')}>
              <option value="paid">Paid</option>
              {invoice.status === 'pending' && <option value="overdue">Overdue</option>}
              <option value="void">Void</option>
            </NativeSelect>
          </div>
          {status === 'paid' && (
            <div className="space-y-1.5">
              <Label htmlFor="inv-method">Payment channel</Label>
              <NativeSelect id="inv-method" value={method} onChange={(e) => setMethod(e.target.value as PlatformBillingChannel | '')}>
                <option value="">Choose</option>
                {PLATFORM_BILLING_CHANNELS.map((c) => (
                  <option key={c} value={c}>
                    {CHANNEL_TEXT(c)}
                  </option>
                ))}
              </NativeSelect>
            </div>
          )}
          <FormField id="inv-status-ref" label="Reference (optional)">
            {(a) => <Input {...a} maxLength={120} value={reference} onChange={(e) => setReference(e.target.value)} />}
          </FormField>
          <FormError message={error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={set.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={set.isPending}>
              {set.isPending ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Platform invoices (keyset paging), create, and status changes (pending → paid / overdue / void; paid and void are final). */
export function InvoicesPage() {
  const [params, setParams] = useSearchParams()
  const tenantId = params.get('tenant') ?? ''
  const statusParam = params.get('status') ?? ''
  const status: InvoiceStatus | '' = isInvoiceStatus(statusParam) ? statusParam : ''
  const invoices = useInvoices({ restaurantId: tenantId, status })
  const stepUp = useStepUp()
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<Invoice | null>(null)

  const setFilter = (k: string, v: string) => {
    const p = new URLSearchParams(params)
    if (v) p.set(k, v)
    else p.delete(k)
    setParams(p, { replace: true })
  }
  const rows = invoices.data?.pages.flat() ?? []

  return (
    <div className="space-y-5 p-4 lg:p-6">
      <PageHeader title="Invoices" description="Subscription invoices of all tenants, newest first. Amounts in ETB." actions={<Button onClick={() => setCreating(true)}>New invoice</Button>} />
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="inv-filter-status">Status</Label>
          <NativeSelect id="inv-filter-status" value={status} onChange={(e) => setFilter('status', e.target.value)}>
            <option value="">All statuses</option>
            {INVOICE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {statusText(s)}
              </option>
            ))}
          </NativeSelect>
        </div>
        {tenantId && (
          <Button variant="outline" onClick={() => setFilter('tenant', '')}>
            Show all tenants
          </Button>
        )}
      </div>
      {invoices.isPending ? (
        <PageSkeleton label="Loading invoices" />
      ) : invoices.isError ? (
        <ErrorState title="Invoices could not be loaded" level={2} onRetry={() => void invoices.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title="No invoices" level={2} />
      ) : (
        <div className="overflow-x-auto rounded-card border border-line bg-white">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Invoices</caption>
            <thead className="border-b border-line text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th scope="col" className="px-4 py-3">Tenant</th>
                <th scope="col" className="px-4 py-3">Period</th>
                <th scope="col" className="px-4 py-3">Amount</th>
                <th scope="col" className="px-4 py-3">Status</th>
                <th scope="col" className="px-4 py-3"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((i) => (
                <tr key={i.id}>
                  <td className="px-4 py-2 text-ink">{i.restaurant.name}</td>
                  <td className="px-4 py-2 tabular-nums text-ink">
                    {formatDate(i.period_start)} – {formatDate(i.period_end)}
                  </td>
                  <td className="px-4 py-2 tabular-nums text-ink">{formatEtb(i.amount)}</td>
                  <td className="px-4 py-2">
                    <StatusBadge status={i.status} />
                    {i.method && <span className="ml-2 text-xs text-muted-foreground">{CHANNEL_TEXT(i.method)}</span>}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {(i.status === 'pending' || i.status === 'overdue') && (
                      <Button variant="outline" onClick={() => setEditing(i)} aria-label={`Update invoice of ${i.restaurant.name}`}>
                        Update
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {invoices.hasNextPage && (
        <Button variant="outline" disabled={invoices.isFetchingNextPage} onClick={() => void invoices.fetchNextPage()}>
          {invoices.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </Button>
      )}
      <CreateInvoiceDialog open={creating} tenantId={tenantId} onClose={() => setCreating(false)} run={stepUp.run} />
      <InvoiceStatusDialog invoice={editing} onClose={() => setEditing(null)} run={stepUp.run} />
      {stepUp.dialog}
    </div>
  )
}
