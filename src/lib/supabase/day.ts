import { z } from 'zod'
import { supabase } from './client'
import { callRpc } from './rpc'
import { numericValue, rowColor, rowIcon, uuid } from './schemas'

// Business day (Phase 9, migration 0038) and expenses. Close / open are RPCs (atomic, audited); expenses are direct writes under RLS
// (expenses.manage) whose day, method snapshot and author are filled by triggers: the client never sets them.

export const dayKeys = {
  preview: (rid: string) => ['day', rid, 'preview'] as const,
  history: (rid: string) => ['day', rid, 'history'] as const,
  expenses: (rid: string, dayId: string) => ['day', rid, 'expenses', dayId] as const,
  expenseCategories: (rid: string) => ['expense-categories', rid] as const,
  countables: (rid: string) => ['day', rid, 'countables'] as const,
}

const stationSnapSchema = z.object({
  station_id: uuid,
  name: z.string(),
  expected: numericValue,
  counted: numericValue,
  variance: numericValue,
  items: z.array(
    z.object({ ingredient_id: uuid, name: z.string(), unit: z.string(), expected: numericValue, counted: numericValue, variance: numericValue }),
  ),
})
const lineSchema = z.object({ name: z.string().nullable(), amount: numericValue, count: z.number().int() })

export const previewSchema = z.object({
  day_id: uuid,
  day_no: z.number().int(),
  opened_at: z.string(),
  opening_float: numericValue,
  order_count: z.number().int(),
  unpaid_orders: z.number().int(),
  gross_collected: numericValue,
  cash_collected: numericValue,
  cash_expenses: numericValue,
  expenses_total: numericValue,
  expected_cash: numericValue,
  payment_snapshot: z.array(lineSchema.extend({ payment_method_id: uuid })),
  expense_snapshot: z.array(lineSchema.extend({ expense_category_id: uuid })),
  station_snapshot: z.array(stationSnapSchema),
  inventory_variance: numericValue,
})
export type DayPreview = z.infer<typeof previewSchema>

export const daySchema = z.object({
  id: uuid,
  day_no: z.number().int(),
  status: z.enum(['open', 'closed']),
  opened_at: z.string(),
  opening_float: numericValue,
  opened_by: z.string().nullable(),
  closed_at: z.string().nullable(),
  closed_by: z.string().nullable(),
  order_count: z.number().int().nullable(),
  gross_collected: numericValue.nullable(),
  cash_collected: numericValue.nullable(),
  cash_expenses: numericValue.nullable(),
  expenses_total: numericValue.nullable(),
  expected_cash: numericValue.nullable(),
  counted_cash: numericValue.nullable(),
  cash_variance: numericValue.nullable(),
  net_profit: numericValue.nullable(),
  inventory_variance: numericValue.nullable(),
  station_snapshot: z.array(stationSnapSchema).nullable(),
  expense_snapshot: z.array(lineSchema.extend({ expense_category_id: uuid })).nullable(),
  payment_snapshot: z.array(lineSchema.extend({ payment_method_id: uuid })).nullable(),
  close_note: z.string().nullable(),
  replayed: z.boolean().optional(),
})
export type Day = z.infer<typeof daySchema>

export async function fetchClosePreview(): Promise<DayPreview> {
  return previewSchema.parse(await callRpc('fn_close_day_preview'))
}

export async function fetchDays(): Promise<Day[]> {
  return z.array(daySchema).parse(await callRpc('fn_list_days', { p_limit: 60 }))
}

export interface CloseDayInput {
  countedCash: number
  stationCounts: Array<{ ingredient_id: string; counted: number }>
  note: string | null
  idempotencyKey: string
}

export async function closeDay(i: CloseDayInput): Promise<Day> {
  return daySchema.parse(
    await callRpc('fn_close_day', {
      p_counted_cash: i.countedCash,
      p_station_counts: i.stationCounts,
      p_note: i.note,
      p_idempotency_key: i.idempotencyKey,
    }),
  )
}

export async function openDay(openingFloat: number, idempotencyKey: string): Promise<Day> {
  return daySchema.parse(await callRpc('fn_open_day', { p_opening_float: openingFloat, p_idempotency_key: idempotencyKey }))
}

export const expenseCategorySchema = z.object({
  id: uuid,
  name: z.string().min(1).max(60),
  color: rowColor,
  icon: rowIcon,
  sort_order: z.number().int().nullable().optional(),
  is_active: z.boolean(),
})
export type ExpenseCategory = z.infer<typeof expenseCategorySchema>

export async function fetchExpenseCategories(): Promise<ExpenseCategory[]> {
  const { data, error } = await supabase
    .from('expense_categories')
    .select('id,name,color,icon,sort_order,is_active')
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
  if (error) throw new Error('expense_categories_unavailable')
  return (data ?? []).flatMap((r) => {
    const p = expenseCategorySchema.safeParse(r)
    return p.success ? [p.data] : []
  })
}

const expenseSchema = z.object({
  id: uuid,
  amount: numericValue,
  description: z.string().nullable(),
  method_name_snapshot: z.string().nullable(),
  expense_category_id: uuid,
  created_at: z.string(),
})
export type Expense = z.infer<typeof expenseSchema>

/** Expenses of a business day (RLS expenses_select), newest first. */
export async function fetchExpenses(dayId: string): Promise<Expense[]> {
  const { data, error } = await supabase
    .from('expenses')
    .select('id,amount,description,method_name_snapshot,expense_category_id,created_at')
    .eq('day_session_id', dayId)
    .order('created_at', { ascending: false })
  if (error) throw new Error('expenses_unavailable')
  return z.array(expenseSchema).parse(data ?? [])
}

export interface NewExpense {
  restaurantId: string
  categoryId: string
  paymentMethodId: string
  amount: number
  description: string | null
}

/**
 * Records an expense. restaurant_id must equal the caller's tenant (RLS with-check refuses anything else); the business day, the
 * method snapshot and the author are set by triggers.
 */
export async function addExpense(e: NewExpense): Promise<void> {
  // expense_date is NOT NULL without a default in the generated type, but fn_expense_context (0016) derives it from the open business
  // day and refuses any client-supplied value that differs: the client never sends it.
  const row = {
    restaurant_id: e.restaurantId,
    expense_category_id: e.categoryId,
    payment_method_id: e.paymentMethodId,
    amount: e.amount,
    description: e.description,
  } as { restaurant_id: string; expense_category_id: string; payment_method_id: string; amount: number; description: string | null; expense_date: string }
  const { error } = await supabase.from('expenses').insert(row)
  if (error) throw new Error(error.message?.includes('day_closed') || error.message?.includes('no_open_day') ? 'day_closed' : 'expense_failed')
}
