import { z } from 'zod'
import { supabase } from './client'
import { callRpc } from './rpc'
import { numericValue, uuid } from './schemas'

// Orders (Phase 4, migration 0033). Every write is a security-definer RPC (clients hold SELECT only); the client sends intents:
// menu item ids, quantities, notes, an idempotency key, the order type and an optional table id. Prices, VAT, totals, the order
// number, station routing and stock consumption are decided by the database.

export const ORDER_TYPES = ['dine-in', 'takeaway', 'delivery'] as const
export type OrderType = (typeof ORDER_TYPES)[number]

const orderItemSchema = z.object({
  id: uuid,
  line_no: z.number().nullable().optional(),
  menu_item_id: uuid.nullable(),
  name: z.string(),
  price: numericValue,
  qty: z.number().int(),
  line_total: numericValue,
  station_id: uuid.nullable(),
  station_name: z.string().nullable().optional(),
  item_status: z.string(),
  note: z.string().nullable().optional(),
})

export const orderSchema = z.object({
  id: uuid,
  order_no: z.string(),
  source: z.string(),
  order_type: z.string(),
  status: z.string(),
  payment_status: z.string(),
  table_id: uuid.nullable().optional(),
  table_label: z.string().nullable().optional(),
  subtotal: numericValue,
  vat_rate: numericValue,
  vat_amount: numericValue,
  total: numericValue,
  created_at: z.string(),
  items: z.array(orderItemSchema),
  replayed: z.boolean().optional(),
})
export type Order = z.infer<typeof orderSchema>

export const ordersKeys = {
  openDay: (rid: string) => ['pos', rid, 'open-day'] as const,
  tables: (rid: string) => ['pos', rid, 'tables'] as const,
  mine: (rid: string) => ['pos', rid, 'my-orders'] as const,
}

export interface SubmitOrderInput {
  items: Array<{ menu_item_id: string; qty: number; note: string | null }>
  idempotencyKey: string
  orderType: OrderType
  tableId: string | null
  customerNote: string | null
}

/** A replay for a caller who may no longer read the order gets only its id and number. */
const replayReceiptSchema = z.object({ id: uuid, order_no: z.string(), replayed: z.literal(true) })
export type SubmitResult = Order | z.infer<typeof replayReceiptSchema>
export const isFullOrder = (r: SubmitResult): r is Order => 'items' in r

/** Submits the cart. A retry with the same idempotency key returns the SAME order (replayed: true), never a second one. */
export async function submitOrder(i: SubmitOrderInput): Promise<SubmitResult> {
  return orderSchema.or(replayReceiptSchema).parse(
    await callRpc('fn_submit_order', {
      p_items: i.items,
      p_idempotency_key: i.idempotencyKey,
      p_order_type: i.orderType,
      p_table_id: i.orderType === 'dine-in' ? i.tableId : null,
      p_customer_note: i.customerNote,
    }),
  )
}

const cancelResultSchema = z.object({
  order_id: uuid,
  order_no: z.string(),
  status: z.literal('cancelled'),
  reversed_movements: z.number().int().nonnegative(),
  already_cancelled: z.boolean(),
})
export type CancelResult = z.infer<typeof cancelResultSchema>

export async function cancelOrder(orderId: string, reason: string | null): Promise<CancelResult> {
  return cancelResultSchema.parse(await callRpc('fn_cancel_order', { p_order_id: orderId, p_reason: reason }))
}

const openDaySchema = z.object({ id: uuid, day_no: z.number(), opened_at: z.string() }).nullable()
export type OpenDay = z.infer<typeof openDaySchema>

/** The open business day (id, number, opened at) or null; the server re-checks on every order. */
export async function fetchOpenDay(): Promise<OpenDay> {
  return openDaySchema.parse(await callRpc('fn_get_open_day'))
}

export async function serveOrder(orderId: string): Promise<Order> {
  return orderSchema.parse(await callRpc('fn_serve_order', { p_order_id: orderId }))
}

const tableSchema = z.object({
  id: uuid,
  label: z.string(),
  status: z.string(),
  capacity: z.number().int(),
  sort_order: z.number().int(),
  is_active: z.boolean(),
})
export type PosTable = z.infer<typeof tableSchema>

/** Active tables of the caller's tenant (RLS tables_select allows orders.create). Out-of-service tables are excluded. */
export async function fetchTables(): Promise<PosTable[]> {
  const { data, error } = await supabase
    .from('tables')
    .select('id,label,status,capacity,sort_order,is_active')
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
  if (error) throw new Error('tables_unavailable')
  return z.array(tableSchema).parse(data ?? []).filter((t) => t.status !== 'out_of_service')
}

const myOrderSchema = z.object({
  id: uuid,
  order_no: z.string(),
  status: z.string(),
  payment_status: z.string(),
  order_type: z.string(),
  table_label_snapshot: z.string().nullable(),
  total: numericValue,
  created_at: z.string(),
})
export type MyOrder = z.infer<typeof myOrderSchema>

/** Orders of the open business day the caller may see (RLS orders_select), newest first. */
export async function fetchDayOrders(dayId: string): Promise<MyOrder[]> {
  const { data, error } = await supabase
    .from('orders')
    .select('id,order_no,status,payment_status,order_type,table_label_snapshot,total,created_at')
    .eq('day_session_id', dayId)
    .order('created_at', { ascending: false })
    .limit(100)
  if (error) throw new Error('orders_unavailable')
  return z.array(myOrderSchema).parse(data ?? [])
}

/** Realtime: any change to the tenant's visible orders (RLS-filtered) invalidates the list. */
export function subscribeToOrders(restaurantId: string, onChange: () => void): () => void {
  const channel = supabase
    .channel(`pos-orders-${restaurantId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'orders', filter: `restaurant_id=eq.${restaurantId}` }, onChange)
    .subscribe()
  return () => {
    void supabase.removeChannel(channel)
  }
}
