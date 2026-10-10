import { useState } from 'react'
import { toast } from 'sonner'
import { PageHeader } from '@/components/portal/page-header'
import { ReasonDialog } from '@/components/portal/reason-dialog'
import { Button } from '@/components/ui/button'
import { TrustedDevicesCard, useStepUp } from '@/features/auth'
import { EmptyState, ErrorState, PageSkeleton } from '@/features/shell/states'
import { formatDateTime } from '@/lib/domain/portal'
import type { PlatformAdmin } from '@/lib/supabase/platform'
import { portalErrorMessage } from '@/lib/supabase/portal-errors'
import { useAdmins, useSetAdminActive } from '../usePlatform'

/**
 * Super Admin accounts: list, activate / deactivate (the database keeps at least one active Super Admin), and each account's
 * trusted devices. Adding a Super Admin is an audited ops procedure (fn_ops_register_platform_admin), not a portal action.
 */
export function AdminsPage() {
  const admins = useAdmins()
  const setActive = useSetAdminActive()
  const stepUp = useStepUp()
  const [target, setTarget] = useState<PlatformAdmin | null>(null)
  const [devicesOf, setDevicesOf] = useState<PlatformAdmin | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (admins.isPending) return <PageSkeleton label="Loading Super Admins" />
  if (admins.isError) return <ErrorState title="Super Admins could not be loaded" onRetry={() => void admins.refetch()} />
  const confirm = (reason: string) => {
    if (!target) return
    setError(null)
    stepUp
      .run(() => setActive.mutateAsync({ id: target.id, active: !target.is_active, reason }))
      .then(() => {
        toast.success(target.is_active ? 'Super Admin deactivated.' : 'Super Admin reactivated.')
        setTarget(null)
      })
      .catch((e: unknown) => setError(portalErrorMessage(e)))
  }
  return (
    <div className="space-y-5 p-4 lg:p-6">
      <PageHeader
        title="Super Admins"
        description="Adding a Super Admin is an audited operations procedure. Deactivating one revokes their trusted devices."
      />
      {admins.data.length === 0 ? (
        <EmptyState title="No Super Admins">This should never happen.</EmptyState>
      ) : (
        <ul className="divide-y divide-line rounded-card border border-line bg-white">
          {admins.data.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-3 p-4">
              <div className="min-w-0 flex-1">
                <p className="font-medium text-ink">
                  {a.full_name}
                  {a.is_self && <span className="ml-2 text-xs text-muted-foreground">(you)</span>}
                </p>
                <p className="text-sm text-muted-foreground">
                  {a.email ?? 'no e-mail'} · {a.mfa_enrolled ? 'authenticator set up' : 'no authenticator'} · since {formatDateTime(a.created_at)}
                </p>
              </div>
              <span className={a.is_active ? 'text-sm text-status-success' : 'text-sm text-muted-foreground'}>
                {a.is_active ? 'Active' : 'Inactive'}
              </span>
              {!a.is_self && (
                <>
                  <Button variant="ghost" onClick={() => setDevicesOf(devicesOf?.id === a.id ? null : a)}>
                    Devices
                  </Button>
                  <Button variant="outline" onClick={() => setTarget(a)}>
                    {a.is_active ? 'Deactivate' : 'Reactivate'}
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {devicesOf && <TrustedDevicesCard userId={devicesOf.id} title={`Trusted devices of ${devicesOf.full_name}`} />}
      <ReasonDialog
        open={target !== null}
        title={target?.is_active ? 'Deactivate this Super Admin?' : 'Reactivate this Super Admin?'}
        description={target?.is_active ? 'They lose access to the Platform Admin Portal at once.' : 'They regain access to the Platform Admin Portal.'}
        confirmLabel={target?.is_active ? 'Deactivate' : 'Reactivate'}
        destructive={target?.is_active}
        busy={setActive.isPending}
        error={error}
        onConfirm={(reason) => confirm(reason)}
        onCancel={() => {
          setTarget(null)
          setError(null)
        }}
      />
      {stepUp.dialog}
    </div>
  )
}
