import { useMemo, useState } from 'react'
import { Plus, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useAuth } from '@/features/auth'
import { EmptyState, ErrorState, PageSkeleton } from '@/features/shell'
import { useAllStations } from '@/hooks/useReferenceData'
import { formatQty } from '@/lib/domain/decimal'
import { isLowStock } from '@/lib/domain/inventory'
import type { Ingredient } from '@/lib/supabase/inventory'
import { menuInventoryErrorMessage } from '@/lib/supabase/menu-inventory-errors'
import { cn } from '@/lib/utils/cn'
import { IngredientFormDialog } from './IngredientFormDialog'
import { IngredientsTable } from './IngredientsTable'
import { MovementLog } from './MovementLog'
import { StepUpThresholdCard } from './StepUpThresholdCard'
import { StockMovementDialog, type StockAction } from './StockMovementDialog'
import {
  useIngredients,
  useInventoryRealtime,
  useSetIngredientActive,
  useStepUpThreshold,
} from './useInventory'

type Tab = 'ingredients' | 'movements'

/**
 * Inventory module (`/r/:slug/inventory`, inventory.view). Actions are shown per permission (receive / adjust /
 * settings.manage); UX only, the RPCs enforce them. Low stock = on hand at or below the minimum level.
 */
export function InventoryPage() {
  useInventoryRealtime()
  const { can } = useAuth()
  const canAdjust = can('inventory.adjust')
  const canReceive = can('inventory.receive')
  const canSettings = can('settings.manage')
  const ingredients = useIngredients()
  const stations = useAllStations()
  const threshold = useStepUpThreshold()
  const toggle = useSetIngredientActive()

  const [tab, setTab] = useState<Tab>('ingredients')
  const [logIngredient, setLogIngredient] = useState<string | null>(null)
  const [showInactive, setShowInactive] = useState(false)
  const [editing, setEditing] = useState<Ingredient | 'new' | null>(null)
  const [stockAction, setStockAction] = useState<StockAction | null>(null)
  const [toToggle, setToToggle] = useState<Ingredient | null>(null)
  const [toggleError, setToggleError] = useState<string | null>(null)

  const stationById = useMemo(() => new Map((stations.data ?? []).map((s) => [s.id, s])), [stations.data])
  const all = ingredients.data ?? []
  const visible = all.filter((i) => showInactive || i.is_active)
  const low = all.filter((i) => isLowStock(i))

  if (ingredients.isPending) return <PageSkeleton label="Loading inventory" />
  if (ingredients.isError)
    return <ErrorState title="Inventory could not be loaded" onRetry={() => void ingredients.refetch()} />

  const confirmToggle = async () => {
    if (!toToggle) return
    setToggleError(null)
    try {
      await toggle.mutateAsync({ id: toToggle.id, active: !toToggle.is_active })
      toast.success(toToggle.is_active ? 'Ingredient deactivated' : 'Ingredient reactivated')
      setToToggle(null)
    } catch (err) {
      setToggleError(menuInventoryErrorMessage(err))
    }
  }

  const tabButton = (id: Tab, label: string) => (
    <button
      type="button"
      role="tab"
      id={`tab-${id}`}
      aria-selected={tab === id}
      aria-controls={`panel-${id}`}
      onClick={() => setTab(id)}
      className={cn(
        'min-h-[44px] border-b-2 px-4 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        tab === id ? 'border-primary text-ink' : 'border-transparent text-muted-foreground hover:text-ink',
      )}
    >
      {label}
    </button>
  )

  return (
    <div className="space-y-5 p-4 lg:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Inventory</h1>
          <p className="text-sm text-muted-foreground">Ingredients, stock on hand and the movement log.</p>
        </div>
        {canAdjust && (
          <Button onClick={() => setEditing('new')}>
            <Plus aria-hidden="true" className="h-4 w-4" />
            New ingredient
          </Button>
        )}
      </header>

      {low.length > 0 && (
        <section
          role="alert"
          aria-labelledby="low-stock-title"
          className="flex gap-3 rounded-card border border-status-warning bg-white p-4"
        >
          <TriangleAlert aria-hidden="true" className="h-5 w-5 shrink-0 text-status-warning" />
          <div className="space-y-1">
            <h2 id="low-stock-title" className="font-semibold text-ink">
              {low.length === 1
                ? '1 ingredient is low on stock'
                : `${low.length} ingredients are low on stock`}
            </h2>
            <ul className="text-sm text-ink">
              {low.map((i) => (
                <li key={i.id}>
                  {i.name}: {formatQty(i.stock)} {i.unit} (minimum {formatQty(i.min_level)} {i.unit})
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      <div role="tablist" aria-label="Inventory views" className="flex gap-2 border-b border-line">
        {tabButton('ingredients', 'Ingredients')}
        {tabButton('movements', 'Movement log')}
      </div>

      {tab === 'ingredients' ? (
        <div role="tabpanel" id="panel-ingredients" aria-labelledby="tab-ingredients" className="space-y-3">
          <label className="flex min-h-[44px] items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              className="h-5 w-5"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
            />
            Show inactive ingredients
          </label>
          {visible.length === 0 ? (
            <EmptyState title="No ingredients yet">
              <p>{canAdjust ? 'Add the first ingredient with “New ingredient”.' : 'Nothing to show yet.'}</p>
            </EmptyState>
          ) : (
            <IngredientsTable
              ingredients={visible}
              stationById={stationById}
              actions={{
                canAdjust,
                canReceive,
                onReceive: (i) => setStockAction({ kind: 'receive', ingredient: i }),
                onAdjust: (i) => setStockAction({ kind: 'adjust', ingredient: i }),
                onEdit: (i) => setEditing(i),
                onToggleActive: (i) => {
                  setToggleError(null)
                  setToToggle(i)
                },
                onHistory: (i) => {
                  setLogIngredient(i.id)
                  setTab('movements')
                },
              }}
            />
          )}
          {canSettings && <StepUpThresholdCard current={threshold.data} />}
        </div>
      ) : (
        <div role="tabpanel" id="panel-movements" aria-labelledby="tab-movements">
          <MovementLog
            ingredients={all}
            ingredientId={logIngredient}
            onIngredientChange={setLogIngredient}
            canReverse={canAdjust}
          />
        </div>
      )}

      <StockMovementDialog
        action={stockAction}
        threshold={threshold.data}
        onClose={() => setStockAction(null)}
      />
      {canAdjust && (
        <>
          <IngredientFormDialog
            open={editing !== null}
            ingredient={editing === 'new' ? null : editing}
            stations={stations.data ?? []}
            onClose={() => setEditing(null)}
          />
          <ConfirmDialog
            open={toToggle !== null}
            title={
              toToggle?.is_active ? `Deactivate ${toToggle.name}?` : `Reactivate ${toToggle?.name ?? ''}?`
            }
            description={
              toToggle?.is_active
                ? 'It can no longer be received or used in new recipes. Its movement history stays. An ingredient used by an active menu item cannot be deactivated.'
                : 'It can be received and used in recipes again.'
            }
            confirmLabel={toToggle?.is_active ? 'Deactivate' : 'Reactivate'}
            busy={toggle.isPending}
            error={toggleError}
            onConfirm={() => void confirmToggle()}
            onCancel={() => setToToggle(null)}
          />
        </>
      )}
    </div>
  )
}
