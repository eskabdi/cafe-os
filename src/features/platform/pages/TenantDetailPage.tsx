import { useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { Card, Facts, PageHeader } from '@/components/portal/page-header'
import { StatusBadge, statusText } from '@/components/portal/status-badge'
import { UsageBars } from '@/components/portal/usage-bars'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useStepUp } from '@/features/auth'
import { InvitationList, type InvitationRow } from '@/features/invitations/InvitationList'
import { InviteTenantAdminDialog, type InviteValues } from '@/features/invitations/InviteTenantAdminDialog'
import { ErrorState, PageSkeleton } from '@/features/shell/states'
import { formatEtb } from '@/lib/domain/decimal'
import { formatCount, formatDate, formatDateTime } from '@/lib/domain/portal'
import { restoreDeadline, type TenantDetail } from '@/lib/supabase/platform'
import { portalErrorMessage } from '@/lib/supabase/portal-errors'
import { TenantActionDialog, type TenantActionKind } from '../components/TenantActionDialog'
import { useInvitationCommand, useInviteTenantAdmin, useTenant } from '../usePlatform'

function actionsFor(t: TenantDetail, now: Date): TenantActionKind[] {
  if (t.status === 'cancelled') {
    const deadline = restoreDeadline(t.cancelled_at)
    return deadline && deadline > now ? ['restore'] : []
  }
  const out: TenantActionKind[] = ['plan']
  if (t.status === 'suspended') out.push('reactivate')
  else out.push('billing', 'suspend')
  out.push('cancel')
  return out
}

const ACTION_LABEL: Readonly<Record<TenantActionKind, string>> = {
  plan: 'Change plan',
  billing: 'Billing status',
  suspend: 'Suspend',
  reactivate: 'Reactivate',
  cancel: 'Cancel tenant',
  restore: 'Restore tenant',
}

/**
 * Tenant detail (fn_platform_get_tenant): metadata, subscription, plan, aggregate usage vs quota, Tenant Admin invitations and
 * latest invoices, plus the lifecycle actions. Never an operational row of the tenant (orders, menu, staff PINs ...).
 */
export function TenantDetailPage() {
  const { tenantId = '' } = useParams<{ tenantId: string }>()
  const [params, setParams] = useSearchParams()
  const tenant = useTenant(tenantId)
  const invite = useInviteTenantAdmin(tenantId)
  const command = useInvitationCommand(tenantId)
  const stepUp = useStepUp()
  const [action, setAction] = useState<TenantActionKind | null>(null)
  const [inviteOpen, setInviteOpen] = useState(params.get('invite') === '1')
  const [inviteError, setInviteError] = useState<string | null>(null)
  const [revoking, setRevoking] = useState<InvitationRow | null>(null)
  const [revokeError, setRevokeError] = useState<string | null>(null)

  if (tenant.isPending) return <PageSkeleton label="Loading the tenant" />
  if (tenant.isError) return <ErrorState title="The tenant could not be loaded" onRetry={() => void tenant.refetch()} />
  const t = tenant.data
  const sub = t.subscription
  const deadline = restoreDeadline(t.cancelled_at)
  const canInvite = t.status !== 'cancelled' && t.status !== 'suspended'

  const closeInvite = () => {
    setInviteOpen(false)
    setInviteError(null)
    if (params.has('invite')) {
      const p = new URLSearchParams(params)
      p.delete('invite')
      setParams(p, { replace: true })
    }
  }
  const sendInvite = async (v: InviteValues) => {
    setInviteError(null)
    try {
      await stepUp.run(() => invite.mutateAsync(v))
      toast.success(`Invitation sent to ${v.email}`)
      closeInvite()
    } catch (err) {
      setInviteError(portalErrorMessage(err))
    }
  }
  const resend = async (id: string) => {
    try {
      await stepUp.run(() => command.mutateAsync({ kind: 'resend', invitationId: id }))
      toast.success('Invitation sent again')
    } catch (err) {
      toast.error(portalErrorMessage(err))
    }
  }
  const revoke = async () => {
    if (!revoking) return
    setRevokeError(null)
    try {
      await stepUp.run(() => command.mutateAsync({ kind: 'revoke', invitationId: revoking.id }))
      toast.success('Invitation revoked')
      setRevoking(null)
    } catch (err) {
      setRevokeError(portalErrorMessage(err))
    }
  }

  return (
    <div className="space-y-5 p-4 lg:p-6">
      <Link to="/platform/tenants" className="inline-flex min-h-[44px] items-center text-sm text-ink underline underline-offset-4">
        All tenants
      </Link>
      <PageHeader
        title={t.name}
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            <StatusBadge status={t.status} />
            <span>/r/{t.slug}</span>
          </span>
        }
        actions={actionsFor(t, new Date()).map((k) => (
          <Button
            key={k}
            variant={k === 'cancel' ? 'outline' : k === 'restore' ? 'default' : 'outline'}
            className={k === 'cancel' ? 'border-status-error text-status-error' : undefined}
            onClick={() => setAction(k)}
          >
            {ACTION_LABEL[k]}
          </Button>
        ))}
      />

      {t.status === 'cancelled' && (
        <div role="note" className="rounded-card border border-status-cancelled bg-white p-4 text-sm text-ink">
          <p className="font-semibold">Cancelled {formatDateTime(t.cancelled_at)}.</p>
          <p>
            The data is kept for 1 year after cancellation and then purged.{' '}
            {deadline && deadline > new Date()
              ? `It can be restored until ${formatDate(deadline.toISOString())}.`
              : 'The retention period has ended; it can no longer be restored.'}
          </p>
        </div>
      )}
      {t.status === 'suspended' && t.suspension_reason && (
        <div role="note" className="rounded-card border border-status-error bg-white p-4 text-sm text-ink">
          Suspended {formatDateTime(t.suspended_at)}: {t.suspension_reason}
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Restaurant">
          <Facts
            items={[
              { label: 'Slug', value: t.slug },
              { label: 'Time zone', value: t.timezone },
              { label: 'Phone', value: t.phone || '—' },
              { label: 'Address', value: t.address || '—' },
              { label: 'TIN', value: t.tin || '—' },
              { label: 'Custom domain', value: t.custom_domain || '—' },
              { label: 'Onboarded', value: formatDateTime(t.onboarded_at) },
              { label: 'Created', value: formatDateTime(t.created_at) },
            ]}
          />
        </Card>
        <Card title="Subscription">
          {sub ? (
            <Facts
              items={[
                { label: 'Plan', value: `${sub.plan.name}${sub.plan.is_active ? '' : ' (retired plan)'}` },
                { label: 'Price', value: `${formatEtb(sub.plan.price_etb_monthly)} / month` },
                { label: 'Billing status', value: statusText(sub.status) },
                { label: 'Trial ends', value: formatDateTime(sub.trial_ends_at) },
                { label: 'Period', value: `${formatDate(sub.current_period_start)} – ${formatDate(sub.current_period_end)}` },
              ]}
            />
          ) : (
            <p className="text-sm text-muted-foreground">No subscription.</p>
          )}
        </Card>
        <Card title="Usage against plan">
          <p className="text-xs text-muted-foreground">
            Staff and menu items are enforced at creation; stations, terminals, storage and orders are monitored only.
          </p>
          <UsageBars usage={t.usage} limits={t.limits} overQuota={t.over_quota} />
          <p className="text-xs text-muted-foreground">
            Tenant Admins: {formatCount(Number(t.usage.active_tenant_admins ?? 0))} · Orders in the last 30 days:{' '}
            {formatCount(Number(t.usage.orders_last_30_days ?? 0))}
          </p>
        </Card>
        <Card
          title="Tenant Admin invitations"
          actions={
            canInvite ? (
              <Button variant="outline" onClick={() => setInviteOpen(true)}>
                Invite Tenant Admin
              </Button>
            ) : undefined
          }
        >
          <InvitationList
            invitations={t.invitations}
            busyId={command.isPending ? (command.variables?.invitationId ?? null) : null}
            onResend={(id) => void resend(id)}
            onRevoke={(inv) => {
              setRevokeError(null)
              setRevoking(inv)
            }}
          />
        </Card>
        <Card title="Latest invoices" actions={<Link className="inline-flex min-h-[44px] items-center text-sm text-primary underline-offset-4 hover:underline" to={`/platform/invoices?tenant=${t.id}`}>All invoices</Link>}>
          {t.recent_invoices.length === 0 ? (
            <p className="text-sm text-muted-foreground">No invoices.</p>
          ) : (
            <ul className="divide-y divide-line">
              {t.recent_invoices.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                  <span className="flex-1 text-ink">
                    {formatDate(i.period_start)} – {formatDate(i.period_end)}
                  </span>
                  <span className="tabular-nums text-ink">{formatEtb(i.amount)}</span>
                  <StatusBadge status={i.status} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <TenantActionDialog tenant={t} kind={action} onClose={() => setAction(null)} run={stepUp.run} />
      <InviteTenantAdminDialog
        open={inviteOpen && canInvite}
        tenantName={t.name}
        busy={invite.isPending}
        error={inviteError}
        onSubmit={(v) => void sendInvite(v)}
        onClose={closeInvite}
      />
      <ConfirmDialog
        open={revoking !== null}
        title="Revoke this invitation?"
        description={`The link sent to ${revoking?.email ?? ''} stops working. You can invite again later.`}
        confirmLabel="Revoke"
        busy={command.isPending}
        error={revokeError}
        onConfirm={() => void revoke()}
        onCancel={() => setRevoking(null)}
      />
      {stepUp.dialog}
    </div>
  )
}
