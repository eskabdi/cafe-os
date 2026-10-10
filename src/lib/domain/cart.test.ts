import { describe, expect, it } from 'vitest'
import { MAX_LINES, MAX_QTY, addItem, itemCount, previewSubtotal, removeLine, setNote, setQty, toPayload, type Cart } from './cart'

let n = 0
const key = () => `k${++n}`
const A = { id: 'a', name: 'Macchiato', price: '35.50' }
const B = { id: 'b', name: 'Tibs', price: 220 }

describe('POS cart', () => {
  it('adds, increments the note-less line, keeps noted lines separate', () => {
    let c: Cart = []
    c = addItem(c, A, key)
    c = addItem(c, A, key)
    expect(c).toHaveLength(1)
    expect(c[0]?.qty).toBe(2)
    c = setNote(c, c[0]!.key, 'no sugar')
    c = addItem(c, A, key)
    expect(c).toHaveLength(2)
    expect(itemCount(c)).toBe(3)
  })
  it('previews the subtotal in exact cents (server decides the real totals)', () => {
    let c: Cart = []
    c = addItem(c, A, key)
    c = addItem(c, A, key)
    c = addItem(c, A, key)
    c = addItem(c, B, key)
    expect(previewSubtotal(c)).toBe(326.5)
  })
  it('caps quantity and line count; zero quantity removes the line', () => {
    let c: Cart = addItem([], B, key)
    c = setQty(c, c[0]!.key, 500)
    expect(c[0]?.qty).toBe(MAX_QTY)
    c = setQty(c, c[0]!.key, 0)
    expect(c).toHaveLength(0)
    let many: Cart = []
    for (let i = 0; i < MAX_LINES + 5; i++) many = addItem(many, { id: `m${i}`, name: 'x', price: 1 }, key)
    expect(many).toHaveLength(MAX_LINES)
  })
  it('strips control characters from notes and builds an intent-only payload', () => {
    let c: Cart = addItem([], B, key)
    c = setNote(c, c[0]!.key, 'well\u0007 done  ')
    expect(toPayload(c)).toEqual([{ menu_item_id: 'b', qty: 1, note: 'well done' }])
    expect(JSON.stringify(toPayload(c))).not.toMatch(/price|total/)
    expect(removeLine(c, c[0]!.key)).toHaveLength(0)
  })
  it('ignores a malformed price', () => {
    expect(addItem([], { id: 'x', name: 'x', price: 'NaN' }, key)).toHaveLength(0)
  })
})
