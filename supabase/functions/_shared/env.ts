// Environment access for Edge Functions (Deno only; not imported by unit tests).
// The service-role key is read ONLY here, inside the function runtime. It is never returned,
// logged, or forwarded to a client.

export interface PinLoginEnv {
  supabaseUrl: string
  serviceRoleKey: string
  anonKey: string
  allowedOrigins: string | undefined
}

export function readPinLoginEnv(): PinLoginEnv | null {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  if (!supabaseUrl || !serviceRoleKey || !anonKey) return null
  return { supabaseUrl, serviceRoleKey, anonKey, allowedOrigins: Deno.env.get('ALLOWED_ORIGINS') }
}
