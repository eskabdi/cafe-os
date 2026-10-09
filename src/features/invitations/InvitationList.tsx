import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/portal/status-badge'
import { formatCount, formatDateTime } from '@/lib/domain/portal'

export interface InvitationRow {
  id: string
  email: string
  state: 'pending' | 'accepted' | 'revoked' | 'expired'
  status: 'pending' | 'accepted' | 'revoked' | 'expired'
  expires_at: string
  send_count: number
  last_sent_at: string | null
  created_at: string
}

/** Tenant Admin invitations with resend / revoke for pending ones (an expired pending invitation can be resent: renews 7 days). */
export function InvitationList({
  invitations,
  busyId,
  onResend,
  onRevoke,
}: {
  invitations: readonly InvitationRow[]
  busyId: string | null
  onResend: (id: string) => void
  onRevoke: (inv: InvitationRow) => void
}) {
  if (invitations.length === 0) return <p className="text-sm text-muted-foreground">No invitations yet.</p>
  return (
    <ul className="divide-y divide-line" aria-label="Invitations">
      {invitations.map((i) => (
        <li key={i.id} className="flex flex-wrap items-center gap-3 py-3">
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium text-ink">{i.email}</p>
            <p className="text-xs text-muted-foreground">
              {i.last_sent_at ? `Sent ${formatDateTime(i.last_sent_at)}` : 'Not sent yet'} · {formatCount(i.send_count)} of 5 sends · expires {formatDateTime(i.expires_at)}
            </p>
          </div>
          <StatusBadge status={i.state} />
          {i.status === 'pending' && (
            <div className="flex gap-2">
              <Button variant="outline" disabled={busyId === i.id} onClick={() => onResend(i.id)} aria-label={`Resend invitation to ${i.email}`}>
                Resend
              </Button>
              <Button variant="outline" disabled={busyId === i.id} onClick={() => onRevoke(i)} aria-label={`Revoke invitation to ${i.email}`}>
                Revoke
              </Button>
            </div>
          )}
        </li>
      ))}
    </ul>
  )
}
