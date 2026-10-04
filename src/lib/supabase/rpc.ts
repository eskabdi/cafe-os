import { z } from 'zod'
import { supabase } from './client'

// Hand-written typed wrappers: types.ts is still a stub (supabase gen types needs Docker). Every
// response is validated with zod so a schema drift fails loudly instead of leaking `any`.

export class RpcError extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.name = 'RpcError'
    this.code = code
  }
}

type RpcResult = PromiseLike<{ data: unknown; error: { message: string } | null }>

async function callRpc(fn: string, args?: Record<string, unknown>): Promise<unknown> {
  const client = supabase as unknown as { rpc: (fn: string, args?: Record<string, unknown>) => RpcResult }
  const { data, error } = await client.rpc(fn, args)
  // Server errors carry a stable machine code in `message` (rpc-conventions). Nothing else is surfaced.
  if (error) throw new RpcError(/^[a-z_]{3,48}$/.test(error.message) ? error.message : 'rpc_failed')
  return data
}

const tenantSchema = z
  .object({
    name: z.string(),
    // mirrors restaurants_branding_check / restaurants_branding_shape_check: whitelisted keys, hex colours,
    // tenant-scoped storage path only
    branding: z
      .object({
        logo_path: z
          .string()
          .regex(/^restaurants\/[0-9a-f-]{36}\/[A-Za-z0-9._/-]{1,200}$/)
          .refine((v) => !v.includes('..'))
          .nullable()
          .optional(),
        primary_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
        accent_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
      })
      .strict()
      .partial()
      .optional(),
  })
  .nullable()
export type ResolvedTenant = NonNullable<z.infer<typeof tenantSchema>>

/** Pre-auth slug resolver. Unknown, suspended and cancelled tenants are all null. */
export async function resolveTenantSlug(slug: string): Promise<ResolvedTenant | null> {
  return tenantSchema.parse(await callRpc('fn_resolve_tenant_slug', { p_slug: slug }))
}

const sessionContextSchema = z
  .object({
    user: z
      .object({
        id: z.string(),
        first_name: z.string(),
        middle_name: z.string().nullable().optional(),
        last_name: z.string().nullable().optional(),
        short_name: z.string().optional(),
        username: z.string(),
      })
      .optional(),
    restaurant: z
      .object({
        id: z.string(),
        name: z.string(),
        slug: z.string(),
        status: z.string(),
      })
      .passthrough()
      .optional(),
    role: z
      .object({
        id: z.string(),
        name: z.string(),
        system_key: z.string().nullable().optional(),
        is_active: z.boolean(),
      })
      .passthrough()
      .optional(),
    permissions: z.array(z.string()).default([]),
    station_ids: z.array(z.string()).default([]),
    tenant_writable: z.boolean().optional(),
    platform_role: z.string().optional(),
    // Forced PIN change / maker-checker (migrations 0023, 0024). Absent for platform-only identities. An unknown status
    // fails the parse (contextStatus 'error') instead of being guessed: guessing 'none' would hide the restriction screen.
    must_change_pin: z.boolean().optional(),
    pin_change_status: z.enum(['none', 'required', 'pending_approval']).optional(),
    pin_length: z.union([z.literal(4), z.literal(6)]).nullable().optional(),
  })
  .nullable()
export type SessionContext = NonNullable<z.infer<typeof sessionContextSchema>>

/** Server-derived identity (profile, role, permissions, station access, tenant status). Never from JWT claims. */
export async function getSessionContext(): Promise<SessionContext | null> {
  const parsed = sessionContextSchema.parse(await callRpc('fn_get_session_context'))
  if (parsed && !parsed.user && !parsed.platform_role) return null
  return parsed
}

/** Authoritative platform-admin check (RPC, not a client claim). */
export async function isPlatformSuperAdmin(): Promise<boolean> {
  return z.boolean().parse(await callRpc('is_platform_super_admin'))
}

// ── Kiosk devices (shared floor terminals; kiosk-terminals.md) ─────────────────────────────────────────────
const kioskSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  created_by: z.string().nullable().optional(),
  created_at: z.string(),
  last_seen_at: z.string().nullable().optional(),
  revoked_at: z.string().nullable().optional(),
})
export type KioskDevice = z.infer<typeof kioskSchema>

/** Metadata only: the server never returns a token or hash here. Needs kiosks.manage. */
export async function listKiosks(): Promise<KioskDevice[]> {
  return z.array(kioskSchema).parse(await callRpc('fn_list_kiosks'))
}

const registeredKioskSchema = z.object({ id: z.string().uuid(), name: z.string(), token: z.string().regex(/^[0-9a-f]{64}$/) })
export type RegisteredKiosk = z.infer<typeof registeredKioskSchema>

/** Registers a terminal. The raw `token` exists only in this response: show it once, never log or cache it. Needs step-up (mfa_required). */
export async function registerKiosk(name: string): Promise<RegisteredKiosk> {
  return registeredKioskSchema.parse(await callRpc('fn_register_kiosk', { p_name: name }))
}

/** Idempotent, audited, tenant-scoped. Takes effect on the device's next roster / sign-in call. */
export async function revokeKiosk(kioskId: string): Promise<void> {
  z.object({ revoked: z.literal(true) }).passthrough().parse(await callRpc('fn_revoke_kiosk', { p_kiosk_id: kioskId }))
}

// ── Forced PIN change approvals (maker-checker, migration 0024) ───────────────────────────────────────────────
const pendingPinChangeSchema = z.object({
  profile_id: z.string().uuid(),
  user_name: z.string().nullable(),
  role_label: z.string().nullable(),
  requested_at: z.string().nullable(),
})
export type PendingPinChange = z.infer<typeof pendingPinChangeSchema>

/** Staff of the caller's own tenant whose forced PIN change waits for approval. Needs users.manage (server-checked). */
export async function listPendingPinChanges(): Promise<PendingPinChange[]> {
  return z.array(pendingPinChangeSchema).parse(await callRpc('fn_list_pending_pin_changes'))
}

const pinDecisionSchema = z.object({ profile_id: z.string().uuid(), status: z.enum(['approved', 'rejected']) })
export type PinDecision = z.infer<typeof pinDecisionSchema>

/** users.manage + step-up (mfa_required). Unknown, foreign-tenant and no-longer-pending ids are all not_found. */
export async function approvePinChange(profileId: string): Promise<PinDecision> {
  return pinDecisionSchema.parse(await callRpc('fn_approve_pin_change', { p_profile_id: profileId }))
}

/** Same checks as approve; the subject must choose another PIN afterwards. */
export async function rejectPinChange(profileId: string): Promise<PinDecision> {
  return pinDecisionSchema.parse(await callRpc('fn_reject_pin_change', { p_profile_id: profileId }))
}

/** Own notifications only (unknown / foreign ids are not_found). Works while a PIN change is pending. */
export async function markNotificationRead(id: string): Promise<void> {
  z.object({ id: z.string() }).passthrough().parse(await callRpc('fn_mark_notification_read', { p_id: id }))
}
