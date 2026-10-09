import { useQuery } from '@tanstack/react-query'
import { Card, Facts, PageHeader } from '@/components/portal/page-header'
import { Button } from '@/components/ui/button'
import { ErrorState, PageSkeleton } from '@/features/shell/states'
import { formatAgeHours, formatBytes, formatCount, formatDateTime } from '@/lib/domain/portal'
import { pingEdgeFunctions } from '@/lib/supabase/edge-functions'
import { useSystemHealth } from '../usePlatform'

/** System health: database-side checks (fn_platform_system_health) and Edge Function reachability. Aggregates only. */
export function HealthPage() {
  const health = useSystemHealth()
  const edge = useQuery({ queryKey: ['platform', 'edge-ping'], queryFn: () => pingEdgeFunctions(), retry: false })
  if (health.isPending) return <PageSkeleton label="Loading system health" />
  if (health.isError) return <ErrorState title="System health could not be loaded" onRetry={() => void health.refetch()} />
  const h = health.data
  return (
    <div className="space-y-5 p-4 lg:p-6">
      <PageHeader
        title="System health"
        description={`Checked ${formatDateTime(h.checked_at)}.`}
        actions={
          <Button variant="outline" onClick={() => void Promise.all([health.refetch(), edge.refetch()])}>
            Check again
          </Button>
        }
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Database">
          <Facts
            items={[
              { label: 'Status', value: h.database.reachable ? 'Reachable' : 'Unreachable' },
              { label: 'Version', value: `PostgreSQL ${h.database.server_version}` },
              { label: 'Size', value: formatBytes(h.database.size_bytes) },
              { label: 'Up since', value: formatDateTime(h.database.started_at) },
              { label: 'Connections', value: `${formatCount(h.database.connections)} of ${formatCount(h.database.max_connections)}` },
              { label: 'Migrations', value: `${formatCount(h.migrations.count)} (${h.migrations.latest ?? 'unknown'})` },
            ]}
          />
        </Card>
        <Card title="Edge Functions">
          {edge.isPending && <p role="status" className="text-sm text-muted-foreground">Checking…</p>}
          {edge.isError && <p className="text-sm text-status-error">Reachability could not be checked.</p>}
          {edge.isSuccess && (
            <ul className="space-y-1 text-sm" aria-label="Edge Function reachability">
              {edge.data.map((f) => (
                <li key={f.name} className="flex justify-between gap-3">
                  <span className="font-mono text-ink">{f.name}</span>
                  <span className={f.reachable ? 'text-status-success' : 'font-semibold text-status-error'}>
                    {f.reachable ? 'reachable' : 'unreachable'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Backups">
          <p className={h.backups.stale ? 'font-semibold text-status-error' : 'text-status-success'}>
            {h.backups.last_success_at
              ? `Last success ${formatAgeHours(h.backups.last_success_age_hours)} ago`
              : 'No successful backup recorded'}
          </p>
          {h.backups.last_run && (
            <p className="text-sm text-muted-foreground">
              Last run: {h.backups.last_run.kind}, {h.backups.last_run.status}, started {formatDateTime(h.backups.last_run.started_at)}
            </p>
          )}
        </Card>
        <Card title="Counters">
          <Facts
            items={[
              { label: 'Tenant audit events (24 h)', value: formatCount(h.counters.tenant_audit_events_24h) },
              { label: 'Platform audit events (24 h)', value: formatCount(h.counters.platform_audit_events_24h) },
              { label: 'Active PIN lockouts', value: formatCount(h.counters.pin_lockouts_active) },
              { label: 'PIN changes awaiting approval', value: formatCount(h.counters.pin_changes_pending_approval) },
              { label: 'Pending invitations', value: formatCount(h.counters.invitations_pending) },
              { label: 'Expired invitations', value: formatCount(h.counters.invitations_expired) },
              { label: 'Backup failures (7 days)', value: formatCount(h.counters.backup_failures_7d) },
            ]}
          />
        </Card>
        <Card title="Largest tables">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-muted-foreground">
                <th className="py-1 font-medium">Table</th>
                <th className="py-1 text-right font-medium">Size</th>
                <th className="py-1 text-right font-medium">Rows (est.)</th>
              </tr>
            </thead>
            <tbody>
              {h.largest_tables.map((t) => (
                <tr key={t.table} className="border-t border-line">
                  <td className="py-1 font-mono text-ink">{t.table}</td>
                  <td className="py-1 text-right tabular-nums">{formatBytes(t.total_bytes)}</td>
                  <td className="py-1 text-right tabular-nums">{formatCount(t.estimated_rows)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Card title="Storage">
          <ul className="space-y-1 text-sm">
            {h.storage.map((b) => (
              <li key={b.bucket} className="flex justify-between gap-3">
                <span className="font-mono text-ink">{b.bucket}</span>
                <span className="tabular-nums">
                  {formatCount(b.objects)} objects · {formatBytes(b.bytes)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  )
}
