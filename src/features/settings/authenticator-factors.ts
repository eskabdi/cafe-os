import { supabase } from '@/lib/supabase/client'

/** TanStack Query key of the signed-in user's verified authenticators. */
export const AUTHENTICATOR_FACTORS_KEY = ['authenticator-factors'] as const

export interface AuthenticatorFactor {
  id: string
  name: string
  createdAt: string | null
}

/** Verified authenticator-app factors of the signed-in user (Supabase Auth). Unfinished enrollments are not listed. */
export async function listAuthenticators(): Promise<AuthenticatorFactor[]> {
  const { data, error } = await supabase.auth.mfa.listFactors()
  if (error || !data) throw error ?? new Error('factors_unavailable')
  return data.totp.map((f) => ({
    id: f.id,
    name: f.friendly_name || 'Authenticator app',
    createdAt: f.created_at ?? null,
  }))
}

/** Ids of factors the user started but never verified (an abandoned setup). Removing them needs no verification. */
export async function listUnfinishedAuthenticatorIds(): Promise<string[]> {
  const { data, error } = await supabase.auth.mfa.listFactors()
  if (error || !data) return []
  return (data.all ?? [])
    .filter((f) => f.factor_type === 'totp' && f.status === 'unverified')
    .map((f) => f.id)
}
