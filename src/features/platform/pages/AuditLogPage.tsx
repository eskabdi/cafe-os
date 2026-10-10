import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { PageHeader } from '@/components/portal/page-header'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { EmptyState, ErrorState, PageSkeleton } from '@/features/shell/states'
import { formatDateTime } from '@/lib/domain/portal'
import type { AuditFilter } from '@/lib/supabase/platform'
import { platformTenantPath } from '../platform-nav'
import { useAuditLog } from '../usePlatform'

const ACTION_RE = /^[a-z_.]{0,64}$/

/** Platform audit log (admin_audit_log), newest first, keyset paging; filter by action prefix (e.g. "tenant.", "device."). */
export function AuditLogPage() {
  const [filter, setFilter] = useState<AuditFilter>({})
  const [draft, setDraft] = useState('')
  const log = useAuditLog(filter)
  const apply = (e: FormEvent) => {
    e.preventDefault()
    const v = draft.trim().toLowerCase()
    if (!ACTION_RE.test(v)) return
    setFilter(v ? { actionPrefix: v } : {})
  }
  return (
    <div className="space-y-5 p-4 lg:p-6">
      <PageHeader title="Audit log" description="Every platform action, by Super Admin. Entries cannot be edited or deleted." />
      <form onSubmit={apply} className="flex flex-wrap items-end gap-2" role="search">
        <div className="space-y-1">
          <Label htmlFor="audit-action">Action starts with</Label>
          <Input id="audit-action" value={draft} placeholder="tenant." onChange={(e) => setDraft(e.target.value)} maxLength={64} />
        </div>
        <Button type="submit" variant="outline">
          Filter
        </Button>
      </form>
      {log.isPending && <PageSkeleton label="Loading the audit log" />}
      {log.isError && <ErrorState title="The audit log could not be loaded" onRetry={() => void log.refetch()} />}
      {log.isSuccess && log.data.pages.flat().length === 0 && <EmptyState title="No entries">Nothing matches this filter.</EmptyState>}
      {log.isSuccess && log.data.pages.flat().length > 0 && (
        <div className="overflow-x-auto rounded-card border border-line bg-white">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-muted-foreground">
                <th className="px-4 py-2 font-medium">When</th>
                <th className="px-4 py-2 font-medium">Action</th>
                <th className="px-4 py-2 font-medium">Super Admin</th>
                <th className="px-4 py-2 font-medium">Tenant</th>
              </tr>
            </thead>
            <tbody>
              {log.data.pages.flat().map((e) => (
                <tr key={e.id} className="border-t border-line">
                  <td className="whitespace-nowrap px-4 py-2">{formatDateTime(e.created_at)}</td>
                  <td className="px-4 py-2 font-mono text-xs">{e.action}</td>
                  <td className="px-4 py-2">{e.actor?.full_name ?? 'System'}</td>
                  <td className="px-4 py-2">
                    {e.restaurant ? (
                      <Link className="text-primary underline-offset-4 hover:underline" to={platformTenantPath(e.restaurant.id)}>
                        {e.restaurant.name}
                      </Link>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {log.hasNextPage && (
        <Button variant="outline" disabled={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()}>
          {log.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </Button>
      )}
    </div>
  )
}
