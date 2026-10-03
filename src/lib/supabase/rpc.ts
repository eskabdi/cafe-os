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
    id: z.string().uuid(),
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
