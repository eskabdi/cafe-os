import { z } from 'zod'
import { supabase } from './client'
import { callRpc } from './rpc'
import { numericValue, uuid } from './schemas'

// Dashboard and reports (Phase 8, migration 0037). Every figure is computed by the database; the client only renders it.
// Both RPCs derive the tenant from the session (no restaurant id is sent); see docs/api/reports.md.

export const reportsKeys = {
  report: (rid: string, from: number | null, to: number | null) => ['reports', rid, from ?? 'open', to ?? 'open'] as const,
  dashboard: (rid: string) => ['dashboard', rid] as const,
}

const kpisSchema = z.object({
  order_count: z.number().int(),
  cancelled_count: z.number().int(),
  items_sold: z.number().int(),
  sales_total: numericValue,
  avg_order_value: numericValue,
  gross_collected: numericValue,
  cash_collected: numericValue,
  expenses_total: numericValue,
  net_position: numericValue,
  unpaid_total: numericValue,
  vouchers_outstanding: numericValue,
  vouchers_overdue: z.number().int(),
})
export type Kpis = z.infer<typeof kpisSchema>

const hourSchema = z.object({ hour: z.number().int(), orders: z.number().int(), sales: numericValue })
const methodSchema = z.object({ payment_method_id: uuid, name: z.string(), amount: numericValue, count: z.number().int() })

const timezone = z
  .string()
  .regex(/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}$/)
  .catch('Africa/Addis_Ababa')

export const reportSchema = z.object({
  timezone,
  days: z.array(z.object({ id: uuid, day_no: z.number().int(), status: z.string(), opened_at: z.string(), closed_at: z.string().nullable() })),
  kpis: kpisSchema,
  by_payment_method: z.array(methodSchema),
  by_category: z.array(z.object({ category_id: uuid.nullable(), name: z.string().nullable(), qty: z.number().int(), amount: numericValue })),
  by_waiter: z.array(z.object({ user_id: uuid.nullable(), name: z.string().nullable(), orders: z.number().int(), sales: numericValue })),
  by_expense_category: z.array(z.object({ expense_category_id: uuid, name: z.string().nullable(), amount: numericValue, count: z.number().int() })),
  by_hour: z.array(hourSchema),
  inventory: z.object({
    low_stock: z.array(z.object({ ingredient_id: uuid, name: z.string(), unit: z.string(), stock: numericValue, min_level: numericValue })),
    consumption: z.array(z.object({ ingredient_id: uuid, name: z.string(), unit: z.string(), qty: numericValue })),
  }),
})
export type Report = z.infer<typeof reportSchema>

export async function fetchReport(from: number | null, to: number | null): Promise<Report> {
  return reportSchema.parse(await callRpc('fn_report', { p_from_day_no: from, p_to_day_no: to }))
}

export const dashboardSchema = z.object({
  timezone,
  open_day: z.object({ id: uuid, day_no: z.number().int(), opened_at: z.string() }).nullable(),
  orders_by_status: z.record(z.string(), z.number().int()),
  recent: z.array(
    z.object({
      id: uuid,
      order_no: z.string(),
      status: z.string(),
      payment_status: z.string(),
      table_label: z.string().nullable(),
      created_at: z.string(),
      total: numericValue.nullable().optional(),
    }),
  ),
  // null without inventory.view / reports.view (withheld by the server)
  low_stock_count: z.number().int().nullable(),
  money: kpisSchema.optional(),
  by_hour: z.array(hourSchema).optional(),
  by_payment_method: z.array(methodSchema).optional(),
})
export type Dashboard = z.infer<typeof dashboardSchema>

export async function fetchDashboard(): Promise<Dashboard> {
  return dashboardSchema.parse(await callRpc('fn_dashboard'))
}

/**
 * Realtime: orders and payments of the tenant (RLS-filtered) refresh the live figures. Unique topic per mount (two tabs or a
 * remount never share a channel). onChange also fires once on SUBSCRIBED so a change made while connecting is not missed.
 */
export function subscribeToActivity(restaurantId: string, onChange: () => void): () => void {
  const filter = `restaurant_id=eq.${restaurantId}`
  const channel = supabase
    .channel(`activity-${restaurantId}-${crypto.randomUUID()}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'orders', filter }, onChange)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'payments', filter }, onChange)
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') onChange()
    })
  return () => {
    void supabase.removeChannel(channel)
  }
}
