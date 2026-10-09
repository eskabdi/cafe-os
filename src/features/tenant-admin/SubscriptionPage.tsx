import { Card, Facts, PageHeader } from '@/components/portal/page-header'
import { StatusBadge } from '@/components/portal/status-badge'
import { UsageBars } from '@/components/portal/usage-bars'
import { ErrorState, PageSkeleton } from '@/features/shell/states'
import { formatEtb } from '@/lib/domain/decimal'
import { formatDate } from '@/lib/domain/portal'
import { useSubscriptionUsage } from './useTenantAdmin'

/** The restaurant's own plan and usage against its limits (read-only; plan changes are made by CafeOS). */
export function SubscriptionPage() {
  const sub = useSubscriptionUsage()
  if (sub.isPending) return <PageSkeleton label="Loading the subscription" />
  if (sub.isError) return <ErrorState title="The subscription could not be loaded" onRetry={() => void sub.refetch()} />
  const s = sub.data.subscription
  return (
    <div className="mx-auto max-w-3xl space-y-5 p-4 lg:p-6">
      <PageHeader title="Subscription & usage" description="To change the plan, contact CafeOS support." />
      <Card title="Plan">
        {s ? (
          <Facts
            items={[
              { label: 'Plan', value: s.plan.name },
              { label: 'Price', value: `${formatEtb(s.plan.price_etb_monthly)} / month` },
              { label: 'Status', value: <StatusBadge status={s.status} /> },
              { label: 'Current period', value: s.current_period_start ? `${formatDate(s.current_period_start)} – ${formatDate(s.current_period_end)}` : '—' },
              ...(s.trial_ends_at ? [{ label: 'Trial ends', value: formatDate(s.trial_ends_at) }] : []),
            ]}
          />
        ) : (
          <p className="text-sm text-muted-foreground">No subscription on record.</p>
        )}
      </Card>
      <Card title="Usage">
        <UsageBars usage={sub.data.usage} limits={sub.data.limits} overQuota={sub.data.over_quota} />
      </Card>
    </div>
  )
}
