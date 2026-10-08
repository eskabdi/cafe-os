// Pure menu / inventory logic for the UI. Nothing here knows a category, station or role NAME: rows are grouped and
// looked up by UUID, presentation (colour, icon) comes from the row. UX only: the database decides stock, prices and access.

/** Ingredient units: a fixed CHECK list in the schema (not a tenant domain). */
export const INGREDIENT_UNITS = ['kg', 'g', 'L', 'ml', 'pcs'] as const
export type IngredientUnit = (typeof INGREDIENT_UNITS)[number]

/** Ledger reasons: a fixed CHECK list in the schema (not a tenant domain). */
export const MOVEMENT_REASONS = [
  'opening',
  'received',
  'consumed',
  'manual_adjustment',
  'reversal',
  'correction',
] as const
export type MovementReason = (typeof MOVEMENT_REASONS)[number]

const REASON_TEXT: Readonly<Record<MovementReason, string>> = {
  opening: 'Opening stock',
  received: 'Received',
  consumed: 'Consumed by order',
  manual_adjustment: 'Manual adjustment',
  reversal: 'Reversal',
  correction: 'Correction',
}

export function movementReasonText(reason: MovementReason): string {
  return REASON_TEXT[reason]
}

/** Rows fn_reverse_stock_movement accepts (consumption is reversed with its order; a reversal is final). */
export function isReversibleReason(reason: MovementReason): boolean {
  return reason !== 'reversal' && reason !== 'consumed'
}

/** Low stock = on hand at or below the minimum level (same predicate as the ingredients_low_stock_idx index). */
export function isLowStock(i: { stock: number; min_level: number; is_active?: boolean }): boolean {
  return i.is_active !== false && i.stock <= i.min_level
}

/**
 * Hint only: whether the server's stock step-up rule (fn_stock_step_up) will probably ask for the authenticator.
 * value |qty| * cost >= threshold, or (no cost) |qty| >= threshold. The server re-decides; a wrong hint changes nothing.
 */
export function stepUpLikely(
  qty: number,
  costPerUnit: number,
  threshold: number | null | undefined,
): boolean {
  if (threshold === null || threshold === undefined || !Number.isFinite(threshold)) return false
  const q = Math.abs(qty)
  return q * costPerUnit >= threshold || (costPerUnit === 0 && q >= threshold)
}

export interface RefRow {
  id: string
  name: string
  sort_order?: number | null
  is_active: boolean
}

export interface CategoryGroup<I, C extends RefRow> {
  /** The category row, or null for items whose category row is not visible / unknown. */
  category: C | null
  key: string
  items: I[]
}

const byOrderThenName = <T extends { sort_order?: number | null; name: string }>(a: T, b: T) =>
  (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name)

/**
 * Groups menu items by their category UUID in category sort order (then name). Items whose category row is missing go
 * to a trailing group with category = null. Empty categories are omitted.
 */
export function groupByCategory<
  I extends { category_id: string; name: string; sort_order?: number | null },
  C extends RefRow,
>(items: readonly I[], categories: readonly C[]): Array<CategoryGroup<I, C>> {
  const known = new Map(categories.map((c) => [c.id, c]))
  const buckets = new Map<string, I[]>()
  for (const item of items) {
    const key = known.has(item.category_id) ? item.category_id : ''
    const list = buckets.get(key)
    if (list) list.push(item)
    else buckets.set(key, [item])
  }
  const out: Array<CategoryGroup<I, C>> = []
  for (const c of [...categories].sort(byOrderThenName)) {
    const list = buckets.get(c.id)
    if (list) out.push({ category: c, key: c.id, items: [...list].sort(byOrderThenName) })
  }
  const orphans = buckets.get('')
  if (orphans) out.push({ category: null, key: 'uncategorised', items: [...orphans].sort(byOrderThenName) })
  return out
}

/** Active rows for a picker, plus the currently selected row even if it has since been deactivated (so a form shows it). */
export function pickerRows<R extends RefRow>(rows: readonly R[], selectedId?: string | null): R[] {
  return [...rows].filter((r) => r.is_active || r.id === selectedId).sort(byOrderThenName)
}

/** Client-generated idempotency key for ONE stock intent (8..128 chars, server-checked). Reused only for retries of that intent. */
export function newIdempotencyKey(): string {
  return crypto.randomUUID()
}

// ── menu image ───────────────────────────────────────────────────────────────────────────────────────────────────
/** Same limits as the menu-images bucket (2 MiB, png / jpeg / webp). The bucket and the RPC re-check. */
export const MENU_IMAGE_MAX_BYTES = 2 * 1024 * 1024
const IMAGE_EXT: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

export type ImageCheck =
  { ok: true; ext: string; contentType: string } | { ok: false; reason: 'type' | 'size' | 'empty' }

/** Pre-check of a picked file (MIME type and size). Magic bytes are checked separately (sniffImageType). */
export function checkMenuImage(file: { type: string; size: number }): ImageCheck {
  if (file.size === 0) return { ok: false, reason: 'empty' }
  const ext = Object.prototype.hasOwnProperty.call(IMAGE_EXT, file.type) ? IMAGE_EXT[file.type] : undefined
  if (!ext) return { ok: false, reason: 'type' }
  if (file.size > MENU_IMAGE_MAX_BYTES) return { ok: false, reason: 'size' }
  return { ok: true, ext, contentType: file.type }
}

/** MIME type from the first bytes of a file (PNG, JPEG, WebP), or null. Catches a renamed non-image before upload. */
export function sniffImageType(head: Uint8Array): string | null {
  const at = (i: number) => head[i] ?? -1
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return 'image/png'
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg'
  if (
    at(0) === 0x52 &&
    at(1) === 0x49 &&
    at(2) === 0x46 &&
    at(3) === 0x46 &&
    at(8) === 0x57 &&
    at(9) === 0x45 &&
    at(10) === 0x42 &&
    at(11) === 0x50
  )
    return 'image/webp'
  return null
}

/**
 * Storage object path for a new menu image: `restaurants/<own tenant id>/menu/<random>.<ext>`. The tenant id is the
 * identity's own restaurant (session context); the Storage policy and fn_menu_check_image derive it again server-side.
 */
export function menuImagePath(
  restaurantId: string,
  ext: string,
  random: string = crypto.randomUUID(),
): string {
  return `restaurants/${restaurantId}/menu/${random}.${ext}`
}
