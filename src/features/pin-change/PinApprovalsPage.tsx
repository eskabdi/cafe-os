import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
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
import { RequirePermission, useAuth } from '@/features/auth'
import {
  approvePinChange,
  listPendingPinChanges,
  rejectPinChange,
  RpcError,
  type PendingPinChange,
} from '@/lib/supabase/rpc'
import { pinApprovalErrorMessage } from './pin-approval-errors'
import { PIN_APPROVALS_KEY, tenantHomePath } from './pin-paths'

type Decision = 'approve' | 'reject'

const FALLBACK_NAME = 'A staff member'
const displayName = (p: PendingPinChange) => p.user_name?.trim() || FALLBACK_NAME

function when(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : format(d, 'yyyy-MM-dd HH:mm')
}

const codeOf = (e: unknown) => (e instanceof RpcError ? e.code : undefined)

/** Tenant settings > PIN approvals (maker-checker). Gate is UX only: the RPCs check users.manage, step-up and tenant server-side. */
export function PinApprovalsPage() {
  return (
    <RequirePermission permission="users.manage">
      <PinApprovalsContent />
    </RequirePermission>
  )
}

function PinApprovalsContent() {
  const { context } = useAuth()
  const slug = context?.restaurant?.slug ?? ''
  const qc = useQueryClient()
  const pending = useQuery({ queryKey: PIN_APPROVALS_KEY, queryFn: listPendingPinChanges })
  const [confirm, setConfirm] = useState<{ item: PendingPinChange; decision: Decision } | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: Decision }) =>
      decision === 'approve' ? approvePinChange(id) : rejectPinChange(id),
  })

  const onConfirm = async () => {
    if (!confirm) return
    const { item, decision } = confirm
    const name = displayName(item)
    setActionError(null)
    try {
      await decide.mutateAsync({ id: item.profile_id, decision })
      toast.success(
        decision === 'approve' ? `Approved the new PIN for ${name}` : `Rejected the new PIN for ${name}`,
      )
      void qc.invalidateQueries({ queryKey: PIN_APPROVALS_KEY })
    } catch (err) {
      const code = codeOf(err)
      setActionError(pinApprovalErrorMessage(code))
      if (code === 'not_found') void qc.invalidateQueries({ queryKey: PIN_APPROVALS_KEY })
    } finally {
      setConfirm(null)
    }
  }

  const confirmName = confirm ? displayName(confirm.item) : ''
  return (
    <main className="mx-auto max-w-2xl space-y-6 p-6">
      <header className="space-y-1">
        <Link className="text-sm text-ink underline underline-offset-4" to={tenantHomePath(slug)}>
          Back
        </Link>
        <h1 className="text-xl font-semibold text-ink">PIN approvals</h1>
        <p className="text-sm text-muted-foreground">
          Staff whose PIN was used on another device had to choose a new one. Approve the change to give their
          access back, or reject it so they choose again.
        </p>
      </header>

      {actionError && (
        <p role="alert" className="text-sm font-medium text-status-error">
          {actionError}
        </p>
      )}

      <section aria-labelledby="pending-title" className="space-y-3">
        <h2 id="pending-title" className="text-base font-semibold text-ink">
          Waiting for approval
        </h2>
        {pending.isPending && (
          <p role="status" className="text-sm text-muted-foreground">
            Loading…
          </p>
        )}
        {pending.isError && (
          <p role="alert" className="text-sm font-medium text-status-error">
            {pinApprovalErrorMessage(codeOf(pending.error))}
          </p>
        )}
        {pending.data && pending.data.length === 0 && (
          <p className="text-sm text-muted-foreground">No PIN changes are waiting for approval.</p>
        )}
        {pending.data && pending.data.length > 0 && (
          <ul className="divide-y divide-line rounded-card border border-line bg-white">
            {pending.data.map((p) => {
              const name = displayName(p)
              return (
                <li key={p.profile_id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                  <div className="min-w-0 space-y-0.5">
                    <p className="break-words font-medium text-ink">{name}</p>
                    <p className="text-sm text-muted-foreground">
                      {[p.role_label, when(p.requested_at) && `Requested ${when(p.requested_at)}`]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      aria-label={`Reject ${name}`}
                      onClick={() => setConfirm({ item: p, decision: 'reject' })}
                    >
                      Reject
                    </Button>
                    <Button
                      aria-label={`Approve ${name}`}
                      onClick={() => setConfirm({ item: p, decision: 'approve' })}
                    >
                      Approve
                    </Button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <Dialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirm?.decision === 'approve'
                ? `Approve the new PIN for ${confirmName}?`
                : `Reject the new PIN for ${confirmName}?`}
            </DialogTitle>
            <DialogDescription>
              {confirm?.decision === 'approve'
                ? `${confirmName} gets their access back right away.`
                : `${confirmName} keeps no access and must choose a different PIN.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button onClick={() => void onConfirm()} disabled={decide.isPending}>
              {confirm?.decision === 'approve' ? 'Approve PIN' : 'Reject PIN'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  )
}
