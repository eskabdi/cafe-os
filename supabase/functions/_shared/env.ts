// Environment access for Edge Functions (Deno only; not imported by unit tests).
// The service-role key is read ONLY here, inside the function runtime. It is never returned,
// logged, or forwarded to a client.

import { isPepperAllowedFor, isUsablePepper } from './pin.ts'

export interface PinLoginEnv {
  supabaseUrl: string
  serviceRoleKey: string
  anonKey: string
  allowedOrigins: string | undefined
  /** HMAC key for PIN digests (secret; >= 32 chars). Shared by pin-login and staff-create. */
  pinPepper: string
}

export function readPinLoginEnv(): PinLoginEnv | null {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const pinPepper = Deno.env.get('PIN_PEPPER')
  // a missing or short pepper disables the function (fail closed): a weak pepper defeats its purpose
  if (!supabaseUrl || !serviceRoleKey || !anonKey || !isUsablePepper(pinPepper)) return null
  // the public demo pepper (seed.sql) must never protect a hosted project's PINs
  if (!isPepperAllowedFor(pinPepper, supabaseUrl)) return null
  return { supabaseUrl, serviceRoleKey, anonKey, allowedOrigins: Deno.env.get('ALLOWED_ORIGINS'), pinPepper }
}

/** Same variables, read by staff-create. */
export const readStaffCreateEnv = readPinLoginEnv
