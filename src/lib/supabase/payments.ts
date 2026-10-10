import { z } from 'zod'
import { supabase } from './client'
import { callRpc } from './rpc'
import { numericValue, rowColor, rowIcon, uuid } from './schemas'

// Payments (Phase 6, migration 0034). The client sends intents only: order id, payment method id (a tenant row, never a name),
// reference and, for a cash-drawer method, the amount tendered. The amount, receipt number and method snapshots are decided by
// fn_confirm_payment. A confirmed payment is never edited: fn_reverse_payment appends a compensating reversal.

export const paymentsKeys = {
  methods: (rid: string) => ['payment-methods', rid] as const,
  unpaid: (rid: string, dayId: string) => ['cashier', rid, 'unpaid', dayId] as const,
  order: (rid: string, orderId: string) => ['cashier', rid, 'order', orderId] as const,
  history: (rid: string, dayId: string) => ['cashier', rid, 'history', dayId] as const,
  receipt: (rid: string, paymentId: string) => ['cashier', rid, 'receipt', paymentId] as const,
  timezone: (rid: string) => ['tenant-timezone', rid] as const,
}

export const paymentMethodSchema = z.object({
  id: uuid,
  name: z.string().min(1).max(60),
  description: z.string().max(300).nullable().optional(),
  color: rowColor,
  icon: rowIcon,
  sort_order: z.number().int().nullable().optional(),
  is_active: z.boolean(),
  affects_cash_drawer: z.boolean(),
  requires_reference: z.boolean(),
})
export type PaymentMethod = z.infer<typeof paymentMethodSchema>

/** Active payment methods of the caller's tenant (RLS payment_methods_select), in the tenant's order. */
export async function fetchPaymentMethods(): Promise<PaymentMethod[]> {
  const { data, error } = await supabase
    .from('payment_methods')
    .select('id,name,description,color,icon,sort_order,is_active,affects_cash_drawer,requires_reference')
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
  if (error) throw new Error('payment_methods_unavailable')
  const out: PaymentMethod[] = []
  for (const row of data ?? []) {
    const p = paymentMethodSchema.safeParse(row)
    if (p.success) out.push(p.data)
  }
  return out
}

const unpaidOrderSchema = z.object({
  id: uuid,
  order_no: z.string(),
  status: z.string(),
  order_type: z.string(),
  table_label_snapshot: z.string().nullable(),
  created_by_name_snapshot: z.string().nullable().optional(),
  total: numericValue,
  created_at: z.string(),
})
export type UnpaidOrder = z.infer<typeof unpaidOrderSchema>

export const UNPAID_LIMIT = 200

/** Unpaid, not cancelled orders of the open business day with something to pay, oldest first (RLS orders_select). */
export async function fetchUnpaidOrders(dayId: string): Promise<UnpaidOrder[]> {
  const { data, error } = await supabase
    .from('orders')
    .select('id,order_no,status,order_type,table_label_snapshot,created_by_name_snapshot,total,created_at')
    .eq('day_session_id', dayId)
    .eq('payment_status', 'unpaid')
    .neq('status', 'cancelled')
    .gt('total', 0)
    .order('created_at', { ascending: true })
    .limit(UNPAID_LIMIT)
  if (error) throw new Error('orders_unavailable')
  return z.array(unpaidOrderSchema).parse(data ?? [])
}

const orderLineSchema = z.object({
  id: uuid,
  name_snapshot: z.string(),
  qty: z.number().int(),
  price_snapshot: numericValue,
  item_status: z.string(),
})
const orderDetailSchema = z.object({
  id: uuid,
  order_no: z.string(),
  status: z.string(),
  payment_status: z.string(),
  subtotal: numericValue,
  vat_rate_snapshot: numericValue,
  vat_amount: numericValue,
  total: numericValue,
  order_items: z.array(orderLineSchema),
})
export type OrderDetail = z.infer<typeof orderDetailSchema>

/** One order with its lines, for the bill preview. The amount charged is still decided by the server. */
export async function fetchOrderDetail(orderId: string): Promise<OrderDetail | null> {
  const { data, error } = await supabase
    .from('orders')
    .select('id,order_no,status,payment_status,subtotal,vat_rate_snapshot,vat_amount,total,order_items(id,name_snapshot,qty,price_snapshot,item_status)')
    .eq('id', orderId)
    .maybeSingle()
  if (error) throw new Error('order_unavailable')
  return data ? orderDetailSchema.parse(data) : null
}

const receiptLineSchema = z.object({ name: z.string(), qty: z.number().int(), price: numericValue, line_total: numericValue })
export const receiptSchema = z.object({
  payment_id: uuid,
  receipt_no: z.string(),
  kind: z.string(),
  amount: numericValue,
  created_at: z.string(),
  method: z.string(),
  affects_cash_drawer: z.boolean(),
  reference: z.string().nullable(),
  reversed_payment_id: uuid.nullable(),
  reversed: z.boolean(),
  received_by: z.string().nullable(),
  restaurant: z
    .object({
      name: z.string(),
      phone: z.string().nullable().optional(),
      address: z.string().nullable().optional(),
      tin: z.string().nullable().optional(),
      timezone: z.string().nullable().optional(),
    })
    .nullable(),
  order: z
    .object({
      id: uuid,
      order_no: z.string(),
      order_type: z.string(),
      table_label: z.string().nullable(),
      taken_by: z.string().nullable(),
      created_at: z.string(),
      subtotal: numericValue,
      vat_rate: numericValue,
      vat_amount: numericValue,
      total: numericValue,
      items: z.array(receiptLineSchema),
    })
    .nullable(),
  tendered: numericValue.nullable().optional(),
  change: numericValue.nullable().optional(),
  replayed: z.boolean().optional(),
})
export type Receipt = z.infer<typeof receiptSchema>

export interface ConfirmPaymentInput {
  orderId: string
  paymentMethodId: string
  reference: string | null
  tendered: number | null
  idempotencyKey: string
}

/** Pays the order in full. A retry with the same key returns the SAME receipt (replayed: true), never a second payment. */
export async function confirmPayment(i: ConfirmPaymentInput): Promise<Receipt> {
  return receiptSchema.parse(
    await callRpc('fn_confirm_payment', {
      p_order_id: i.orderId,
      p_payment_method_id: i.paymentMethodId,
      p_reference: i.reference,
      p_idempotency_key: i.idempotencyKey,
      p_tendered: i.tendered,
    }),
  )
}

/** Appends a compensating reversal (payments.reverse + a recent authenticator code); the order becomes unpaid again. */
export async function reversePayment(paymentId: string, reason: string, idempotencyKey: string): Promise<Receipt> {
  return receiptSchema.parse(
    await callRpc('fn_reverse_payment', { p_payment_id: paymentId, p_reason: reason, p_idempotency_key: idempotencyKey }),
  )
}

export async function fetchReceipt(paymentId: string): Promise<Receipt> {
  return receiptSchema.parse(await callRpc('fn_get_receipt', { p_payment_id: paymentId }))
}

const paymentRowSchema = z.object({
  id: uuid,
  receipt_no: z.string(),
  kind: z.string(),
  amount: numericValue,
  method_name_snapshot: z.string(),
  reference: z.string().nullable(),
  reversed_payment_id: uuid.nullable(),
  order_id: uuid.nullable(),
  created_at: z.string(),
  orders: z.object({ order_no: z.string() }).nullable().optional(),
})
export type PaymentRow = z.infer<typeof paymentRowSchema>

/** Payments of a business day (RLS payments_select: payments.view), newest first. */
export async function fetchDayPayments(dayId: string): Promise<PaymentRow[]> {
  const { data, error } = await supabase
    .from('payments')
    .select('id,receipt_no,kind,amount,method_name_snapshot,reference,reversed_payment_id,order_id,created_at,orders(order_no)')
    .eq('day_session_id', dayId)
    .order('created_at', { ascending: false })
    .limit(300)
  if (error) throw new Error('payments_unavailable')
  return z.array(paymentRowSchema).parse(data ?? [])
}

/** The tenant's time zone (restaurants.timezone, RLS: own restaurant) for local dates and the Ethiopian clock. */
export async function fetchTenantTimezone(): Promise<string> {
  const { data, error } = await supabase.from('restaurants').select('timezone').maybeSingle()
  if (error) throw new Error('restaurant_unavailable')
  const tz = (data as { timezone?: unknown } | null)?.timezone
  return typeof tz === 'string' && /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}$/.test(tz) ? tz : 'Africa/Addis_Ababa'
}

/** Realtime: orders and payments of the tenant (RLS-filtered) invalidate the cashier lists. Unique topic per mount. */
export function subscribeToCashier(restaurantId: string, onChange: () => void, onSubscribed?: () => void): () => void {
  const filter = `restaurant_id=eq.${restaurantId}`
  const channel = supabase
    .channel(`cashier-${restaurantId}-${crypto.randomUUID()}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'orders', filter }, onChange)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'payments', filter }, onChange)
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') onSubscribed?.()
    })
  return () => {
    void supabase.removeChannel(channel)
  }
}
