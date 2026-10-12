import { formatQty } from '@/lib/domain/decimal'
import type { Report } from '@/lib/supabase/reports'

/** Inventory metrics of the report: low stock now (tenant-wide) and consumption over the covered days. */
export function InventorySection({ inventory }: { inventory: Report['inventory'] }) {
  return (
    <section aria-labelledby="rep-inventory" className="rounded-lg border border-line bg-white p-4">
      <h3 id="rep-inventory" className="mb-3 text-sm font-medium text-ink">
        Inventory
      </h3>
      <h4 className="mb-1 text-xs font-medium uppercase text-muted-foreground">Low stock now</h4>
      {inventory.low_stock.length === 0 ? (
        <p className="mb-3 text-sm text-muted-foreground">Nothing below its minimum.</p>
      ) : (
        <ul className="mb-3 space-y-1 text-sm" aria-label="Low stock now">
          {inventory.low_stock.map((i) => (
            <li key={i.ingredient_id} className="flex justify-between gap-2">
              <span className="truncate text-ink">{i.name}</span>
              <span className="tabular-nums text-status-warning">
                {formatQty(i.stock)} / {formatQty(i.min_level)} {i.unit}
              </span>
            </li>
          ))}
        </ul>
      )}
      <h4 className="mb-1 text-xs font-medium uppercase text-muted-foreground">Consumed</h4>
      {inventory.consumption.length === 0 ? (
        <p className="text-sm text-muted-foreground">No consumption recorded.</p>
      ) : (
        <ul className="space-y-1 text-sm" aria-label="Consumed">
          {inventory.consumption.slice(0, 15).map((i) => (
            <li key={i.ingredient_id} className="flex justify-between gap-2">
              <span className="truncate text-ink">{i.name}</span>
              <span className="tabular-nums text-ink">
                {formatQty(i.qty)} {i.unit}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
