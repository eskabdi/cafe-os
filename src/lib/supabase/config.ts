import { z } from 'zod'
import { supabase } from './client'
import { COUNTED_LIST_DETAIL, RpcError, callRpc } from './rpc'
import { rowColor, rowIcon, uuid } from './schemas'

// Dynamic configuration (Phase 10). Rows of the tenant's own domains, written directly under RLS (config.manage; tables.manage
// for tables) and row-audited; the database guards deactivation (in_use + the blocking dependency) and fn_delete_config_row
// explains why a delete is refused. A DOMAIN is one of a closed list of table identifiers; no row is ever known by its name, and
// colour / icon live on the row.

export const CONFIG_DOMAINS = [
  'stations',
  'categories',
  'payment_methods',
  'table_areas',
  'expense_categories',
  'tables',
] as const
export type ConfigDomain = (typeof CONFIG_DOMAINS)[number]

type Flag = 'affects_cash_drawer' | 'requires_reference'

export interface DomainSpec {
  domain: ConfigDomain
  title: string
  singular: string
  /** Path below `/r/<slug>/` (same as the nav entry). */
  segment: string
  /** Server permission for writes (RLS + fn_delete_config_row); the route and nav use the same code. */
  permission: 'config.manage' | 'tables.manage'
  /** Rows carry description / colour / icon (the five configuration domains; tables do not). */
  presentation: boolean
  /** Extra boolean columns editable on this domain's rows. */
  flags: ReadonlyArray<{ key: Flag; label: string; hint: string }>
  /** Rows belong to a parent row of another domain (tables -> table areas). */
  parent?: { column: 'table_area_id'; domain: 'table_areas'; label: string }
}

export const DOMAIN_SPECS: Readonly<Record<ConfigDomain, DomainSpec>> = {
  stations: {
    domain: 'stations',
    title: 'Stations',
    singular: 'station',
    segment: 'settings/stations',
    permission: 'config.manage',
    presentation: true,
    flags: [],
  },
  categories: {
    domain: 'categories',
    title: 'Menu categories',
    singular: 'category',
    segment: 'settings/categories',
    permission: 'config.manage',
    presentation: true,
    flags: [],
  },
  payment_methods: {
    domain: 'payment_methods',
    title: 'Payment methods',
    singular: 'payment method',
    segment: 'settings/payment-methods',
    permission: 'config.manage',
    presentation: true,
    flags: [
      {
        key: 'affects_cash_drawer',
        label: 'Goes into the cash drawer',
        hint: 'Counted in expected cash at day close; the cashier sees a change preview.',
      },
      { key: 'requires_reference', label: 'Needs a reference', hint: 'The cashier must enter a transaction or slip number.' },
    ],
  },
  table_areas: {
    domain: 'table_areas',
    title: 'Table areas',
    singular: 'table area',
    segment: 'settings/table-areas',
    permission: 'config.manage',
    presentation: true,
    flags: [],
  },
  expense_categories: {
    domain: 'expense_categories',
    title: 'Expense categories',
    singular: 'expense category',
    segment: 'settings/expense-categories',
    permission: 'config.manage',
    presentation: true,
    flags: [],
  },
  tables: {
    domain: 'tables',
    title: 'Tables',
    singular: 'table',
    segment: 'settings/tables',
    permission: 'tables.manage',
    presentation: false,
    flags: [],
    parent: { column: 'table_area_id', domain: 'table_areas', label: 'Area' },
  },
}

/** One row of any configuration domain, normalised: tables' `label` is shown as `name`. */
export interface ConfigRow {
  id: string
  name: string
  description: string | null
  color: string | null
  icon: string | null
  sort_order: number
  is_active: boolean
  affects_cash_drawer?: boolean
  requires_reference?: boolean
  table_area_id?: string
  capacity?: number
}

const baseRow = z.object({
  id: uuid,
  description: z.string().max(300).nullable().optional(),
  color: rowColor,
  icon: rowIcon,
  sort_order: z.number().int(),
  is_active: z.boolean(),
})
const configRowSchema = baseRow.extend({
  name: z.string().min(1).max(60),
  affects_cash_drawer: z.boolean().optional(),
  requires_reference: z.boolean().optional(),
})
const tableRowSchema = baseRow.extend({
  label: z.string().min(1).max(30),
  table_area_id: uuid,
  capacity: z.number().int().min(1).max(100),
})

export const configKey = (rid: string, domain: ConfigDomain) => ['config', rid, domain] as const

function columns(d: ConfigDomain): string {
  if (d === 'tables') return 'id,label,table_area_id,capacity,sort_order,is_active'
  if (d === 'payment_methods') return 'id,name,description,color,icon,sort_order,is_active,affects_cash_drawer,requires_reference'
  return 'id,name,description,color,icon,sort_order,is_active'
}

/** Every row of the domain in the caller's tenant (RLS-scoped; no restaurant filter is sent). Invalid rows are dropped. */
export async function fetchConfigRows(domain: ConfigDomain): Promise<ConfigRow[]> {
  const client = supabase as unknown as {
    from: (t: string) => {
      select: (c: string) => { order: (c: string, o: { ascending: boolean }) => PromiseLike<{ data: unknown; error: unknown }> }
    }
  }
  const { data, error } = await client.from(domain).select(columns(domain)).order('sort_order', { ascending: true })
  if (error) throw new Error('config_unavailable')
  const out: ConfigRow[] = []
  for (const raw of Array.isArray(data) ? data : []) {
    if (domain === 'tables') {
      const p = tableRowSchema.safeParse(raw)
      if (p.success)
        out.push({ ...p.data, name: p.data.label, description: null, color: null, icon: null })
    } else {
      const p = configRowSchema.safeParse(raw)
      if (p.success) out.push({ ...p.data, description: p.data.description ?? null, color: p.data.color ?? null, icon: p.data.icon ?? null })
    }
  }
  return out
}

export interface ConfigInput {
  name: string
  description: string | null
  color: string | null
  icon: string | null
  sort_order: number
  affects_cash_drawer?: boolean
  requires_reference?: boolean
  table_area_id?: string
  capacity?: number
}

/** The columns a domain's row accepts (the column grants allow exactly these). */
function toColumns(domain: ConfigDomain, input: Partial<ConfigInput> & { is_active?: boolean }): Record<string, unknown> {
  const spec = DOMAIN_SPECS[domain]
  const out: Record<string, unknown> = {}
  if (input.name !== undefined) out[domain === 'tables' ? 'label' : 'name'] = input.name
  if (input.sort_order !== undefined) out.sort_order = input.sort_order
  if (input.is_active !== undefined) out.is_active = input.is_active
  if (spec.presentation) {
    if (input.description !== undefined) out.description = input.description
    if (input.color !== undefined) out.color = input.color
    if (input.icon !== undefined) out.icon = input.icon
  }
  for (const f of spec.flags) if (input[f.key] !== undefined) out[f.key] = input[f.key]
  if (spec.parent && input.table_area_id !== undefined) out.table_area_id = input.table_area_id
  if (domain === 'tables' && input.capacity !== undefined) out.capacity = input.capacity
  return out
}

/** A PostgREST failure as a stable code (+ a safe counted detail for in_use); never the raw message. */
export function configError(error: { code?: string; message?: string; details?: string | null }): RpcError {
  if (error.code === '23505') return new RpcError('duplicate_name')
  if (error.code === '23503') return new RpcError('in_use')
  const safe = /^[a-z_]{3,48}$/
  const counted = /^[a-z_]{3,32}:[0-9]{1,9}$/
  if (error.message && safe.test(error.message)) {
    const d = error.details
    const detail = typeof d === 'string' && (safe.test(d) || counted.test(d) || COUNTED_LIST_DETAIL.test(d)) ? d : undefined
    return new RpcError(error.message, detail)
  }
  if (error.code === '42501') return new RpcError('permission_denied')
  return new RpcError('config_failed')
}

type WriteResult = PromiseLike<{ error: { code?: string; message?: string; details?: string | null } | null; count?: number | null }>
interface WriteClient {
  from: (t: string) => {
    insert: (row: Record<string, unknown>) => WriteResult
    update: (row: Record<string, unknown>, o: { count: 'exact' }) => { eq: (c: string, v: string) => WriteResult }
  }
}

export async function createConfigRow(domain: ConfigDomain, restaurantId: string, input: ConfigInput): Promise<void> {
  const client = supabase as unknown as WriteClient
  // restaurant_id is the caller's own (RLS with check = current_restaurant_id()); the server decides, this only satisfies the column
  const { error } = await client.from(domain).insert({ ...toColumns(domain, input), restaurant_id: restaurantId })
  if (error) throw configError(error)
}

export async function updateConfigRow(
  domain: ConfigDomain,
  id: string,
  patch: Partial<ConfigInput> & { is_active?: boolean },
): Promise<void> {
  const client = supabase as unknown as WriteClient
  const { error, count } = await client.from(domain).update(toColumns(domain, patch), { count: 'exact' }).eq('id', id)
  if (error) throw configError(error)
  // RLS hides rows the caller may not change: zero rows is a refusal, not a success
  if (count === 0) throw new RpcError('permission_denied')
}

export async function deleteConfigRow(domain: ConfigDomain, id: string): Promise<void> {
  await callRpc('fn_delete_config_row', { p_domain: domain, p_id: id })
}

const usageSchema = z.record(z.string().regex(/^[a-z_]{2,40}$/), z.number().int().min(0))
export type ConfigUsage = z.infer<typeof usageSchema>

/** Every reference to the row (active or historical) as counts; keys starting with `active_` are the live subset. */
export async function fetchConfigUsage(domain: ConfigDomain, id: string): Promise<ConfigUsage> {
  return usageSchema.parse(await callRpc('fn_config_usage', { p_domain: domain, p_id: id }))
}

const USAGE_LABEL: Readonly<Record<string, string>> = {
  menu_items: 'menu items',
  ingredients: 'ingredients',
  order_items: 'order lines',
  open_order_items: 'open tickets',
  stock_movements: 'stock movements',
  role_access: 'role station grants',
  payments: 'payments',
  expenses: 'expenses',
  vouchers: 'vouchers',
  tables: 'tables',
  orders: 'orders',
  table_sessions: 'table sessions',
  qr_credentials: 'QR codes',
}

/** The blocking references of a usage record (historical and live), e.g. [['menu_items', 3]]. `active_*` keys are skipped. */
export function blockingUsage(usage: ConfigUsage): Array<[string, number]> {
  return Object.entries(usage).filter(([k, n]) => !k.startsWith('active_') && n > 0)
}

/** "3 menu items, 2 ingredients" from a server detail "menu_items:3,ingredients:2" (unknown keys are skipped). */
export function describeUsage(detail: string | undefined): string {
  if (!detail) return 'other records'
  if (detail === 'last_active_method') return 'the cashier (it is the only active payment method)'
  const parts = detail.split(',').flatMap((p) => {
    const [k, n] = p.split(':')
    const label = k ? USAGE_LABEL[k] : undefined
    return label && n && /^\d+$/.test(n) ? [`${n} ${label}`] : []
  })
  return parts.length ? parts.join(', ') : 'other records'
}

/** Same as describeUsage for a usage record. */
export function describeUsageRecord(usage: ConfigUsage): string {
  return describeUsage(blockingUsage(usage).map(([k, n]) => `${k}:${n}`).join(',') || undefined)
}
