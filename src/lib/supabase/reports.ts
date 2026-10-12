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

// ── Period reports (fn_report_period) and export audit (fn_log_report_export) ─────────────────────────────────────────
// Tolerant by design: the server withholds whole sections the caller may not see (listed in `restricted`) and returns them
// as null, so every section and KPI is nullable here; the UI shows a neutral notice instead of data.

/** Optional on the wire, always `T | null` after parsing. */
const opt = <T extends z.ZodTypeAny>(s: T) => s.nullish().transform((v): z.output<T> | null => v ?? null)
const money = opt(numericValue)
const count = opt(z.number().int())

const periodKpisSchema = z.object({
  order_count: count,
  cancelled_count: count,
  items_sold: count,
  sales_total: money,
  subtotal_total: money,
  vat_total: money,
  avg_order_value: money,
  gross_collected: money,
  cash_collected: money,
  expenses_total: money,
  net_position: money,
  unpaid_total: money,
  vouchers_outstanding: money,
  vouchers_overdue: count,
})
export type PeriodKpis = z.infer<typeof periodKpisSchema>

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

export const REPORT_SECTIONS = ['expenses', 'installments', 'inventory', 'staff', 'payments'] as const
export type ReportSection = (typeof REPORT_SECTIONS)[number]

export const periodReportSchema = z.object({
  timezone,
  period: z.object({ from: isoDay, to: isoDay }),
  days: z.array(z.object({ id: uuid, day_no: z.number().int(), status: z.string(), opened_at: z.string(), closed_at: z.string().nullable() })).default([]),
  kpis: periodKpisSchema.default({}),
  by_day: opt(
    z.array(
      z.object({
        day_session_id: uuid,
        day_no: z.number().int(),
        date: z.string(),
        orders: z.number().int(),
        sales: numericValue,
        collected: numericValue,
        expenses: money,
      }),
    ),
  ),
  by_payment_method: opt(z.array(methodSchema)),
  by_category: opt(z.array(z.object({ category_id: uuid.nullable(), name: z.string().nullable(), qty: z.number().int(), amount: numericValue }))),
  by_item: opt(z.array(z.object({ menu_item_id: uuid.nullable(), name: z.string().nullable(), qty: z.number().int(), amount: numericValue }))),
  by_waiter: opt(z.array(z.object({ user_id: uuid.nullable(), name: z.string().nullable(), orders: z.number().int(), sales: numericValue }))),
  by_expense_category: opt(
    z.array(z.object({ expense_category_id: uuid, name: z.string().nullable(), amount: numericValue, count: z.number().int() })),
  ),
  by_hour: opt(z.array(hourSchema)),
  inventory: opt(
    z.object({
      low_stock: z.array(z.object({ ingredient_id: uuid, name: z.string(), unit: z.string(), stock: numericValue, min_level: numericValue })),
      consumption: z.array(z.object({ ingredient_id: uuid, name: z.string(), unit: z.string(), qty: numericValue })),
    }),
  ),
  cancellations: opt(
    z.object({
      count: z.number().int(),
      amount: numericValue,
      items: z.array(
        z.object({ order_no: z.string(), total: numericValue, reason: z.string().nullable().optional(), cancelled_at: z.string(), by_name: z.string().nullable().optional() }),
      ),
    }),
  ),
  reversals: opt(
    z.object({
      count: z.number().int(),
      amount: numericValue,
      items: z.array(
        z.object({
          receipt_no: z.string().nullable(),
          amount: numericValue,
          method: z.string().nullable(),
          created_at: z.string(),
          by_name: z.string().nullable().optional(),
        }),
      ),
    }),
  ),
  installments: opt(
    z.object({
      issued_count: z.number().int(),
      issued_total: numericValue,
      down_total: numericValue,
      collected_total: numericValue,
      outstanding_total: numericValue,
      overdue_count: z.number().int(),
    }),
  ),
  restricted: z.array(z.string()).nullish().transform((v) => (v ?? []).filter((s): s is ReportSection => (REPORT_SECTIONS as readonly string[]).includes(s))),
})
export type PeriodReport = z.infer<typeof periodReportSchema>

export const periodReportKey = (rid: string, from: string, to: string) => ['reports', 'period', rid, from, to] as const

/** reports.view. Dates are tenant-local calendar dates "YYYY-MM-DD"; no tenant id is sent (derived from the session). */
export async function fetchReportPeriod(from: string, to: string): Promise<PeriodReport> {
  return periodReportSchema.parse(await callRpc('fn_report_period', { p_from: from, p_to: to }))
}

export const REPORT_TYPES = ['summary', 'revenue', 'expenses', 'inventory', 'payments', 'staff', 'items', 'installments', 'cancellations', 'hourly'] as const
export type ReportType = (typeof REPORT_TYPES)[number]
export type ExportFormat = 'csv' | 'pdf' | 'print'

/**
 * Audits an export (reports.export, server-enforced). Must succeed BEFORE any file or print is produced; throws RpcError
 * (permission_denied, invalid_input, ...) otherwise.
 */
export async function logReportExport(report: ReportType, from: string, to: string, format: ExportFormat): Promise<{ exported_at: string }> {
  const r = z
    .object({ ok: z.literal(true), exported_at: z.string() })
    .passthrough()
    .parse(await callRpc('fn_log_report_export', { p_report: report, p_from: from, p_to: to, p_format: format }))
  return { exported_at: r.exported_at }
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
