import { FunctionsFetchError, FunctionsHttpError, FunctionsRelayError } from '@supabase/supabase-js'
import { z } from 'zod'
import { supabase } from './client'

/**
 * Client for the staff-roster Edge Function (registered kiosk devices only). The slug is derived from the hostname by the
 * caller and only ever a pre-auth resolver; the kiosk token is the credential. Any 401 is ONE outcome ('invalid_kiosk'):
 * unknown, revoked, wrong tenant and suspended tenant are indistinguishable by design.
 */
export interface RosterTile {
  id: string
  /** Short name (first + middle) exactly as the server returned it. */
  name: string
  /** Role label (a tenant-defined row; never branched on). */
  role: string
  /** Hex colour from the role row, or null. Re-validated here as defence in depth. */
  color: string | null
  /** Icon slug from the role row, or null. Mapped through an allowlist at render time. */
  icon: string | null
}

export type RosterFailure = 'invalid_kiosk' | 'rate_limited' | 'network' | 'server_error'
export type RosterResult = { ok: true; staff: RosterTile[] } | { ok: false; reason: RosterFailure }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Lenient per row: a malformed row is dropped rather than failing the whole terminal.
const tileSchema = z.object({
  id: z.string().regex(UUID),
  name: z.string().min(1).max(121),
  role: z.string().max(60),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().catch(null),
  icon: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/).nullable().catch(null),
})

export function parseRoster(data: unknown): RosterTile[] | null {
  if (typeof data !== 'object' || data === null || !Array.isArray((data as { staff?: unknown }).staff)) return null
  const out: RosterTile[] = []
  for (const row of (data as { staff: unknown[] }).staff) {
    const r = tileSchema.safeParse(row)
    if (r.success) out.push(r.data)
  }
  return out
}

export async function fetchStaffRoster(req: { restaurant_slug: string; kiosk_token: string }): Promise<RosterResult> {
  const { data, error } = await supabase.functions.invoke('staff-roster', { body: req })
  if (error) {
    if (error instanceof FunctionsHttpError) {
      const status = (error.context as { status?: number } | undefined)?.status ?? 500
      if (status === 401) return { ok: false, reason: 'invalid_kiosk' }
      if (status === 429) return { ok: false, reason: 'rate_limited' }
      return { ok: false, reason: 'server_error' }
    }
    if (error instanceof FunctionsFetchError || error instanceof FunctionsRelayError) return { ok: false, reason: 'network' }
    return { ok: false, reason: 'server_error' }
  }
  const staff = parseRoster(data)
  return staff ? { ok: true, staff } : { ok: false, reason: 'server_error' }
}
