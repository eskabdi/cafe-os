import { FunctionsFetchError, FunctionsHttpError, FunctionsRelayError } from '@supabase/supabase-js'
import { z } from 'zod'
import { supabase } from './client'
import { parseRetryAfter, pinChangeFailureFrom, type PinChangeFailure } from './pin-change-errors'

export type { PinChangeFailure } from './pin-change-errors'

export interface PinChangeRequest {
  current_pin: string
  new_pin: string
}

export type PinChangeResult =
  | { ok: true; pendingApproval: boolean; otherSessionsRevoked: boolean }
  | { ok: false; reason: PinChangeFailure; retryAfterSec?: number }

/** A change must never hang behind a stuck request (the inactivity guard is paused while a mutation is in flight). */
export const PIN_CHANGE_TIMEOUT_MS = 15_000

// Unknown extra keys are stripped (never surfaced); a missing or mistyped field is a server_error, never a guess.
const successSchema = z.object({
  changed: z.literal(true),
  pending_approval: z.boolean(),
  other_sessions_revoked: z.boolean(),
})

async function errorCodeOf(res: Response): Promise<unknown> {
  try {
    const body: unknown = await res.clone().json()
    return typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined
  } catch {
    return undefined
  }
}

/**
 * Calls the pin-change Edge Function for the signed-in user. The user is identified by the access token only (sent as an
 * explicit Bearer header); the body carries just the two PINs. The caller must drop both PINs from its state before awaiting.
 */
export async function changePin(req: PinChangeRequest, timeoutMs = PIN_CHANGE_TIMEOUT_MS): Promise<PinChangeResult> {
  let token: string | undefined
  try {
    const { data } = await supabase.auth.getSession()
    token = data.session?.access_token
  } catch {
    return { ok: false, reason: 'server_error' }
  }
  if (!token) return { ok: false, reason: 'unauthorized' }

  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  let data: unknown
  let error: unknown
  try {
    ;({ data, error } = await supabase.functions.invoke('pin-change', {
      body: { current_pin: req.current_pin, new_pin: req.new_pin },
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    }))
  } catch {
    return { ok: false, reason: timedOut ? 'network' : 'server_error' }
  } finally {
    clearTimeout(timer)
  }
  if (timedOut) return { ok: false, reason: 'network' }

  if (error) {
    if (error instanceof FunctionsHttpError) {
      const res = error.context as Response | undefined
      const status = typeof res?.status === 'number' ? res.status : 500
      const reason = pinChangeFailureFrom(status, res ? await errorCodeOf(res) : undefined)
      if (reason === 'rate_limited') {
        return { ok: false, reason, retryAfterSec: parseRetryAfter(res?.headers?.get('Retry-After')) }
      }
      return { ok: false, reason }
    }
    if (error instanceof FunctionsFetchError || error instanceof FunctionsRelayError) return { ok: false, reason: 'network' }
    return { ok: false, reason: 'server_error' }
  }

  const parsed = successSchema.safeParse(data)
  if (!parsed.success) return { ok: false, reason: 'server_error' }
  return {
    ok: true,
    pendingApproval: parsed.data.pending_approval,
    otherSessionsRevoked: parsed.data.other_sessions_revoked,
  }
}
