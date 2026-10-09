import { useState } from 'react'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import { PageHeader } from '@/components/portal/page-header'
import { StatusBadge } from '@/components/portal/status-badge'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useStepUp } from '@/features/auth'
import { EmptyState, ErrorState, PageSkeleton } from '@/features/shell/states'
import { formatEtb } from '@/lib/domain/decimal'
import { formatBytes, formatCount } from '@/lib/domain/portal'
import type { Plan, PlanInput } from '@/lib/supabase/platform'
import { portalErrorMessage } from '@/lib/supabase/portal-errors'
import { PlanFormDialog } from '../components/PlanFormDialog'
import { usePlans, useSavePlan, useSetPlanActive } from '../usePlatform'

const lim = (n: number | null | undefined, bytes = false) =>
  n === null || n === undefined ? 'unlimited' : bytes ? formatBytes(n) : formatCount(n)

/** Plan catalogue: create, edit, activate / deactivate (no delete: subscriptions reference plans with RESTRICT). */
export function PlansPage() {
  const plans = usePlans()
  const save = useSavePlan()
  const toggle = useSetPlanActive()
  const stepUp = useStepUp()
  const [editing, setEditing] = useState<Plan | 'new' | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [toToggle, setToToggle] = useState<Plan | null>(null)
  const [toggleError, setToggleError] = useState<string | null>(null)

  if (plans.isPending) return <PageSkeleton label="Loading plans" />
  if (plans.isError) return <ErrorState title="Plans could not be loaded" onRetry={() => void plans.refetch()} />

  const submit = async (p: PlanInput) => {
    setFormError(null)
    try {
      await stepUp.run(() => save.mutateAsync({ id: editing && editing !== 'new' ? editing.id : null, plan: p }))
      toast.success(editing === 'new' ? 'Plan created' : 'Plan saved')
      setEditing(null)
    } catch (err) {
      setFormError(portalErrorMessage(err))
    }
  }
  const confirmToggle = async () => {
    if (!toToggle) return
    setToggleError(null)
    try {
      await stepUp.run(() => toggle.mutateAsync({ id: toToggle.id, active: !toToggle.is_active }))
      toast.success(toToggle.is_active ? 'Plan deactivated' : 'Plan activated')
      setToToggle(null)
    } catch (err) {
      setToggleError(portalErrorMessage(err))
    }
  }

  return (
    <div className="space-y-5 p-4 lg:p-6">
      <PageHeader
        title="Plans"
        description="The subscription catalogue. Prices in ETB per month."
        actions={
          <Button
            onClick={() => {
              setFormError(null)
              setEditing('new')
            }}
          >
            <Plus aria-hidden="true" className="h-4 w-4" />
            New plan
          </Button>
        }
      />
      {plans.data.length === 0 ? (
        <EmptyState title="No plans yet" level={2} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {plans.data.map((p) => (
            <article key={p.id} aria-label={p.name} className="space-y-3 rounded-card border border-line bg-white p-5">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h2 className="text-lg font-semibold text-ink">{p.name}</h2>
                  <p className="text-sm tabular-nums text-ink">{formatEtb(p.price_etb_monthly)} / month</p>
                </div>
                <StatusBadge status={p.is_active ? 'active' : 'inactive'} />
              </div>
              {p.description && <p className="text-sm text-muted-foreground">{p.description}</p>}
              <ul className="space-y-0.5 text-sm text-ink">
                <li>Staff: {lim(p.max_staff)}</li>
                <li>Menu items: {lim(p.max_menu_items)}</li>
                <li>Stations: {lim(p.max_stations)}</li>
                <li>Terminals: {lim(p.max_kiosks)}</li>
                <li>Orders / month: {lim(p.max_orders_per_month)}</li>
                <li>Storage: {lim(p.max_storage_bytes, true)}</li>
              </ul>
              <p className="text-xs text-muted-foreground">Subscribers: {formatCount(p.subscriber_count)}</p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  aria-label={`Edit ${p.name}`}
                  onClick={() => {
                    setFormError(null)
                    setEditing(p)
                  }}
                >
                  Edit
                </Button>
                <Button
                  variant="outline"
                  aria-label={`${p.is_active ? 'Deactivate' : 'Activate'} ${p.name}`}
                  onClick={() => {
                    setToggleError(null)
                    setToToggle(p)
                  }}
                >
                  {p.is_active ? 'Deactivate' : 'Activate'}
                </Button>
              </div>
            </article>
          ))}
        </div>
      )}
      <PlanFormDialog
        open={editing !== null}
        plan={editing === 'new' ? null : editing}
        busy={save.isPending}
        error={formError}
        onSubmit={(p) => void submit(p)}
        onClose={() => setEditing(null)}
      />
      <ConfirmDialog
        open={toToggle !== null}
        title={toToggle?.is_active ? `Deactivate ${toToggle.name}?` : `Activate ${toToggle?.name ?? ''}?`}
        description={
          toToggle?.is_active
            ? 'It can no longer be chosen for new tenants or plan changes. Existing subscribers keep it.'
            : 'It can be chosen for new tenants and plan changes again.'
        }
        confirmLabel={toToggle?.is_active ? 'Deactivate' : 'Activate'}
        busy={toggle.isPending}
        error={toggleError}
        onConfirm={() => void confirmToggle()}
        onCancel={() => setToToggle(null)}
      />
      {stepUp.dialog}
    </div>
  )
}
