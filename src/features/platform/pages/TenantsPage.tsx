import { useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Plus } from 'lucide-react'
import { PageHeader } from '@/components/portal/page-header'
import { StatusBadge } from '@/components/portal/status-badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/select'
import { EmptyState, ErrorState, PageSkeleton } from '@/features/shell/states'
import { formatCount, formatDate } from '@/lib/domain/portal'
import { TENANT_STATUSES, type TenantStatus } from '@/lib/supabase/platform'
import { statusText } from '@/components/portal/status-badge'
import { platformTenantPath } from '../platform-nav'
import { PAGE_SIZE, usePlans, useTenantList } from '../usePlatform'

const isStatus = (v: string): v is TenantStatus => (TENANT_STATUSES as readonly string[]).includes(v)

/** Tenants: search by name / slug, filter by status and plan, offset paging (fn_platform_list_tenants). Metadata only. */
export function TenantsPage() {
  const [params, setParams] = useSearchParams()
  const search = params.get('q') ?? ''
  const statusParam = params.get('status') ?? ''
  const status: TenantStatus | '' = isStatus(statusParam) ? statusParam : ''
  const planId = params.get('plan') ?? ''
  const page = Math.max(0, Number.parseInt(params.get('page') ?? '0', 10) || 0)
  const [draft, setDraft] = useState(search)

  const plans = usePlans()
  const list = useTenantList({ search, status, planId, limit: PAGE_SIZE, offset: page * PAGE_SIZE })

  const update = (next: Record<string, string>) => {
    const p = new URLSearchParams(params)
    for (const [k, v] of Object.entries(next)) {
      if (v) p.set(k, v)
      else p.delete(k)
    }
    setParams(p, { replace: true })
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    update({ q: draft.trim().slice(0, 100), page: '' })
  }

  const total = list.data?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="space-y-5 p-4 lg:p-6">
      <PageHeader
        title="Tenants"
        description="Restaurants on CafeOS: metadata, subscription and usage only."
        actions={
          <Link to="/platform/tenants/new" className={buttonVariants()}>
            <Plus aria-hidden="true" className="h-4 w-4" />
            Create tenant
          </Link>
        }
      />
      <form onSubmit={submit} className="flex flex-wrap items-end gap-3" role="search" aria-label="Filter tenants">
        <div className="min-w-[14rem] flex-1 space-y-1.5">
          <Label htmlFor="tenant-search">Search name or slug</Label>
          <Input id="tenant-search" value={draft} maxLength={100} onChange={(e) => setDraft(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="tenant-status">Status</Label>
          <NativeSelect id="tenant-status" value={status} onChange={(e) => update({ status: e.target.value, page: '' })}>
            <option value="">All statuses</option>
            {TENANT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {statusText(s)}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="tenant-plan">Plan</Label>
          <NativeSelect id="tenant-plan" value={planId} onChange={(e) => update({ plan: e.target.value, page: '' })}>
            <option value="">All plans</option>
            {(plans.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </NativeSelect>
        </div>
        <Button type="submit" variant="outline">
          Search
        </Button>
      </form>

      {list.isPending ? (
        <PageSkeleton label="Loading tenants" />
      ) : list.isError ? (
        <ErrorState title="Tenants could not be loaded" level={2} onRetry={() => void list.refetch()} />
      ) : list.data.items.length === 0 ? (
        <EmptyState title="No tenants match" level={2}>
          <p>Change the filters or create a tenant.</p>
        </EmptyState>
      ) : (
        <>
          <div className="overflow-x-auto rounded-card border border-line bg-white">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Tenants</caption>
              <thead className="border-b border-line text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th scope="col" className="px-4 py-3">Tenant</th>
                  <th scope="col" className="px-4 py-3">Status</th>
                  <th scope="col" className="px-4 py-3">Plan</th>
                  <th scope="col" className="px-4 py-3">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {list.data.items.map((t) => (
                  <tr key={t.id}>
                    <td className="px-4 py-2">
                      <Link to={platformTenantPath(t.id)} className="inline-flex min-h-[44px] flex-col justify-center font-medium text-ink underline-offset-4 hover:underline">
                        <span>{t.name}</span>
                        <span className="text-xs font-normal text-muted-foreground">{t.slug}</span>
                      </Link>
                    </td>
                    <td className="px-4 py-2">
                      <StatusBadge status={t.status} />
                    </td>
                    <td className="px-4 py-2 text-ink">{t.plan?.name ?? '—'}</td>
                    <td className="px-4 py-2 tabular-nums text-muted-foreground">{formatDate(t.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <nav aria-label="Pages" className="flex flex-wrap items-center justify-between gap-3 text-sm">
            <span className="text-muted-foreground" aria-live="polite">
              Page {formatCount(page + 1)} of {formatCount(pages)} · {formatCount(total)} tenants
            </span>
            <div className="flex gap-2">
              <Button variant="outline" disabled={page === 0} onClick={() => update({ page: page - 1 > 0 ? String(page - 1) : '' })}>
                Previous
              </Button>
              <Button variant="outline" disabled={page + 1 >= pages} onClick={() => update({ page: String(page + 1) })}>
                Next
              </Button>
            </div>
          </nav>
        </>
      )}
    </div>
  )
}
