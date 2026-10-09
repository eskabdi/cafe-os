import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MonitorSmartphone } from 'lucide-react'
import { toast } from 'sonner'
import { Card } from '@/components/portal/page-header'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { formatDateTime } from '@/lib/domain/portal'
import { portalErrorMessage } from '@/lib/supabase/portal-errors'
import {
  forgetDeviceToken,
  listMyTrustedDevices,
  listUserTrustedDevices,
  revokeAllTrustedDevices,
  revokeTrustedDevice,
  trustedDeviceKeys,
  type TrustedDevice,
} from '@/lib/supabase/trusted-devices'
import { useAuth } from './useAuth'

/**
 * Devices trusted to skip the authenticator code for 30 days (0032). Own devices (both portals), or `userId`'s devices for a
 * Tenant Admin managing a user / a Super Admin managing another Super Admin. Revoking one or all takes effect at once on the
 * server: a revoked device's sessions lose their trust immediately and the next sign-in asks the code again.
 */
export function TrustedDevicesCard({ userId, title = 'Trusted devices' }: { userId?: string; title?: string }) {
  const { session } = useAuth()
  const self = !userId || userId === session?.user?.id
  const qc = useQueryClient()
  const target = self ? null : (userId ?? null)
  const devices = useQuery({
    queryKey: target ? trustedDeviceKeys.user(target) : trustedDeviceKeys.mine,
    queryFn: () => (target ? listUserTrustedDevices(target) : listMyTrustedDevices()),
  })
  const [confirm, setConfirm] = useState<TrustedDevice | 'all' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const revoke = useMutation({
    mutationFn: async (which: TrustedDevice | 'all') => {
      if (which === 'all') await revokeAllTrustedDevices(target)
      else await revokeTrustedDevice(which.id)
      // this browser's own token is useless once revoked: forget it (the next sign-in asks the code)
      if (self && session?.user?.id && (which === 'all' || which.current)) forgetDeviceToken(session.user.id)
    },
    onSuccess: () => {
      setConfirm(null)
      setError(null)
      toast.success('Trust removed. The code will be asked again on that device.')
      void qc.invalidateQueries({ queryKey: ['trusted-devices'] })
    },
    onError: (e) => setError(portalErrorMessage(e)),
  })

  const list = devices.data ?? []
  return (
    <Card
      title={title}
      actions={
        list.length > 0 ? (
          <Button variant="outline" onClick={() => setConfirm('all')}>
            {self ? 'Sign out of all trusted devices' : 'Revoke all'}
          </Button>
        ) : undefined
      }
    >
      <p className="text-sm text-muted-foreground">
        A trusted device skips the authenticator code at sign-in for 30 days. Very sensitive actions still ask for a code.
      </p>
      {devices.isPending && <p role="status" className="text-sm text-muted-foreground">Loading devices…</p>}
      {devices.isError && (
        <p role="alert" className="text-sm text-status-error">
          The devices could not be loaded.{' '}
          <button type="button" className="underline" onClick={() => void devices.refetch()}>
            Try again
          </button>
        </p>
      )}
      {devices.isSuccess && list.length === 0 && <p className="text-sm text-ink">No trusted devices.</p>}
      {list.length > 0 && (
        <ul className="divide-y divide-line" aria-label="Trusted devices">
          {list.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-3 py-3">
              <MonitorSmartphone aria-hidden="true" className="h-5 w-5 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="font-medium text-ink">
                  {d.label || 'Unnamed device'}
                  {d.current && <span className="ml-2 rounded-pill bg-primary/10 px-2 py-0.5 text-xs text-primary">this device</span>}
                </p>
                <p className="text-xs text-muted-foreground">
                  Trusted {formatDateTime(d.created_at)} · last used {formatDateTime(d.last_seen_at)} · until {formatDateTime(d.expires_at)}
                </p>
              </div>
              <Button variant="ghost" onClick={() => setConfirm(d)}>
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={confirm !== null}
        title={confirm === 'all' ? 'Revoke every trusted device?' : 'Revoke this device?'}
        description="The authenticator code will be asked again at the next sign-in on the revoked device(s)."
        confirmLabel="Revoke"
        busy={revoke.isPending}
        error={error}
        onConfirm={() => confirm && revoke.mutate(confirm)}
        onCancel={() => {
          setConfirm(null)
          setError(null)
        }}
      />
    </Card>
  )
}
