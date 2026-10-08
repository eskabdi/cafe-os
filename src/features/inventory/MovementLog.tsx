import { useMemo, useState } from 'react'
import { format } from 'date-fns'
import { Button } from '@/components/ui/button'
import { NativeSelect } from '@/components/ui/select'
import { EmptyState, ErrorState } from '@/features/shell'
import { formatSignedQty } from '@/lib/domain/decimal'
import { isReversibleReason, movementReasonText } from '@/lib/domain/inventory'
import type { Ingredient, StockMovement } from '@/lib/supabase/inventory'
import { cn } from '@/lib/utils/cn'
import { ReverseMovementDialog } from './ReverseMovementDialog'
import { useStockMovements } from './useInventory'

function when(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : format(d, 'yyyy-MM-dd HH:mm')
}

/** The append-only stock ledger, newest first, keyset-paged ("Load more" continues after the last row loaded). */
export function MovementLog({
  ingredients,
  ingredientId,
  onIngredientChange,
  canReverse,
}: {
  ingredients: Ingredient[]
  ingredientId: string | null
  onIngredientChange: (id: string | null) => void
  canReverse: boolean
}) {
  const log = useStockMovements(ingredientId)
  const [toReverse, setToReverse] = useState<StockMovement | null>(null)
  const rows = useMemo(() => log.data?.pages.flat() ?? [], [log.data])
  // rows already compensated by a loaded reversal (the server is the authority: already_reversed otherwise)
  const reversed = useMemo(
    () => new Set(rows.map((r) => r.reverses_movement_id).filter((id): id is string => Boolean(id))),
    [rows],
  )

  return (
    <div className="space-y-4">
      <div className="max-w-sm space-y-1.5">
        <label htmlFor="log-ingredient" className="text-sm font-medium text-ink">
          Ingredient
        </label>
        <NativeSelect
          id="log-ingredient"
          value={ingredientId ?? ''}
          onChange={(e) => onIngredientChange(e.target.value || null)}
        >
          <option value="">All ingredients</option>
          {ingredients.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </NativeSelect>
      </div>

      {log.isPending && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading movements…
        </p>
      )}
      {log.isError && (
        <ErrorState
          title="The movement log could not be loaded"
          level={2}
          onRetry={() => void log.refetch()}
        />
      )}
      {log.isSuccess && rows.length === 0 && (
        <EmptyState title="No movements yet" level={2}>
          <p>Received, adjusted and consumed stock appears here.</p>
        </EmptyState>
      )}
      {rows.length > 0 && (
        <div className="overflow-x-auto rounded-card border border-line bg-white">
          <table className="w-full min-w-[40rem] text-left text-sm">
            <caption className="sr-only">Stock movements, newest first</caption>
            <thead className="border-b border-line bg-bg text-xs uppercase text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2">
                  When
                </th>
                <th scope="col" className="px-3 py-2">
                  Ingredient
                </th>
                <th scope="col" className="px-3 py-2">
                  Type
                </th>
                <th scope="col" className="px-3 py-2 text-right">
                  Change
                </th>
                <th scope="col" className="px-3 py-2">
                  Note / reason
                </th>
                <th scope="col" className="px-3 py-2">
                  By
                </th>
                {canReverse && (
                  <th scope="col" className="px-3 py-2">
                    <span className="sr-only">Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id} className="border-b border-line last:border-0" data-testid="movement-row">
                  <td className="whitespace-nowrap px-3 py-2 tabular-nums">{when(m.created_at)}</td>
                  <td className="px-3 py-2">{m.ingredient_name}</td>
                  <td className="px-3 py-2">{movementReasonText(m.reason)}</td>
                  <td
                    className={cn(
                      'whitespace-nowrap px-3 py-2 text-right font-medium tabular-nums',
                      m.qty_delta < 0 ? 'text-status-error' : 'text-status-success',
                    )}
                  >
                    {formatSignedQty(m.qty_delta)} {m.unit}
                  </td>
                  <td className="max-w-[16rem] truncate px-3 py-2 text-muted-foreground">{m.note ?? ''}</td>
                  <td className="px-3 py-2 text-muted-foreground">{m.created_by_name ?? '—'}</td>
                  {canReverse && (
                    <td className="px-3 py-2 text-right">
                      {isReversibleReason(m.reason) && !reversed.has(m.id) && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="min-h-[44px]"
                          aria-label={`Reverse ${movementReasonText(m.reason).toLowerCase()} of ${m.ingredient_name}`}
                          onClick={() => setToReverse(m)}
                        >
                          Reverse
                        </Button>
                      )}
                      {reversed.has(m.id) && <span className="text-xs text-muted-foreground">Reversed</span>}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {log.hasNextPage && (
        <Button variant="outline" onClick={() => void log.fetchNextPage()} disabled={log.isFetchingNextPage}>
          {log.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </Button>
      )}
      {canReverse && <ReverseMovementDialog movement={toReverse} onClose={() => setToReverse(null)} />}
    </div>
  )
}
