import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ReasonDialog } from '@/components/portal/reason-dialog'
import { statusText } from '@/components/portal/status-badge'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/select'
import type { StepUpRunner } from '@/features/auth'
import { formatEtb } from '@/lib/domain/decimal'
import { BILLING_STATUSES, type BillingStatus, type TenantDetail } from '@/lib/supabase/platform'
import { planChangeErrorMessage, portalErrorMessage } from '@/lib/supabase/portal-errors'
import { usePlans, useTenantAction } from '../usePlatform'

export type TenantActionKind = 'plan' | 'billing' | 'suspend' | 'reactivate' | 'cancel' | 'restore'

const COPY: Readonly<Record<TenantActionKind, { title: string; confirm: string; description: string }>> = {
  plan: {
    title: 'Change plan',
    confirm: 'Change plan',
    description: 'A plan below the tenant’s current usage is refused; the server names the exceeded limits.',
  },
  billing: {
    title: 'Set billing status',
    confirm: 'Save status',
    description: 'Past due makes the tenant read-only until billing is settled. Suspension and cancellation have their own actions.',
  },
  suspend: {
    title: 'Suspend tenant',
    confirm: 'Suspend',
    description: 'Every user of this restaurant loses access immediately. Data is kept; you can reactivate later.',
  },
  reactivate: {
    title: 'Reactivate tenant',
    confirm: 'Reactivate',
    description: 'Restores the status the tenant had before the suspension.',
  },
  cancel: {
    title: 'Cancel tenant',
    confirm: 'Cancel tenant',
    description:
      'Access ends for everyone and pending invitations are revoked. Data is kept for 1 year, can be restored within that time, and is then purged.',
  },
  restore: {
    title: 'Restore tenant',
    confirm: 'Restore tenant',
    description: 'Brings the cancelled tenant back as active. Revoked invitations stay revoked: invite a Tenant Admin again if needed.',
  },
}

/** One dialog for the audited lifecycle commands; cancel and restore need the slug typed. Sensitive: step-up aware. */
export function TenantActionDialog({
  tenant,
  kind,
  onClose,
  run,
}: {
  tenant: TenantDetail
  kind: TenantActionKind | null
  onClose: () => void
  run: StepUpRunner['run']
}) {
  const plans = usePlans()
  const mutate = useTenantAction(tenant.id)
  const [planId, setPlanId] = useState('')
  const [billing, setBilling] = useState<BillingStatus>('active')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!kind) return
    setError(null)
    setPlanId(tenant.subscription?.plan.id ?? '')
    const s = tenant.status
    setBilling(s === 'trialing' || s === 'active' || s === 'past_due' ? s : 'active')
  }, [kind, tenant])

  if (!kind) return null
  const copy = COPY[kind]
  const typed = kind === 'cancel' || kind === 'restore'
  const planChanged = kind !== 'plan' || (planId !== '' && planId !== tenant.subscription?.plan.id)
  const billingChanged = kind !== 'billing' || billing !== tenant.status

  const confirm = async (reason: string, slug: string) => {
    setError(null)
    try {
      const res = await run(() =>
        mutate.mutateAsync(
          kind === 'plan'
            ? { kind, planId, reason }
            : kind === 'billing'
              ? { kind, status: billing, reason }
              : kind === 'cancel' || kind === 'restore'
                ? { kind, reason, confirmSlug: slug }
                : { kind, reason },
        ),
      )
      toast.success(res.changed ? `${copy.title}: done` : 'Nothing to change')
      onClose()
    } catch (err) {
      setError(kind === 'plan' ? planChangeErrorMessage(err) : portalErrorMessage(err))
    }
  }

  return (
    <ReasonDialog
      open
      title={`${copy.title}: ${tenant.name}`}
      description={copy.description}
      confirmLabel={copy.confirm}
      busy={mutate.isPending}
      error={error}
      destructive={kind === 'cancel' || kind === 'suspend'}
      confirmText={typed ? tenant.slug : undefined}
      confirmTextLabel={typed ? `Type the slug ${tenant.slug} to confirm` : undefined}
      canSubmit={planChanged && billingChanged}
      onConfirm={(r, s) => void confirm(r, s)}
      onCancel={onClose}
    >
      {kind === 'plan' && (
        <div className="space-y-1.5">
          <Label htmlFor="action-plan">New plan</Label>
          <NativeSelect id="action-plan" value={planId} onChange={(e) => setPlanId(e.target.value)}>
            <option value="">Choose a plan</option>
            {(plans.data ?? [])
              .filter((p) => p.is_active || p.id === tenant.subscription?.plan.id)
              .map((p) => (
                <option key={p.id} value={p.id} disabled={!p.is_active}>
                  {p.name} ({formatEtb(p.price_etb_monthly)} / month){p.id === tenant.subscription?.plan.id ? ' – current' : ''}
                </option>
              ))}
          </NativeSelect>
        </div>
      )}
      {kind === 'billing' && (
        <div className="space-y-1.5">
          <Label htmlFor="action-billing">Billing status</Label>
          <NativeSelect id="action-billing" value={billing} onChange={(e) => setBilling(e.target.value as BillingStatus)}>
            {BILLING_STATUSES.map((s) => (
              <option key={s} value={s}>
                {statusText(s)}
              </option>
            ))}
          </NativeSelect>
        </div>
      )}
    </ReasonDialog>
  )
}
