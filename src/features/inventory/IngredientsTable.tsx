import { ChefHat } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { RowBadge } from '@/features/shell/RowBadge'
import { formatEtb, formatQty } from '@/lib/domain/decimal'
import { isLowStock } from '@/lib/domain/inventory'
import type { Ingredient } from '@/lib/supabase/inventory'
import type { StationRow } from '@/lib/supabase/stations'

export interface IngredientActions {
  canAdjust: boolean
  canReceive: boolean
  onReceive: (i: Ingredient) => void
  onAdjust: (i: Ingredient) => void
  onEdit: (i: Ingredient) => void
  onToggleActive: (i: Ingredient) => void
  onHistory: (i: Ingredient) => void
}

/** Ingredient list. Status uses the fixed semantic colours (low stock = warning), never tenant branding. */
export function IngredientsTable({
  ingredients,
  stationById,
  actions,
}: {
  ingredients: Ingredient[]
  stationById: Map<string, StationRow>
  actions: IngredientActions
}) {
  return (
    <div className="overflow-x-auto rounded-card border border-line bg-white">
      <table className="w-full min-w-[48rem] text-left text-sm">
        <caption className="sr-only">Ingredients</caption>
        <thead className="border-b border-line bg-bg text-xs uppercase text-muted-foreground">
          <tr>
            <th scope="col" className="px-3 py-2">
              Ingredient
            </th>
            <th scope="col" className="px-3 py-2">
              Station
            </th>
            <th scope="col" className="px-3 py-2 text-right">
              On hand
            </th>
            <th scope="col" className="px-3 py-2 text-right">
              Minimum
            </th>
            <th scope="col" className="px-3 py-2 text-right">
              Cost / unit
            </th>
            <th scope="col" className="px-3 py-2">
              Status
            </th>
            <th scope="col" className="px-3 py-2">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {ingredients.map((i) => {
            const station = stationById.get(i.station_id)
            const low = isLowStock(i)
            return (
              <tr
                key={i.id}
                className="border-b border-line align-middle last:border-0"
                data-testid="ingredient-row"
              >
                <th scope="row" className="px-3 py-2 font-medium text-ink">
                  {i.name}
                </th>
                <td className="px-3 py-2">
                  {station ? <RowBadge row={station} fallbackIcon={ChefHat} /> : '—'}
                </td>
                <td
                  className="whitespace-nowrap px-3 py-2 text-right tabular-nums"
                  data-testid="ingredient-stock"
                >
                  {formatQty(i.stock)} {i.unit}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">
                  {formatQty(i.min_level)} {i.unit}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">
                  {formatEtb(i.cost_per_unit)}
                </td>
                <td className="px-3 py-2">
                  {!i.is_active ? (
                    <span className="text-status-cancelled">Inactive</span>
                  ) : low ? (
                    <span className="font-medium text-status-warning">Low stock</span>
                  ) : (
                    <span className="text-status-success">OK</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap justify-end gap-1.5">
                    {actions.canReceive && i.is_active && (
                      <Button
                        size="sm"
                        className="min-h-[44px]"
                        onClick={() => actions.onReceive(i)}
                        aria-label={`Receive ${i.name}`}
                      >
                        Receive
                      </Button>
                    )}
                    {actions.canAdjust && i.is_active && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="min-h-[44px]"
                        onClick={() => actions.onAdjust(i)}
                        aria-label={`Adjust ${i.name}`}
                      >
                        Adjust
                      </Button>
                    )}
                    {actions.canAdjust && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="min-h-[44px]"
                        onClick={() => actions.onEdit(i)}
                        aria-label={`Edit ${i.name}`}
                      >
                        Edit
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="min-h-[44px]"
                      onClick={() => actions.onHistory(i)}
                      aria-label={`History of ${i.name}`}
                    >
                      History
                    </Button>
                    {actions.canAdjust && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="min-h-[44px]"
                        onClick={() => actions.onToggleActive(i)}
                        aria-label={`${i.is_active ? 'Deactivate' : 'Reactivate'} ${i.name}`}
                      >
                        {i.is_active ? 'Deactivate' : 'Reactivate'}
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
