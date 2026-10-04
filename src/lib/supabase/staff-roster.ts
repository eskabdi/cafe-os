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
/** Thrown by query functions so react-query keeps the last good roster when a refetch fails. */
export class RosterError extends Error {
  readonly reason: RosterFailure
  constructor(reason: RosterFailure) {
    super(reason)
    this.name = 'RosterError'
    this.reason = reason
  }
}
/** pinPadIdleSeconds: the tenant's kiosk PIN-pad idle timer (migration 0025), or null when the response has none (consumers clamp
 * and fall back to 60 s via pinPadIdleMs). */
export type RosterResult =
  | { ok: true; staff: RosterTile[]; pinPadIdleSeconds: number | null }
  | { ok: false; reason: RosterFailure }

/**
 * Display text from the server is untrusted: strip control characters (C0/C1, line/paragraph separators), bidi
 * embedding/override/isolate marks and zero-width characters, then collapse whitespace. React escapes the result.
 */
export function cleanDisplayText(value: string): string {
  return value
    // eslint-disable-next-line no-control-regex -- stripping control characters is the purpose
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Lenient per row: a malformed row is dropped rather than failing the whole terminal.
const tileSchema = z.object({
  id: z.string().regex(UUID),
  name: z.string().max(240).transform(cleanDisplayText).pipe(z.string().min(1).max(121)),
  role: z.string().max(120).transform(cleanDisplayText).pipe(z.string().max(60)),
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

/**
 * `pin_pad_idle_seconds` of the `{staff, pin_pad_idle_seconds}` response (migration 0025). Only a finite number is kept; the
 * range is clamped by the consumer. A response without it (older Edge Function) yields null.
 */
export function parsePinPadIdleSeconds(data: unknown): number | null {
  if (typeof data !== 'object' || data === null) return null
  const v = (data as { pin_pad_idle_seconds?: unknown }).pin_pad_idle_seconds
  return typeof v === 'number' && Number.isFinite(v) ? v : null
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
  return staff ? { ok: true, staff, pinPadIdleSeconds: parsePinPadIdleSeconds(data) } : { ok: false, reason: 'server_error' }
}
