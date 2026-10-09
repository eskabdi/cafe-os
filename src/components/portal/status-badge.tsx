import { cn } from '@/lib/utils/cn'

// Fixed semantic status chips (platform-wide, never tenant-branded: CLAUDE.md). Keyed by the platform's own lifecycle
// states (tenant / subscription / invoice / invitation / backup), which are fixed system values, not dynamic tenant domains.

type Tone = 'success' | 'warning' | 'error' | 'cancelled' | 'overdue' | 'neutral'

const TONE_CLASS: Readonly<Record<Tone, string>> = {
  success: 'border-status-success text-status-success',
  warning: 'border-status-warning text-status-warning',
  error: 'border-status-error text-status-error',
  cancelled: 'border-status-cancelled text-status-cancelled',
  overdue: 'border-status-overdue text-status-overdue',
  neutral: 'border-line text-muted-foreground',
}

const STATUS_TONE: Readonly<Record<string, Tone>> = {
  active: 'success',
  trialing: 'neutral',
  past_due: 'warning',
  suspended: 'error',
  cancelled: 'cancelled',
  pending: 'neutral',
  paid: 'success',
  overdue: 'overdue',
  void: 'cancelled',
  accepted: 'success',
  revoked: 'cancelled',
  expired: 'overdue',
  running: 'neutral',
  succeeded: 'success',
  failed: 'error',
  inactive: 'cancelled',
}

const STATUS_TEXT: Readonly<Record<string, string>> = {
  past_due: 'Past due',
  trialing: 'Trial',
}

export function statusText(status: string): string {
  if (Object.prototype.hasOwnProperty.call(STATUS_TEXT, status)) return STATUS_TEXT[status] ?? status
  const t = status.replace(/_/g, ' ')
  return t.charAt(0).toUpperCase() + t.slice(1)
}

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const tone: Tone = Object.prototype.hasOwnProperty.call(STATUS_TONE, status) ? (STATUS_TONE[status] ?? 'neutral') : 'neutral'
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-pill border bg-white px-2.5 py-0.5 text-xs font-semibold',
        TONE_CLASS[tone],
        className,
      )}
    >
      {statusText(status)}
    </span>
  )
}
