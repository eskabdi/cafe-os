import { FunctionsFetchError, FunctionsHttpError, FunctionsRelayError } from '@supabase/supabase-js'
import { z } from 'zod'
import { supabase } from './client'
import { failureFromStatus, type PinLoginFailure } from './pin-login-errors'

export type { PinLoginFailure } from './pin-login-errors'
export type PinLoginResult = { ok: true } | { ok: false; reason: PinLoginFailure }

export interface PinLoginRequest {
  restaurant_slug: string
  username: string
  pin: string
}

const sessionSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().positive(),
})

/** Tile path of a registered kiosk device (kiosk-terminals.md): the tile id plus the device's kiosk token. 4-digit PIN. */
export interface PinLoginTileRequest {
  restaurant_slug: string
  kiosk_token: string
  profile_id: string
  pin: string
}

/** Calls the pin-login Edge Function (username path) and, on success, installs the returned session. */
export function pinLogin(req: PinLoginRequest): Promise<PinLoginResult> {
  return invokePinLogin(req)
}

/** Calls the pin-login Edge Function (kiosk tile path) and, on success, installs the returned session. */
export function pinLoginTile(req: PinLoginTileRequest): Promise<PinLoginResult> {
  return invokePinLogin(req)
}

async function invokePinLogin(body: PinLoginRequest | PinLoginTileRequest): Promise<PinLoginResult> {
  const { data, error } = await supabase.functions.invoke('pin-login', { body })
  if (error) {
    if (error instanceof FunctionsHttpError) {
      const status = (error.context as { status?: number } | undefined)?.status ?? 500
      return { ok: false, reason: failureFromStatus(status) }
    }
    if (error instanceof FunctionsFetchError || error instanceof FunctionsRelayError) {
      return { ok: false, reason: 'network' }
    }
    return { ok: false, reason: 'server_error' }
  }
  const parsed = sessionSchema.safeParse(data)
  if (!parsed.success) return { ok: false, reason: 'server_error' }
  const { error: setError } = await supabase.auth.setSession({
    access_token: parsed.data.access_token,
    refresh_token: parsed.data.refresh_token,
  })
  return setError ? { ok: false, reason: 'server_error' } : { ok: true }
}
