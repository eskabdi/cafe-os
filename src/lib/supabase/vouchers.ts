import { z } from 'zod'
import { supabase } from './client'
import { receiptSchema, type Receipt } from './payments'
import { callRpc } from './rpc'
import { numericValue, uuid } from './schemas'

// Installment vouchers (Phase 7, migration 0035). Intents only: the order id, the customer, the down payment and its method row,
// the number of installments and their interval. The schedule, amounts, voucher number and status are decided by the database;
// status (active / overdue / settled) is COMPUTED there, never stored.

export const vouchersKeys = {
  list: (rid: string, status: string) => ['vouchers', rid, 'list', status] as const,
  one: (rid: string, id: string) => ['vouchers', rid, 'one', id] as const,
}

const installmentSchema = z.object({
  no: z.number().int(),
  due_date: z.string(),
  amount: numericValue,
  paid: z.boolean(),
  paid_at: z.string().nullable(),
  payment_id: uuid.nullable(),
})

export const voucherSchema = z.object({
  id: uuid,
  voucher_no: z.string(),
  order_id: uuid,
  order_no: z.string().nullable(),
  customer_name: z.string(),
  customer_phone: z.string().nullable(),
  total: numericValue,
  down_payment: numericValue,
  installment_count: z.number().int(),
  interval_days: z.number().int(),
  created_at: z.string(),
  paid_installments: z.number().int(),
  paid_amount: numericValue,
  outstanding: numericValue,
  status: z.enum(['active', 'overdue', 'settled']),
  next_due: z.object({ no: z.number().int(), due_date: z.string(), amount: numericValue }).nullable(),
  installments: z.array(installmentSchema).optional(),
})
export type Voucher = z.infer<typeof voucherSchema>

export async function listVouchers(status: 'all' | Voucher['status']): Promise<Voucher[]> {
  return z
    .array(voucherSchema)
    .parse(await callRpc('fn_list_vouchers', { p_status: status === 'all' ? null : status, p_limit: 200 }))
}

export async function getVoucher(id: string): Promise<Voucher> {
  return voucherSchema.parse(await callRpc('fn_get_voucher', { p_voucher_id: id }))
}

export interface GenerateVoucherInput {
  orderId: string
  customerName: string
  customerPhone: string | null
  downPayment: number
  downMethodId: string | null
  downReference: string | null
  installmentCount: number
  intervalDays: number
  idempotencyKey: string
}

const generateResultSchema = z.object({
  voucher: voucherSchema,
  down_receipt: receiptSchema.nullable(),
  replayed: z.boolean().optional(),
})
export type GenerateVoucherResult = z.infer<typeof generateResultSchema>

/** Issues the voucher. A retry with the same key returns the SAME voucher (replayed: true). */
export async function generateVoucher(i: GenerateVoucherInput): Promise<GenerateVoucherResult> {
  return generateResultSchema.parse(
    await callRpc('fn_generate_voucher', {
      p_order_id: i.orderId,
      p_customer_name: i.customerName,
      p_customer_phone: i.customerPhone,
      p_down_payment: i.downPayment,
      p_down_method_id: i.downMethodId,
      p_down_reference: i.downReference,
      p_installment_count: i.installmentCount,
      p_interval_days: i.intervalDays,
      p_idempotency_key: i.idempotencyKey,
    }),
  )
}

export interface ConfirmInstallmentInput {
  voucherId: string
  paymentMethodId: string
  reference: string | null
  installmentNo: number
  tendered: number | null
  idempotencyKey: string
}

/** Collects the NEXT installment at its scheduled amount; installmentNo guards against collecting a stale one twice. */
export async function confirmInstallment(i: ConfirmInstallmentInput): Promise<Receipt & { voucher_status?: string }> {
  return receiptSchema.extend({ voucher_status: z.string().optional() }).parse(
    await callRpc('fn_confirm_installment', {
      p_voucher_id: i.voucherId,
      p_payment_method_id: i.paymentMethodId,
      p_reference: i.reference,
      p_idempotency_key: i.idempotencyKey,
      p_installment_no: i.installmentNo,
      p_tendered: i.tendered,
    }),
  )
}

/** Realtime: voucher, installment and payment changes of the tenant (RLS-filtered) invalidate the lists. Unique topic per mount. */
export function subscribeToVouchers(restaurantId: string, onChange: () => void): () => void {
  const filter = `restaurant_id=eq.${restaurantId}`
  const channel = supabase
    .channel(`vouchers-${restaurantId}-${crypto.randomUUID()}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'vouchers', filter }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'installments', filter }, onChange)
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') onChange()
    })
  return () => {
    void supabase.removeChannel(channel)
  }
}
