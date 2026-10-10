import { PageHeader } from '@/components/portal/page-header'
import { Button } from '@/components/ui/button'
import { EmptyState, ErrorState, PageSkeleton } from '@/features/shell/states'
import { formatAgeHours, formatBytes, formatDateTime } from '@/lib/domain/portal'
import { useBackupRuns, useSystemHealth } from '../usePlatform'

const STATUS_CLASS: Record<string, string> = {
  succeeded: 'text-status-success',
  failed: 'font-semibold text-status-error',
  running: 'text-status-warning',
}

/**
 * Backup runs recorded by the ops backup job (platform_backup_runs, written by the service role only). The database backups
 * themselves are Supabase-managed (daily + PITR); this page shows what the job recorded and how old the last success is.
 */
export function BackupsPage() {
  const runs = useBackupRuns()
  const health = useSystemHealth()
  if (runs.isPending) return <PageSkeleton label="Loading backups" />
  if (runs.isError) return <ErrorState title="Backups could not be loaded" onRetry={() => void runs.refetch()} />
  const rows = runs.data.pages.flat()
  const b = health.data?.backups
  return (
    <div className="space-y-5 p-4 lg:p-6">
      <PageHeader
        title="Backups"
        description={
          b
            ? b.last_success_at
              ? `Last successful backup ${formatAgeHours(b.last_success_age_hours)} ago${b.stale ? ' — older than 26 hours' : ''}.`
              : 'No successful backup recorded yet.'
            : 'Supabase-managed daily backups and point-in-time recovery, recorded by the ops backup job.'
        }
      />
      {rows.length === 0 ? (
        <EmptyState title="No backup runs recorded">The ops backup job records each run here.</EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-card border border-line bg-white">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-muted-foreground">
                <th className="px-4 py-2 font-medium">Started</th>
                <th className="px-4 py-2 font-medium">Kind</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Finished</th>
                <th className="px-4 py-2 text-right font-medium">Size</th>
                <th className="px-4 py-2 font-medium">Error</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-line">
                  <td className="px-4 py-2">{formatDateTime(r.started_at)}</td>
                  <td className="px-4 py-2">{r.kind}</td>
                  <td className={`px-4 py-2 ${STATUS_CLASS[r.status] ?? ''}`}>{r.status}</td>
                  <td className="px-4 py-2">{formatDateTime(r.finished_at)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{r.size_bytes == null ? '—' : formatBytes(r.size_bytes)}</td>
                  <td className="px-4 py-2 font-mono text-xs">{r.error_code ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {runs.hasNextPage && (
        <Button variant="outline" disabled={runs.isFetchingNextPage} onClick={() => void runs.fetchNextPage()}>
          {runs.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </Button>
      )}
    </div>
  )
}
