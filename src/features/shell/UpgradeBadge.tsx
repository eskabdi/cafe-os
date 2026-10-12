import { Lock } from 'lucide-react'
import { cn } from '@/lib/utils/cn'

/** Accessible description given to a module link whose feature is not in the tenant's plan. */
export const NOT_IN_PLAN_TEXT = 'Not included in your plan'

/**
 * Small neutral "Upgrade" marker for a navigation entry whose plan feature is missing. Purely visual (aria-hidden) so the link's
 * accessible name stays the module label; pair it with <PlanLockDescription> OUTSIDE the link, referenced by aria-describedby.
 * Neutral colours: never a semantic status colour, never tenant-branded.
 */
export function UpgradeBadge({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      data-testid="upgrade-badge"
      className={cn(
        'ml-auto inline-flex shrink-0 items-center gap-1 rounded-pill border border-line bg-muted px-2 py-0.5 text-xs font-medium text-ink',
        className,
      )}
    >
      <Lock className="h-3 w-3" />
      Upgrade
    </span>
  )
}

/** Hidden description target for aria-describedby (still read as the link's description by assistive technology). */
export function PlanLockDescription({ id }: { id: string }) {
  return (
    <span id={id} hidden>
      {NOT_IN_PLAN_TEXT}
    </span>
  )
}
