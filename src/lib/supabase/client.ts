import { createClient } from '@supabase/supabase-js'
import type { Database } from './types'

// Only the two public variables are ever read in the browser. The service-role
// key must never appear anywhere under src/ (enforced by `pnpm lint`).
const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!url || !anonKey) {
  throw new Error(
    'Missing Supabase configuration: set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY ' +
      '(copy .env.example to .env.local and fill in the values printed by `supabase start`).',
  )
}

export const supabase = createClient<Database>(url, anonKey)
