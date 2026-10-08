import { useMemo, useState, type ReactNode } from 'react'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useAuth } from '@/features/auth'
import { EmptyState, ErrorState, PageSkeleton } from '@/features/shell'
import { RowBadge } from '@/features/shell/RowBadge'
import { useAllStations, useCategories } from '@/hooks/useReferenceData'
import { groupByCategory } from '@/lib/domain/inventory'
import type { MenuItem } from '@/lib/supabase/menu'
import { menuInventoryErrorMessage } from '@/lib/supabase/menu-inventory-errors'
import { cn } from '@/lib/utils/cn'
import { MenuItemCard } from './MenuItemCard'
import { MenuItemFormDialog } from './MenuItemFormDialog'
import { RecipeEditorDialog } from './RecipeEditorDialog'
import { useMenuItems, useMenuRealtime, useSetMenuItemActive } from './useMenu'

const ALL = 'all'

/**
 * Menu module (`/r/:slug/menu`, menu.view). Items are grouped by category ROW (UUID, the row's own colour / icon); the
 * category filter is generated from the rows. Management actions are shown with menu.manage (UX only: the RPCs check it).
 */
export function MenuPage() {
  useMenuRealtime()
  const { can } = useAuth()
  const canManage = can('menu.manage')
  const items = useMenuItems()
  const categories = useCategories()
  const stations = useAllStations()
  const toggle = useSetMenuItemActive()

  const [filter, setFilter] = useState<string>(ALL)
  const [showInactive, setShowInactive] = useState(false)
  const [editing, setEditing] = useState<MenuItem | 'new' | null>(null)
  const [recipeFor, setRecipeFor] = useState<MenuItem | null>(null)
  const [toToggle, setToToggle] = useState<MenuItem | null>(null)
  const [toggleError, setToggleError] = useState<string | null>(null)

  const stationById = useMemo(() => new Map((stations.data ?? []).map((s) => [s.id, s])), [stations.data])
  const visible = useMemo(
    () => (items.data ?? []).filter((i) => showInactive || i.is_active),
    [items.data, showInactive],
  )
  const groups = useMemo(() => groupByCategory(visible, categories.data ?? []), [visible, categories.data])
  const shown = filter === ALL ? groups : groups.filter((g) => g.key === filter)

  if (items.isPending || categories.isPending) return <PageSkeleton label="Loading the menu" />
  if (items.isError || categories.isError) {
    return (
      <ErrorState
        title="The menu could not be loaded"
        onRetry={() => {
          void items.refetch()
          void categories.refetch()
        }}
      />
    )
  }

  const confirmToggle = async () => {
    if (!toToggle) return
    setToggleError(null)
    try {
      await toggle.mutateAsync({ id: toToggle.id, active: !toToggle.is_active })
      toast.success(toToggle.is_active ? 'Item deactivated' : 'Item reactivated')
      setToToggle(null)
    } catch (err) {
      setToggleError(menuInventoryErrorMessage(err))
    }
  }

  return (
    <div className="space-y-5 p-4 lg:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Menu</h1>
          <p className="text-sm text-muted-foreground">Menu items by category. Prices in ETB.</p>
        </div>
        {canManage && (
          <Button onClick={() => setEditing('new')}>
            <Plus aria-hidden="true" className="h-4 w-4" />
            New item
          </Button>
        )}
      </header>

      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter by category">
        <FilterChip pressed={filter === ALL} onClick={() => setFilter(ALL)}>
          All
        </FilterChip>
        {groups.map((g) => (
          <FilterChip key={g.key} pressed={filter === g.key} onClick={() => setFilter(g.key)}>
            {g.category ? g.category.name : 'Uncategorised'}
          </FilterChip>
        ))}
        <label className="ml-auto flex min-h-[44px] items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            className="h-5 w-5"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
          />
          Show inactive items
        </label>
      </div>

      {shown.length === 0 ? (
        <EmptyState title="No menu items yet">
          <p>{canManage ? 'Create the first item with “New item”.' : 'Nothing is on the menu yet.'}</p>
        </EmptyState>
      ) : (
        shown.map((g) => (
          <section key={g.key} aria-labelledby={`cat-${g.key}`} className="space-y-3">
            <h2 id={`cat-${g.key}`} className="flex items-center gap-2 text-lg font-semibold text-ink">
              {g.category ? (
                <RowBadge row={g.category} inactive={!g.category.is_active} className="text-sm" />
              ) : (
                'Uncategorised'
              )}
              <span className="text-sm font-normal text-muted-foreground">
                {g.items.length === 1 ? '1 item' : `${g.items.length} items`}
              </span>
            </h2>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {g.items.map((item) => (
                <MenuItemCard
                  key={item.id}
                  item={item}
                  station={stationById.get(item.station_id)}
                  canManage={canManage}
                  onEdit={() => setEditing(item)}
                  onRecipe={() => setRecipeFor(item)}
                  onToggleActive={() => {
                    setToggleError(null)
                    setToToggle(item)
                  }}
                />
              ))}
            </div>
          </section>
        ))
      )}

      {canManage && (
        <>
          <MenuItemFormDialog
            open={editing !== null}
            item={editing === 'new' ? null : editing}
            categories={categories.data ?? []}
            stations={stations.data ?? []}
            onClose={() => setEditing(null)}
          />
          <RecipeEditorDialog item={recipeFor} onClose={() => setRecipeFor(null)} />
          <ConfirmDialog
            open={toToggle !== null}
            title={
              toToggle?.is_active ? `Deactivate ${toToggle.name}?` : `Reactivate ${toToggle?.name ?? ''}?`
            }
            description={
              toToggle?.is_active
                ? 'It will no longer be offered for new orders. Past orders keep their records. You can reactivate it later.'
                : 'It will be offered for new orders again.'
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

function FilterChip({
  pressed,
  onClick,
  children,
}: {
  pressed: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        'min-h-[44px] rounded-pill border px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        pressed
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-line bg-white text-ink hover:bg-accent',
      )}
    >
      {children}
    </button>
  )
}
