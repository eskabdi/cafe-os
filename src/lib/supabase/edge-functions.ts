import { FunctionsFetchError, FunctionsHttpError, FunctionsRelayError } from '@supabase/supabase-js'
import { z } from 'zod'
import { supabase } from './client'
import { RpcError } from './rpc'
import { uuid } from './schemas'

// Typed wrappers for the Phase 3B Edge Functions used by the portals: tenant-admin-invite, staff-create, staff-pin-reset.
// The caller is identified by its access token only (explicit Bearer header). No tenant id is sent where the server derives it:
// only a Super Admin names a restaurant_id (the target tenant) when inviting. Failures are thrown as RpcError with the
// function's machine code (`{ "error": "<code>" }`), so the same error copy and the step-up runner (mfa_required) apply.

export const EDGE_TIMEOUT_MS = 20_000
const MACHINE_CODE = /^[a-z_]{3,48}$/

async function errorCodeOf(res: Response | undefined): Promise<string> {
  if (!res) return 'server_error'
  if (res.status === 429) return 'try_later'
  try {
    const body: unknown = await res.clone().json()
    const code = typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined
    return typeof code === 'string' && MACHINE_CODE.test(code) ? code : 'server_error'
  } catch {
    return 'server_error'
  }
}

async function accessToken(): Promise<string> {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) throw new RpcError('not_authenticated')
  return token
}

/** POSTs `body` to an Edge Function as the signed-in user; returns the JSON body or throws RpcError(code). */
export async function invokeEdge(name: string, body: Record<string, unknown>, timeoutMs = EDGE_TIMEOUT_MS): Promise<unknown> {
  const token = await accessToken()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let data: unknown
  let error: unknown
  try {
    ;({ data, error } = await supabase.functions.invoke(name, {
      body,
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    }))
  } catch {
    throw new RpcError('network')
  } finally {
    clearTimeout(timer)
  }
  if (error) {
    if (error instanceof FunctionsHttpError) throw new RpcError(await errorCodeOf(error.context as Response | undefined))
    if (error instanceof FunctionsFetchError || error instanceof FunctionsRelayError) throw new RpcError('network')
    throw new RpcError('server_error')
  }
  return data
}

const trimOrNull = (v: string | null | undefined) => {
  const t = (v ?? '').trim()
  return t ? t : null
}

// ── tenant-admin-invite ────────────────────────────────────────────────────────────────────────────────────────────────
export interface InviteTenantAdminInput {
  /** Super Admin only: the target tenant. A tenant_admin omits it (tenant from identity). */
  restaurantId?: string
  email: string
  firstName: string
  middleName?: string | null
  lastName?: string | null
  username: string
}

const invitedSchema = z.object({ invitation_id: uuid, expires_at: z.string() })

export async function inviteTenantAdmin(i: InviteTenantAdminInput): Promise<z.infer<typeof invitedSchema>> {
  const body: Record<string, unknown> = {
    action: 'invite',
    email: i.email.trim().toLowerCase(),
    first_name: i.firstName.trim(),
    username: i.username.trim().toLowerCase(),
  }
  if (i.restaurantId) body.restaurant_id = i.restaurantId
  const middle = trimOrNull(i.middleName)
  const last = trimOrNull(i.lastName)
  if (middle) body.middle_name = middle
  if (last) body.last_name = last
  return invitedSchema.parse(await invokeEdge('tenant-admin-invite', body))
}

export async function resendTenantAdminInvitation(invitationId: string): Promise<void> {
  z.object({ invitation_id: uuid }).passthrough().parse(
    await invokeEdge('tenant-admin-invite', { action: 'resend', invitation_id: invitationId }),
  )
}

export async function revokeTenantAdminInvitation(invitationId: string): Promise<void> {
  z.object({ invitation_id: uuid }).passthrough().parse(
    await invokeEdge('tenant-admin-invite', { action: 'revoke', invitation_id: invitationId }),
  )
}

// ── staff-create / staff-pin-reset ─────────────────────────────────────────────────────────────────────────────────────
export interface CreateStaffInput {
  username: string
  firstName: string
  middleName?: string | null
  lastName?: string | null
  roleId: string
  pin: string
}

/** Creates a PIN staff member. The PIN is sent once over TLS to the function and never stored in client state by callers. */
export async function createStaff(i: CreateStaffInput): Promise<{ profile_id: string }> {
  const body: Record<string, unknown> = {
    username: i.username.trim().toLowerCase(),
    first_name: i.firstName.trim(),
    role_id: i.roleId,
    pin: i.pin,
  }
  const middle = trimOrNull(i.middleName)
  const last = trimOrNull(i.lastName)
  if (middle) body.middle_name = middle
  if (last) body.last_name = last
  return z.object({ profile_id: uuid }).parse(await invokeEdge('staff-create', body))
}

export async function resetStaffPin(profileId: string, pin: string): Promise<void> {
  z.object({ profile_id: uuid, pin_reset: z.literal(true) }).parse(
    await invokeEdge('staff-pin-reset', { profile_id: profileId, pin }),
  )
}

// ── reachability (Platform Admin Portal, System health) ───────────────────────────────────────────────────────────────
/** The Edge Functions the portals depend on. */
export const EDGE_FUNCTIONS = [
  'pin-login',
  'pin-change',
  'staff-create',
  'staff-roster',
  'staff-pin-reset',
  'tenant-admin-invite',
  'tenant-logo',
] as const

/**
 * A CORS preflight (OPTIONS, no credentials, no body) to each function: any HTTP answer below 500 means the function is
 * deployed and running; a network error, a timeout or a 5xx means it is not. Nothing is invoked.
 */
export async function pingEdgeFunctions(timeoutMs = 5000): Promise<Array<{ name: string; reachable: boolean }>> {
  const base = String(import.meta.env.VITE_SUPABASE_URL ?? '').replace(/\/+$/, '')
  return Promise.all(
    EDGE_FUNCTIONS.map(async (name) => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const res = await fetch(`${base}/functions/v1/${name}`, { method: 'OPTIONS', signal: controller.signal, credentials: 'omit' })
        return { name, reachable: res.status < 500 }
      } catch {
        return { name, reachable: false }
      } finally {
        clearTimeout(timer)
      }
    }),
  )
}
