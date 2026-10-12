import { formatEtb, formatQty } from '@/lib/domain/decimal'
import { formatEthiopianDateTime, formatInternationalDateTime } from '@/lib/domain/ethiopian-time'
import { ethiopianHourLabel, internationalHourLabel } from '@/lib/domain/reports'
import { ethiopianDateLabel, isIsoDate } from '@/lib/domain/reports-period'
import type { PeriodReport, ReportSection, ReportType } from '@/lib/supabase/reports'

// One presentation model per report type, shared by the screen, the print layout, CSV and PDF so all four always show the
// same rows. No figure is computed here (every amount comes from fn_report_period); names are the rows' / snapshots'.

export type CellKind = 'money' | 'int' | 'qty' | 'text'
export type Cell = string | number | null

export interface ReportColumn {
  key: string
  header: string
  kind: CellKind
}

export interface ReportTable {
  id: string
  title: string
  columns: ReportColumn[]
  rows: Array<Record<string, Cell>>
  /** Withheld by the server (no permission): render the neutral notice instead of rows. */
  restricted: boolean
  empty: string
}

export interface ReportKpi {
  label: string
  value: number | null
  kind: 'money' | 'int'
  hint?: string
}

export interface ReportView {
  type: ReportType
  title: string
  kpis: ReportKpi[]
  tables: ReportTable[]
}

/**
 * The section permission a report type depends on. fn_log_report_export refuses the export when the caller lacks it, so the
 * export buttons are hidden while that section is in `restricted` (UX only; the server decides).
 */
export const REPORT_SECTION: Partial<Record<ReportType, ReportSection>> = {
  expenses: 'expenses',
  inventory: 'inventory',
  payments: 'payments',
  staff: 'staff',
  installments: 'installments',
}

export function canExportView(type: ReportType, restricted: readonly ReportSection[]): boolean {
  const s = REPORT_SECTION[type]
  return s === undefined || !restricted.includes(s)
}

export const RESTRICTED_NOTICE = 'Not available with your permissions'

export const REPORT_TITLES: Record<ReportType, string> = {
  summary: 'Summary',
  revenue: 'Revenue',
  expenses: 'Expenses',
  inventory: 'Inventory',
  payments: 'Payments by method',
  staff: 'Waiter performance',
  items: 'Item & category sales',
  installments: 'Installments & vouchers',
  cancellations: 'Cancellations & reversals',
  hourly: 'Hourly traffic',
}

/** Display text of a cell (screen, print, PDF). CSV writes the raw value instead. */
export function formatCell(kind: CellKind, v: Cell): string {
  if (v === null) return '—'
  if (kind === 'money') return formatEtb(v)
  if (kind === 'qty') return formatQty(v)
  return String(v)
}

export function formatKpi(k: ReportKpi): string {
  if (k.value === null) return RESTRICTED_NOTICE
  return k.kind === 'money' ? formatEtb(k.value) : String(k.value)
}

/** "13 መስከረም 2019, 1:05 ማታ (2026-09-23 19:05)". */
export function formatInstant(iso: string, tz: string): string {
  const intl = formatInternationalDateTime(iso, tz)
  return intl ? `${formatEthiopianDateTime(iso, tz)} (${intl})` : ''
}

const col = (key: string, header: string, kind: CellKind = 'text'): ReportColumn => ({ key, header, kind })

function table(
  id: string,
  title: string,
  columns: ReportColumn[],
  rows: Array<Record<string, Cell>> | null,
  restricted: boolean,
  empty = 'Nothing in this period.',
): ReportTable {
  return { id, title, columns, rows: restricted || rows === null ? [] : rows, restricted: restricted || rows === null, empty }
}

const dayDate = (d: string) => (isIsoDate(d) ? ethiopianDateLabel(d) : d)

function byDayTable(r: PeriodReport, withExpenses: boolean, expensesRestricted: boolean): ReportTable {
  const columns = [col('ethiopian', 'Date'), col('date', 'Gregorian'), col('day_no', 'Business day', 'int'), col('orders', 'Orders', 'int')]
  columns.push(col('sales', 'Sales', 'money'), col('collected', 'Collected', 'money'))
  if (withExpenses && !expensesRestricted) columns.push(col('expenses', 'Expenses', 'money'))
  const rows =
    r.by_day?.map((d) => ({
      ethiopian: dayDate(d.date),
      date: d.date,
      day_no: d.day_no,
      orders: d.orders,
      sales: d.sales,
      collected: d.collected,
      expenses: d.expenses,
    })) ?? null
  return table('by-day', 'By business day', columns, rows, false)
}

function categoryTable(r: PeriodReport): ReportTable {
  return table(
    'by-category',
    'Sales by category (before VAT)',
    [col('name', 'Category'), col('qty', 'Qty', 'int'), col('amount', 'Amount', 'money')],
    r.by_category?.map((c) => ({ name: c.name ?? 'Uncategorised', qty: c.qty, amount: c.amount })) ?? null,
    false,
  )
}

/** Builds the model of one report type from the server payload. */
export function buildReportView(type: ReportType, r: PeriodReport): ReportView {
  const k = r.kpis
  const blocked = (s: ReportSection) => r.restricted.includes(s)
  const title = REPORT_TITLES[type]
  const tz = r.timezone
  switch (type) {
    case 'summary':
      return {
        type,
        title,
        kpis: [
          { label: 'Sales', value: k.sales_total, kind: 'money' },
          { label: 'Collected', value: k.gross_collected, kind: 'money' },
          { label: 'Expenses', value: blocked('expenses') ? null : k.expenses_total, kind: 'money' },
          { label: 'Net position', value: blocked('expenses') ? null : k.net_position, kind: 'money', hint: 'collected minus expenses' },
          { label: 'Orders', value: k.order_count, kind: 'int' },
          { label: 'Items sold', value: k.items_sold, kind: 'int' },
          { label: 'Average order', value: k.avg_order_value, kind: 'money' },
          { label: 'Cancelled orders', value: k.cancelled_count, kind: 'int' },
          { label: 'Unpaid', value: k.unpaid_total, kind: 'money' },
          { label: 'Installments outstanding', value: blocked('installments') ? null : k.vouchers_outstanding, kind: 'money' },
        ],
        tables: [byDayTable(r, true, blocked('expenses'))],
      }
    case 'revenue':
      return {
        type,
        title,
        kpis: [
          { label: 'Sales', value: k.sales_total, kind: 'money' },
          { label: 'Before VAT', value: k.subtotal_total, kind: 'money' },
          { label: 'VAT', value: k.vat_total, kind: 'money' },
          { label: 'Collected', value: k.gross_collected, kind: 'money' },
          { label: 'Average order', value: k.avg_order_value, kind: 'money' },
          { label: 'Unpaid', value: k.unpaid_total, kind: 'money' },
        ],
        tables: [byDayTable(r, false, true), categoryTable(r)],
      }
    case 'expenses': {
      const no = blocked('expenses')
      return {
        type,
        title,
        kpis: [
          { label: 'Expenses', value: no ? null : k.expenses_total, kind: 'money' },
          { label: 'Collected', value: k.gross_collected, kind: 'money' },
          { label: 'Net position', value: no ? null : k.net_position, kind: 'money', hint: 'collected minus expenses' },
        ],
        tables: [
          table(
            'by-expense-category',
            'Expenses by category',
            [col('name', 'Category'), col('count', 'Entries', 'int'), col('amount', 'Amount', 'money')],
            r.by_expense_category?.map((e) => ({ name: e.name ?? '—', count: e.count, amount: e.amount })) ?? null,
            no,
          ),
          table(
            'expenses-by-day',
            'Expenses by business day',
            [col('ethiopian', 'Date'), col('date', 'Gregorian'), col('expenses', 'Expenses', 'money')],
            r.by_day?.map((d) => ({ ethiopian: dayDate(d.date), date: d.date, expenses: d.expenses })) ?? null,
            no,
          ),
        ],
      }
    }
    case 'inventory': {
      const no = blocked('inventory')
      return {
        type,
        title,
        kpis: [],
        tables: [
          table(
            'low-stock',
            'Low stock now',
            [col('name', 'Ingredient'), col('stock', 'In stock', 'qty'), col('min_level', 'Minimum', 'qty'), col('unit', 'Unit')],
            r.inventory?.low_stock.map((i) => ({ name: i.name, stock: i.stock, min_level: i.min_level, unit: i.unit })) ?? null,
            no,
            'Nothing below its minimum.',
          ),
          table(
            'consumption',
            'Consumed in this period',
            [col('name', 'Ingredient'), col('qty', 'Consumed', 'qty'), col('unit', 'Unit')],
            r.inventory?.consumption.map((i) => ({ name: i.name, qty: i.qty, unit: i.unit })) ?? null,
            no,
            'No consumption recorded.',
          ),
        ],
      }
    }
    case 'payments': {
      const no = blocked('payments')
      return {
        type,
        title,
        kpis: [
          { label: 'Collected', value: no ? null : k.gross_collected, kind: 'money' },
          { label: 'Cash', value: no ? null : k.cash_collected, kind: 'money' },
        ],
        tables: [
          table(
            'by-payment-method',
            'Collected by payment method',
            [col('name', 'Method'), col('count', 'Payments', 'int'), col('amount', 'Amount', 'money')],
            r.by_payment_method?.map((m) => ({ name: m.name, count: m.count, amount: m.amount })) ?? null,
            no,
          ),
        ],
      }
    }
    case 'staff':
      return {
        type,
        title,
        kpis: [],
        tables: [
          table(
            'by-waiter',
            'Sales by staff',
            [col('name', 'Name'), col('orders', 'Orders', 'int'), col('sales', 'Sales', 'money')],
            r.by_waiter?.map((w) => ({ name: w.name ?? 'Unknown', orders: w.orders, sales: w.sales })) ?? null,
            blocked('staff'),
          ),
        ],
      }
    case 'items':
      return {
        type,
        title,
        kpis: [
          { label: 'Items sold', value: k.items_sold, kind: 'int' },
          { label: 'Before VAT', value: k.subtotal_total, kind: 'money' },
        ],
        tables: [
          table(
            'by-item',
            'Sales by item',
            [col('name', 'Item'), col('qty', 'Qty', 'int'), col('amount', 'Amount', 'money')],
            r.by_item?.map((i) => ({ name: i.name ?? '—', qty: i.qty, amount: i.amount })) ?? null,
            false,
          ),
          categoryTable(r),
        ],
      }
    case 'installments': {
      const no = blocked('installments') || r.installments === null
      const i = r.installments
      return {
        type,
        title,
        kpis: [
          { label: 'Vouchers issued', value: no ? null : (i?.issued_count ?? null), kind: 'int' },
          { label: 'Issued total', value: no ? null : (i?.issued_total ?? null), kind: 'money' },
          { label: 'Down payments', value: no ? null : (i?.down_total ?? null), kind: 'money' },
          { label: 'Collected', value: no ? null : (i?.collected_total ?? null), kind: 'money' },
          { label: 'Outstanding', value: no ? null : (i?.outstanding_total ?? null), kind: 'money' },
          { label: 'Overdue vouchers', value: no ? null : (i?.overdue_count ?? null), kind: 'int' },
        ],
        tables: [],
      }
    }
    case 'cancellations':
      return {
        type,
        title,
        kpis: [
          { label: 'Cancelled orders', value: r.cancellations?.count ?? null, kind: 'int' },
          { label: 'Cancelled amount', value: r.cancellations?.amount ?? null, kind: 'money' },
          { label: 'Payment reversals', value: r.reversals?.count ?? null, kind: 'int' },
          { label: 'Reversed amount', value: r.reversals?.amount ?? null, kind: 'money' },
        ],
        tables: [
          table(
            'cancellations',
            'Cancelled orders',
            [col('order_no', 'Order'), col('total', 'Total', 'money'), col('reason', 'Reason'), col('at', 'Cancelled at'), col('by', 'By')],
            r.cancellations?.items.map((c) => ({
              order_no: c.order_no,
              total: c.total,
              reason: c.reason ?? '—',
              at: formatInstant(c.cancelled_at, tz),
              by: c.by_name ?? '—',
            })) ?? null,
            false,
          ),
          table(
            'reversals',
            'Payment reversals',
            [col('receipt_no', 'Receipt'), col('amount', 'Amount', 'money'), col('method', 'Method'), col('at', 'Reversed at'), col('by', 'By')],
            r.reversals?.items.map((v) => ({
              receipt_no: v.receipt_no ?? '—',
              amount: v.amount,
              method: v.method ?? '—',
              at: formatInstant(v.created_at, tz),
              by: v.by_name ?? '—',
            })) ?? null,
            blocked('payments'),
          ),
        ],
      }
    case 'hourly':
      return {
        type,
        title,
        kpis: [{ label: 'Orders', value: k.order_count, kind: 'int' }],
        tables: [
          table(
            'by-hour',
            'Orders by hour',
            [col('hour', 'Hour'), col('ethiopian', 'Ethiopian time'), col('orders', 'Orders', 'int'), col('sales', 'Sales', 'money')],
            r.by_hour?.map((h) => ({
              hour: internationalHourLabel(h.hour),
              ethiopian: ethiopianHourLabel(h.hour),
              orders: h.orders,
              sales: h.sales,
            })) ?? null,
            false,
          ),
        ],
      }
  }
}
