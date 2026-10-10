import { Link } from 'react-router-dom'
import { Card, PageHeader } from '@/components/portal/page-header'
import { StatusBadge } from '@/components/portal/status-badge'
import { ErrorState, PageSkeleton } from '@/features/shell/states'
import { formatAgeHours, formatCount, formatDateTime } from '@/lib/domain/portal'
import { TENANT_STATUSES } from '@/lib/supabase/platform'
import { limitMetrics } from '@/lib/supabase/portal-errors'
import { platformTenantPath } from '../platform-nav'
import { useSystemHealth, useTenantList } from '../usePlatform'

/** Newest tenants scanned for the list-level over_quota aggregate (one list call, no per-tenant detail reads). */
export const OVERQUOTA_SCAN_LIMIT = 100

/**
 * Over-quota tenants from the tenant LIST's aggregate `over_quota` field. Deliberately no per-tenant detail calls: reading a
 * tenant's detail is audited ('tenant.viewed'), and an overview must not flood the platform audit trail. When the backend
 * does not report the aggregate in the list, the panel says so instead of guessing.
 */
function OverQuotaPanel() {
  const list = useTenantList({ limit: OVERQUOTA_SCAN_LIMIT, offset: 0 })
  if (list.isPending) return <p className="text-sm text-muted-foreground">Checking usage…</p>
  if (list.isError) return <p className="text-sm text-status-error">Usage could not be checked.</p>
  const items = list.data.items.filter((t) => t.status !== 'cancelled')
  if (items.length > 0 && items.every((t) => t.over_quota === undefined)) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="overquota-unavailable">
        Usage per tenant is shown on each tenant’s page. A platform-wide over-quota summary is not available yet.
      </p>
    )
  }
  const over = items.filter((t) => (t.over_quota?.length ?? 0) > 0)
  const total = list.data.total
  return (
    <div className="space-y-3">
      {over.length === 0 ? (
        <p className="text-sm text-muted-foreground">No tenant is over its plan quota.</p>
      ) : (
        <ul className="divide-y divide-line">
          {over.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center gap-2 py-2">
              <Link className="inline-flex min-h-[44px] items-center font-medium text-ink underline-offset-4 hover:underline" to={platformTenantPath(t.id)}>
                {t.name}
              </Link>
              <span className="text-sm text-status-error">over: {limitMetrics((t.over_quota ?? []).join(',')).join(', ')}</span>
            </li>
          ))}
        </ul>
      )}
      {total > OVERQUOTA_SCAN_LIMIT && (
        <p className="text-xs text-muted-foreground">
          Checked the {formatCount(OVERQUOTA_SCAN_LIMIT)} newest tenants of {formatCount(total)}.
        </p>
      )}
    </div>
  )
}

/** Platform overview: tenant counts by status, over-quota tenants, last backup and a health summary (aggregates only). */
export function OverviewPage() {
  const health = useSystemHealth()
  if (health.isPending) return <PageSkeleton label="Loading the overview" />
  if (health.isError) return <ErrorState title="The overview could not be loaded" onRetry={() => void health.refetch()} />
  const h = health.data
  return (
    <div className="space-y-5 p-4 lg:p-6">
      <PageHeader title="Overview" description={`Checked ${formatDateTime(h.checked_at)}.`} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Tenants">
          <p className="text-3xl font-semibold tabular-nums text-ink" data-testid="tenant-total">
            {formatCount(h.tenants.total)}
          </p>
          <ul className="flex flex-wrap gap-3" aria-label="Tenants by status">
            {TENANT_STATUSES.map((s) => (
              <li key={s} className="flex items-center gap-2 text-sm">
                <StatusBadge status={s} />
                <span className="tabular-nums text-ink">{formatCount(h.tenants.by_status[s] ?? 0)}</span>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Backups">
          <p className={h.backups.stale ? 'font-semibold text-status-error' : 'text-status-success'}>
            {h.backups.last_success_at
              ? `Last successful backup ${formatAgeHours(h.backups.last_success_age_hours)} ago (${formatDateTime(h.backups.last_success_at)})`
              : 'No successful backup recorded'}
            {h.backups.stale && ' — older than 26 hours'}
          </p>
          <p className="text-sm text-muted-foreground">Failures in the last 7 days: {formatCount(h.counters.backup_failures_7d)}</p>
        </Card>
        <Card title="Over-quota tenants">
          <OverQuotaPanel />
        </Card>
        <Card title="Health summary">
          <ul className="space-y-1 text-sm text-ink">
            <li>Database: {h.database.reachable ? 'reachable' : 'unreachable'} (PostgreSQL {h.database.server_version})</li>
            <li>
              Connections: {formatCount(h.database.connections)} of {formatCount(h.database.max_connections)}
            </li>
            <li>Migrations applied: {formatCount(h.migrations.count)}</li>
            <li>Pending invitations: {formatCount(h.counters.invitations_pending)}</li>
            <li>Active PIN lockouts: {formatCount(h.counters.pin_lockouts_active)}</li>
          </ul>
          <Link className="inline-flex min-h-[44px] items-center text-sm font-medium text-primary underline-offset-4 hover:underline" to="/platform/health">
            Open system health
          </Link>
        </Card>
      </div>
    </div>
  )
}
