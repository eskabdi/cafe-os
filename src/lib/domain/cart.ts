// Pure POS cart model (Phase 4). The cart is an INTENT: menu item ids, quantities and notes. Prices shown here are a preview
// from the menu rows; the server re-prices from menu_items under a lock, adds VAT and decides the totals (fn_order_create).
// Money is kept in integer cents for the preview so no float drift reaches the screen.

export const MAX_LINES = 50
export const MAX_QTY = 99
export const MAX_NOTE = 200

export interface CartLine {
  /** Local key: one menu item may appear on several lines with different notes. */
  key: string
  menuItemId: string
  name: string
  /** Preview unit price in ETB (string or number from the row). */
  price: number
  qty: number
  note: string
}

export type Cart = readonly CartLine[]

const cents = (v: number) => Math.round(v * 100)

/** Adds one unit of an item: increments the note-less line of that item, else appends a new line (capped). */
export function addItem(cart: Cart, item: { id: string; name: string; price: number | string }, newKey: () => string): Cart {
  const price = typeof item.price === 'string' ? Number(item.price) : item.price
  if (!Number.isFinite(price) || price < 0) return cart
  const i = cart.findIndex((l) => l.menuItemId === item.id && l.note === '')
  if (i >= 0) {
    const line = cart[i] as CartLine
    if (line.qty >= MAX_QTY) return cart
    return cart.map((l, j) => (j === i ? { ...l, qty: l.qty + 1 } : l))
  }
  if (cart.length >= MAX_LINES) return cart
  return [...cart, { key: newKey(), menuItemId: item.id, name: item.name, price, qty: 1, note: '' }]
}

export function setQty(cart: Cart, key: string, qty: number): Cart {
  if (!Number.isInteger(qty)) return cart
  if (qty <= 0) return cart.filter((l) => l.key !== key)
  return cart.map((l) => (l.key === key ? { ...l, qty: Math.min(qty, MAX_QTY) } : l))
}

export function setNote(cart: Cart, key: string, note: string): Cart {
  const clean = Array.from(note)
    .filter((ch) => {
      const c = ch.charCodeAt(0)
      return c >= 32 && c !== 127
    })
    .join('')
    .slice(0, MAX_NOTE)
  return cart.map((l) => (l.key === key ? { ...l, note: clean } : l))
}

export function removeLine(cart: Cart, key: string): Cart {
  return cart.filter((l) => l.key !== key)
}

/** Preview subtotal in ETB (VAT and the final total come from the server). */
export function previewSubtotal(cart: Cart): number {
  return cart.reduce((sum, l) => sum + cents(l.price) * l.qty, 0) / 100
}

export function itemCount(cart: Cart): number {
  return cart.reduce((n, l) => n + l.qty, 0)
}

/** The fn_submit_order payload: [{menu_item_id, qty, note|null}] (no prices, no totals). */
export function toPayload(cart: Cart): Array<{ menu_item_id: string; qty: number; note: string | null }> {
  return cart.map((l) => ({ menu_item_id: l.menuItemId, qty: l.qty, note: l.note.trim() ? l.note.trim() : null }))
}
