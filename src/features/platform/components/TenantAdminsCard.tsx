import { useState } from 'react'
import { toast } from 'sonner'
import { Card } from '@/components/portal/page-header'
import { ReasonDialog } from '@/components/portal/reason-dialog'
import { StatusBadge } from '@/components/portal/status-badge'
import { Button } from '@/components/ui/button'
import type { StepUpRunner } from '@/features/auth'
import { formatCount, fullName, shortName } from '@/lib/domain/portal'
import { errorCode } from '@/lib/supabase/menu-inventory-errors'
import type { TenantAdminRow } from '@/lib/supabase/platform'
import { portalErrorMessage } from '@/lib/supabase/portal-errors'
import { useResetTenantAdminMfa } from '../usePlatform'

/**
 * Safe, fixed copy for a failed authenticator reset. Switches on the codes tenant-admin-mfa-reset actually emits; the rest
 * (unauthorized, forbidden, mfa_required, try_later, server_error, network) falls through to the shared portal copy. Nothing the
 * server says is echoed.
 */
export function mfaResetErrorMessage(err: unknown): string {
  const { code } = errorCode(err)
  switch (code) {
    case 'no_factor':
      return 'This admin has no authenticator to reset any more. Refresh.'
    case 'not_found':
      return 'This Tenant Admin no longer exists in this tenant or is deactivated. Refresh the page.'
    case 'invalid_request':
      return 'Enter a reason of 3 to 500 characters.'
    case 'reset_expired':
      return 'The reset did not finish in time. Refresh the page and run it again.'
    case 'step_up_required':
      return 'Resetting an authenticator needs a fresh code from your own authenticator app (at most 12 hours old). Try again and enter the code.'
    default:
      return portalErrorMessage(err)
  }
}

const RESET_EFFECTS =
  'This removes their authenticator app and every trusted device, signs them out everywhere and replaces their password with a random one. A password-reset link is e-mailed to their registered address: they set a new password, then enrol a new authenticator. The reset is recorded in the platform audit log and in the tenant audit log with your reason.'
const FINISH_EFFECTS =
  'An earlier reset of this admin stopped half-way: their authenticator is already gone. Finishing it removes every trusted device, signs them out everywhere, replaces their password with a random one and e-mails them a password-reset link. It is recorded in the platform and tenant audit logs with your reason.'

/** The follow-up notes after a reset: sign-out not confirmed (hosted auth) and recovery e-mail not sent. */
export function mfaResetWarnings(r: { sessions_revoked: number | null; recovery_sent: boolean }): string[] {
  const out: string[] = []
  if (r.sessions_revoked === null)
    out.push(
      'Sign-out could not be confirmed; their old sessions can no longer pass the authenticator check.',
    )
  if (!r.recovery_sent)
    out.push(
      'The password-reset e-mail could not be sent. Their password was replaced, so they cannot sign in until they receive a recovery e-mail.',
    )
  return out
}

/** Confirmation for one Tenant Admin's authenticator reset: required audited reason, step-up aware, safe error copy. */
export function ResetAuthenticatorDialog({
  restaurantId,
  admin,
  run,
  onClose,
}: {
  restaurantId: string
  admin: TenantAdminRow | null
  run: StepUpRunner['run']
  onClose: () => void
}) {
  const reset = useResetTenantAdminMfa(restaurantId)
  const [error, setError] = useState<string | null>(null)
  if (!admin) return null
  const name = shortName(admin) || fullName(admin)
  const finishing = !admin.mfa_enrolled && admin.mfa_reset_pending

  const confirm = async (reason: string) => {
    setError(null)
    try {
      const r = await run(() => reset.mutateAsync({ profileId: admin.profile_id, reason }))
      const signedOut = r.sessions_revoked === null ? '' : ' They were signed out.'
      const mailed = r.recovery_sent ? ' A password-reset link was e-mailed to them.' : ''
      toast.success(
        `Authenticator reset for ${name}. Trusted devices removed: ${formatCount(r.devices_revoked)}.${signedOut}${mailed}`,
      )
      for (const w of mfaResetWarnings(r)) toast.warning(w)
      onClose()
    } catch (err) {
      setError(mfaResetErrorMessage(err))
    }
  }

  return (
    <ReasonDialog
      open
      title={finishing ? `Finish authenticator reset: ${name}` : `Reset authenticator: ${name}`}
      description={finishing ? FINISH_EFFECTS : RESET_EFFECTS}
      confirmLabel={finishing ? 'Finish reset' : 'Reset authenticator'}
      busy={reset.isPending}
      error={error}
      destructive
      onConfirm={(reason) => void confirm(reason)}
      onCancel={() => {
        setError(null)
        onClose()
      }}
    />
  )
}

/**
 * Tenant Admins of the tenant with their MFA posture (authenticator enrolled, trusted devices). Identity data only; no tenant
 * operational data. An active, enrolled admin's authenticator can be reset (lost phone) through the audited Edge Function; a reset
 * that stopped half-way (mfa_reset_pending) can be finished.
 */
export function TenantAdminsCard({
  restaurantId,
  admins,
  run,
}: {
  restaurantId: string
  admins: readonly TenantAdminRow[]
  run: StepUpRunner['run']
}) {
  const [target, setTarget] = useState<TenantAdminRow | null>(null)
  return (
    <Card title="Tenant Admins">
      {admins.length === 0 ? (
        <p className="text-sm text-muted-foreground">No Tenant Admin accounts yet.</p>
      ) : (
        <ul aria-label="Tenant Admins" className="divide-y divide-line">
          {admins.map((a) => {
            const name = fullName(a)
            return (
              <li key={a.profile_id} aria-label={name} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="font-medium text-ink">{name}</p>
                  <p className="break-all text-sm text-muted-foreground">{a.email || '—'}</p>
                  <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink">
                    <div className="flex gap-1">
                      <dt className="text-muted-foreground">Authenticator:</dt>
                      <dd>
                        {a.mfa_enrolled
                          ? 'enrolled'
                          : a.mfa_reset_pending
                            ? 'reset not finished'
                            : 'not enrolled'}
                      </dd>
                    </div>
                    <div className="flex gap-1">
                      <dt className="text-muted-foreground">Trusted devices:</dt>
                      <dd className="tabular-nums">{formatCount(a.trusted_devices)}</dd>
                    </div>
                  </dl>
                </div>
                <StatusBadge status={a.is_active ? 'active' : 'inactive'} />
                {a.is_active && a.mfa_enrolled && (
                  <Button
                    variant="outline"
                    aria-label={`Reset authenticator for ${name}`}
                    onClick={() => setTarget(a)}
                  >
                    Reset authenticator
                  </Button>
                )}
                {a.is_active && !a.mfa_enrolled && a.mfa_reset_pending && (
                  <Button
                    variant="outline"
                    aria-label={`Finish authenticator reset for ${name}`}
                    onClick={() => setTarget(a)}
                  >
                    Finish reset
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      )}
      <ResetAuthenticatorDialog
        restaurantId={restaurantId}
        admin={target}
        run={run}
        onClose={() => setTarget(null)}
      />
    </Card>
  )
}
