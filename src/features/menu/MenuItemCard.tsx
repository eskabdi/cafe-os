import { ChefHat } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { RowBadge } from '@/features/shell/RowBadge'
import { formatEtb } from '@/lib/domain/decimal'
import type { MenuItem } from '@/lib/supabase/menu'
import type { StationRow } from '@/lib/supabase/stations'
import { MenuItemImage } from './MenuItemImage'

/** One menu item. Station chip colour / icon come from the station ROW (looked up by UUID). */
export function MenuItemCard({
  item,
  station,
  canManage,
  onEdit,
  onRecipe,
  onToggleActive,
}: {
  item: MenuItem
  station: StationRow | undefined
  canManage: boolean
  onEdit: () => void
  onRecipe: () => void
  onToggleActive: () => void
}) {
  return (
    <article
      aria-label={item.name}
      className="flex gap-3 rounded-card border border-line bg-white p-3"
      data-inactive={item.is_active ? undefined : 'true'}
    >
      <MenuItemImage path={item.image_path} emoji={item.emoji} />
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="truncate font-medium text-ink">{item.name}</h3>
          <span className="font-semibold tabular-nums text-ink">{formatEtb(item.price)}</span>
        </div>
        {item.description && <p className="line-clamp-2 text-sm text-muted-foreground">{item.description}</p>}
        <div className="flex flex-wrap items-center gap-2">
          {station && <RowBadge row={station} fallbackIcon={ChefHat} inactive={!station.is_active} />}
          {!item.is_active && (
            <span className="rounded-pill bg-muted px-2.5 py-1 text-xs font-medium text-status-cancelled">
              Inactive
            </span>
          )}
        </div>
        {canManage && (
          <div className="flex flex-wrap gap-2 pt-1">
            <Button
              size="sm"
              variant="outline"
              className="min-h-[44px]"
              onClick={onEdit}
              aria-label={`Edit ${item.name}`}
            >
              Edit
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="min-h-[44px]"
              onClick={onRecipe}
              aria-label={`Recipe for ${item.name}`}
            >
              Recipe
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="min-h-[44px]"
              onClick={onToggleActive}
              aria-label={`${item.is_active ? 'Deactivate' : 'Reactivate'} ${item.name}`}
            >
              {item.is_active ? 'Deactivate' : 'Reactivate'}
            </Button>
          </div>
        )}
      </div>
    </article>
  )
}
