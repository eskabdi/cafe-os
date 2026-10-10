import { z } from 'zod'
import { callRpc } from './rpc'
import { numericValue, uuid } from './schemas'

// Platform Admin Portal wrappers (migration 0030, docs/api/portals.md). Every RPC is guarded by fn_platform_guard on the server
// (active platform_super_admin + aal2 + live factor); these wrappers only shape arguments and zod-parse the answers. Platform
// RPCs act on a NAMED tenant (p_restaurant_id is a target, not the caller's identity); tenant RPCs never take one.

export const TENANT_STATUSES = ['trialing', 'active', 'past_due', 'suspended', 'cancelled'] as const
export type TenantStatus = (typeof TENANT_STATUSES)[number]
export const BILLING_STATUSES = ['trialing', 'active', 'past_due'] as const
export type BillingStatus = (typeof BILLING_STATUSES)[number]
export const INVOICE_STATUSES = ['pending', 'paid', 'overdue', 'void'] as const
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number]
/** The platform's OWN billing channels (platform_invoices.method CHECK), not a tenant payment-method domain row. */
export const PLATFORM_BILLING_CHANNELS = ['telebirr', 'chapa', 'manual_bank_transfer'] as const
export type PlatformBillingChannel = (typeof PLATFORM_BILLING_CHANNELS)[number]

const ts = z.string()
const nts = z.string().nullable()
const count = numericValue
const ncount = numericValue.nullable()
const tenantStatus = z.enum(TENANT_STATUSES)

// ── tenants ────────────────────────────────────────────────────────────────────────────────────────────────────────────
const tenantListItemSchema = z.object({
  id: uuid,
  name: z.string(),
  slug: z.string(),
  status: tenantStatus,
  created_at: ts,
  suspended_at: nts.optional(),
  cancelled_at: nts.optional(),
  /** Optional aggregate (not yet returned by every backend version); the overview uses it when present. */
  over_quota: z.array(z.string()).optional(),
  plan: z.object({ id: uuid, name: z.string() }).nullable(),
  subscription_status: z.string().nullable().optional(),
  trial_ends_at: nts.optional(),
  current_period_end: nts.optional(),
})
export type TenantListItem = z.infer<typeof tenantListItemSchema>

const tenantPageSchema = z.object({
  total: count,
  limit: count,
  offset: count,
  items: z.array(tenantListItemSchema),
})
export type TenantPage = z.infer<typeof tenantPageSchema>

export interface TenantListFilter {
  search?: string
  status?: TenantStatus | ''
  planId?: string | ''
  limit?: number
  offset?: number
}

export const platformKeys = {
  all: ['platform'] as const,
  tenants: (f: TenantListFilter) => ['platform', 'tenants', f] as const,
  tenant: (id: string) => ['platform', 'tenant', id] as const,
  plans: ['platform', 'plans'] as const,
  invoices: (f: object) => ['platform', 'invoices', f] as const,
  health: ['platform', 'health'] as const,
  backups: ['platform', 'backups'] as const,
  audit: (f: object) => ['platform', 'audit', f] as const,
  admins: ['platform', 'admins'] as const,
}

export async function listTenants(f: TenantListFilter): Promise<TenantPage> {
  return tenantPageSchema.parse(
    await callRpc('fn_platform_list_tenants', {
      p_search: f.search?.trim() ? f.search.trim() : null,
      p_status: f.status ? f.status : null,
      p_plan_id: f.planId ? f.planId : null,
      p_limit: f.limit ?? 25,
      p_offset: f.offset ?? 0,
    }),
  )
}

const usageSchema = z.record(z.string(), z.unknown())
const invitationSchema = z.object({
  id: uuid,
  email: z.string(),
  status: z.enum(['pending', 'accepted', 'revoked', 'expired']),
  state: z.enum(['pending', 'accepted', 'revoked', 'expired']),
  invited_by_type: z.enum(['platform_admin', 'tenant_admin']),
  expires_at: ts,
  send_count: count,
  last_sent_at: nts,
  accepted_at: nts,
  revoked_at: nts,
  created_at: ts,
  first_name: z.string().optional(),
  middle_name: z.string().nullable().optional(),
  last_name: z.string().nullable().optional(),
  username: z.string().optional(),
})
export type Invitation = z.infer<typeof invitationSchema>

const tenantDetailSchema = z.object({
  id: uuid,
  name: z.string(),
  slug: z.string(),
  status: tenantStatus,
  custom_domain: nts.optional(),
  timezone: z.string(),
  phone: nts.optional(),
  address: nts.optional(),
  tin: nts.optional(),
  onboarded_at: nts.optional(),
  suspended_at: nts.optional(),
  suspension_reason: nts.optional(),
  cancelled_at: nts.optional(),
  created_at: ts,
  updated_at: ts,
  subscription: z
    .object({
      id: uuid,
      status: z.string(),
      trial_ends_at: nts,
      current_period_start: nts,
      current_period_end: nts,
      cancel_at_period_end: z.boolean().nullable().optional(),
      plan: z.object({ id: uuid, name: z.string(), price_etb_monthly: numericValue, is_active: z.boolean() }),
    })
    .nullable(),
  usage: usageSchema,
  limits: usageSchema,
  over_quota: z.array(z.string()),
  invitations: z.array(invitationSchema),
  recent_invoices: z.array(
    z.object({
      id: uuid,
      amount: numericValue,
      period_start: z.string(),
      period_end: z.string(),
      status: z.enum(INVOICE_STATUSES),
      paid_at: nts,
      created_at: ts,
    }),
  ),
})
export type TenantDetail = z.infer<typeof tenantDetailSchema>

export async function getTenant(id: string): Promise<TenantDetail> {
  return tenantDetailSchema.parse(await callRpc('fn_platform_get_tenant', { p_restaurant_id: id }))
}

export interface CreateTenantInput {
  name: string
  slug: string
  planId: string
  trialDays: number
  timezone: string
}
const createdTenantSchema = z.object({ restaurant_id: uuid, slug: z.string(), status: tenantStatus, day_session_id: uuid.optional() })
export type CreatedTenant = z.infer<typeof createdTenantSchema>

export async function createTenant(i: CreateTenantInput): Promise<CreatedTenant> {
  return createdTenantSchema.parse(
    await callRpc('fn_platform_create_tenant', {
      p_name: i.name.trim(),
      p_slug: i.slug.trim().toLowerCase(),
      p_plan_id: i.planId,
      p_trial_days: i.trialDays,
      p_timezone: i.timezone,
    }),
  )
}

const changeSchema = z.object({ restaurant_id: uuid, status: z.string(), changed: z.boolean() })
export type TenantStateChange = z.infer<typeof changeSchema>

export async function changeTenantPlan(
  restaurantId: string,
  planId: string,
  reason: string,
): Promise<{ changed: boolean; over_quota: string[] }> {
  return z
    .object({ restaurant_id: uuid, plan_id: uuid, changed: z.boolean(), over_quota: z.array(z.string()).nullable().transform((v) => v ?? []) })
    .parse(await callRpc('fn_platform_change_plan', { p_restaurant_id: restaurantId, p_plan_id: planId, p_reason: reason.trim() }))
}

export async function setBillingStatus(restaurantId: string, status: BillingStatus, reason: string): Promise<TenantStateChange> {
  return changeSchema.parse(
    await callRpc('fn_platform_set_billing_status', { p_restaurant_id: restaurantId, p_status: status, p_reason: reason.trim() }),
  )
}

export async function suspendTenant(restaurantId: string, reason: string): Promise<TenantStateChange> {
  return changeSchema.parse(await callRpc('fn_suspend_tenant', { p_restaurant_id: restaurantId, p_reason: reason.trim() }))
}

export async function reactivateTenant(restaurantId: string, reason: string): Promise<TenantStateChange> {
  return changeSchema.parse(await callRpc('fn_reactivate_tenant', { p_restaurant_id: restaurantId, p_reason: reason.trim() }))
}

export async function cancelTenant(restaurantId: string, reason: string, confirmSlug: string): Promise<TenantStateChange> {
  return changeSchema.parse(
    await callRpc('fn_platform_cancel_tenant', {
      p_restaurant_id: restaurantId,
      p_reason: reason.trim(),
      p_confirm_slug: confirmSlug.trim(),
    }),
  )
}

/** Restores a cancelled tenant within the 1-year retention window (owner decision 2026-10-08); slug confirmation required. */
export async function restoreTenant(restaurantId: string, reason: string, confirmSlug: string): Promise<TenantStateChange> {
  return changeSchema.parse(
    await callRpc('fn_platform_restore_tenant', {
      p_restaurant_id: restaurantId,
      p_reason: reason.trim(),
      p_confirm_slug: confirmSlug.trim(),
    }),
  )
}

/** Cancelled tenants keep their data for 1 year (then purged by the ops job); restore is possible within that window. */
export const RETENTION_DAYS = 365

/** Restore deadline of a cancelled tenant, or null. */
export function restoreDeadline(cancelledAt: string | null | undefined): Date | null {
  if (!cancelledAt) return null
  const d = new Date(cancelledAt)
  if (Number.isNaN(d.getTime())) return null
  d.setFullYear(d.getFullYear() + 1)
  return d
}

// ── plans ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
const featuresSchema = z.record(z.string(), z.union([z.boolean(), z.number(), z.string()])).catch({})
const planSchema = z.object({
  id: uuid,
  name: z.string(),
  description: nts.optional(),
  price_etb_monthly: numericValue,
  max_staff: ncount.optional(),
  max_menu_items: ncount.optional(),
  max_stations: ncount.optional(),
  max_kiosks: ncount.optional(),
  max_storage_bytes: ncount.optional(),
  max_orders_per_month: ncount.optional(),
  features: featuresSchema.nullable().optional(),
  is_active: z.boolean(),
  sort_order: count,
  subscriber_count: count,
  created_at: ts.optional(),
  updated_at: ts.optional(),
})
export type Plan = z.infer<typeof planSchema>

export const PLAN_LIMIT_KEYS = [
  'max_staff',
  'max_menu_items',
  'max_stations',
  'max_kiosks',
  'max_orders_per_month',
  'max_storage_bytes',
] as const
export type PlanLimitKey = (typeof PLAN_LIMIT_KEYS)[number]

export interface PlanInput {
  name: string
  description: string | null
  price_etb_monthly: number
  max_staff: number | null
  max_menu_items: number | null
  max_stations: number | null
  max_kiosks: number | null
  max_orders_per_month: number | null
  max_storage_bytes: number | null
  features: Record<string, boolean | number | string>
  sort_order: number
}

export async function listPlans(): Promise<Plan[]> {
  return z.array(planSchema).parse(await callRpc('fn_platform_list_plans'))
}

export async function createPlan(p: PlanInput): Promise<Plan> {
  return planSchema.parse(await callRpc('fn_platform_create_plan', { p_plan: p }))
}

export async function updatePlan(planId: string, patch: Partial<PlanInput>): Promise<Plan> {
  return planSchema.parse(await callRpc('fn_platform_update_plan', { p_plan_id: planId, p_patch: patch }))
}

export async function setPlanActive(planId: string, active: boolean): Promise<Plan> {
  return planSchema.parse(await callRpc('fn_platform_set_plan_active', { p_plan_id: planId, p_active: active }))
}

// ── invoices ───────────────────────────────────────────────────────────────────────────────────────────────────────────
const invoiceSchema = z.object({
  id: uuid,
  restaurant: z.object({ id: uuid, name: z.string(), slug: z.string() }),
  subscription_id: uuid.nullable().optional(),
  amount: numericValue,
  period_start: z.string(),
  period_end: z.string(),
  status: z.enum(INVOICE_STATUSES),
  method: z.string().nullable().optional(),
  reference: nts.optional(),
  paid_at: nts.optional(),
  created_at: ts,
  updated_at: ts.optional(),
})
export type Invoice = z.infer<typeof invoiceSchema>

/** Keyset cursor: the last row's (created_at, id). */
export interface Cursor {
  before: string
  beforeId: string
}

export interface InvoiceFilter {
  restaurantId?: string
  status?: InvoiceStatus | ''
}

export async function listInvoices(f: InvoiceFilter, cursor: Cursor | null, limit = 50): Promise<Invoice[]> {
  return z.array(invoiceSchema).parse(
    await callRpc('fn_platform_list_invoices', {
      p_restaurant_id: f.restaurantId || null,
      p_status: f.status || null,
      p_limit: limit,
      p_before: cursor?.before ?? null,
      p_before_id: cursor?.beforeId ?? null,
    }),
  )
}

export async function createInvoice(i: {
  restaurantId: string
  amount: number
  periodStart: string
  periodEnd: string
  reference: string | null
}): Promise<Invoice> {
  return invoiceSchema.parse(
    await callRpc('fn_platform_create_invoice', {
      p_restaurant_id: i.restaurantId,
      p_amount: i.amount,
      p_period_start: i.periodStart,
      p_period_end: i.periodEnd,
      p_reference: i.reference,
    }),
  )
}

export async function setInvoiceStatus(
  invoiceId: string,
  status: Exclude<InvoiceStatus, 'pending'>,
  method: PlatformBillingChannel | null,
  reference: string | null,
): Promise<Invoice> {
  return invoiceSchema.parse(
    await callRpc('fn_platform_set_invoice_status', {
      p_invoice_id: invoiceId,
      p_status: status,
      p_method: status === 'paid' ? method : null,
      p_reference: reference,
    }),
  )
}

// ── system health + backups ───────────────────────────────────────────────────────────────────────────────────────────
const backupRunSchema = z.object({
  id: uuid,
  kind: z.string(),
  status: z.enum(['running', 'succeeded', 'failed']),
  started_at: ts,
  finished_at: nts,
  size_bytes: ncount.optional(),
  location: nts.optional(),
  checksum_sha256: nts.optional(),
  error_code: nts.optional(),
  note: nts.optional(),
})
export type BackupRun = z.infer<typeof backupRunSchema>

const healthSchema = z.object({
  checked_at: ts,
  database: z.object({
    reachable: z.boolean(),
    server_version: z.string(),
    size_bytes: count,
    started_at: ts,
    connections: count,
    max_connections: count,
  }),
  migrations: z.object({ latest: z.string().nullable(), count: ncount, source: z.string() }),
  largest_tables: z.array(z.object({ table: z.string(), total_bytes: count, estimated_rows: count })),
  storage: z.array(z.object({ bucket: z.string(), objects: count, bytes: count })),
  tenants: z.object({ total: count, by_status: z.record(z.string(), count) }),
  counters: z.object({
    tenant_audit_events_24h: count,
    platform_audit_events_24h: count,
    pin_lockouts_active: count,
    pin_changes_pending_approval: count,
    invitations_pending: count,
    invitations_expired: count,
    backup_failures_7d: count,
  }),
  backups: z.object({
    last_success_at: nts,
    last_success_age_hours: ncount,
    stale: z.boolean(),
    last_run: z
      .object({ kind: z.string(), status: z.string(), started_at: ts, finished_at: nts, error_code: nts })
      .nullable(),
  }),
})
export type SystemHealth = z.infer<typeof healthSchema>

export async function getSystemHealth(): Promise<SystemHealth> {
  return healthSchema.parse(await callRpc('fn_platform_system_health'))
}

export async function listBackupRuns(cursor: Cursor | null, limit = 50): Promise<BackupRun[]> {
  return z.array(backupRunSchema).parse(
    await callRpc('fn_platform_list_backup_runs', {
      p_limit: limit,
      p_before: cursor?.before ?? null,
      p_before_id: cursor?.beforeId ?? null,
    }),
  )
}

// ── audit + Super Admin accounts ──────────────────────────────────────────────────────────────────────────────────────
const auditEntrySchema = z.object({
  id: uuid,
  created_at: ts,
  action: z.string(),
  detail: z.unknown().optional(),
  actor: z.object({ id: uuid, full_name: z.string() }).nullable(),
  restaurant: z.object({ id: uuid, name: z.string(), slug: z.string() }).nullable(),
})
export type AuditEntry = z.infer<typeof auditEntrySchema>

export interface AuditFilter {
  restaurantId?: string
  actionPrefix?: string
  adminId?: string
}

export async function listAuditLog(f: AuditFilter, cursor: Cursor | null, limit = 50): Promise<AuditEntry[]> {
  return z.array(auditEntrySchema).parse(
    await callRpc('fn_platform_list_audit_log', {
      p_limit: limit,
      p_before: cursor?.before ?? null,
      p_before_id: cursor?.beforeId ?? null,
      p_restaurant_id: f.restaurantId || null,
      p_action_prefix: f.actionPrefix?.trim() || null,
      p_admin_id: f.adminId || null,
    }),
  )
}

const adminSchema = z.object({
  id: uuid,
  full_name: z.string(),
  role: z.string(),
  is_active: z.boolean(),
  email: z.string().nullable(),
  mfa_enrolled: z.boolean(),
  is_self: z.boolean(),
  created_at: ts,
  updated_at: ts.optional(),
})
export type PlatformAdmin = z.infer<typeof adminSchema>

export async function listAdmins(): Promise<PlatformAdmin[]> {
  return z.array(adminSchema).parse(await callRpc('fn_platform_list_admins'))
}

export async function setAdminActive(adminId: string, active: boolean, reason: string): Promise<{ changed: boolean }> {
  return z
    .object({ id: uuid, is_active: z.boolean(), changed: z.boolean() })
    .parse(await callRpc('fn_platform_set_admin_active', { p_admin_id: adminId, p_active: active, p_reason: reason.trim() }))
}

/** Next keyset cursor from the last row of a page (null when the page was not full: no more rows). */
export function nextCursor<T extends { id: string }>(rows: readonly T[], limit: number, at: (row: T) => string): Cursor | null {
  if (rows.length < limit) return null
  const last = rows[rows.length - 1]
  return last ? { before: at(last), beforeId: last.id } : null
}
