import { Tag, type LucideIcon } from 'lucide-react'
import { iconForSlug } from '@/features/terminal/tile-icons'
import { tileStyle } from '@/lib/domain/tile-style'
import { cn } from '@/lib/utils/cn'

/**
 * Chip for a dynamic-domain row (category, station, ...): colour and icon come from the ROW itself (validated hex and an
 * allowlisted icon slug), never from a name-keyed map. Unknown slugs and colours fall back to neutral defaults.
 */
export function RowBadge({
  row,
  fallbackIcon = Tag,
  inactive,
  className,
}: {
  row: { name: string; color?: string | null; icon?: string | null }
  fallbackIcon?: LucideIcon
  inactive?: boolean
  className?: string
}) {
  const Icon = iconForSlug(row.icon, fallbackIcon)
  const chip = tileStyle(row.color)
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 rounded-pill px-2.5 py-1 text-xs font-medium',
        className,
      )}
      style={{ backgroundColor: chip.background, color: chip.foreground }}
    >
      <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{row.name}</span>
      {inactive && <span className="sr-only"> (inactive)</span>}
    </span>
  )
}
