import { createContext, useContext } from 'react'
import type { Session } from '@supabase/supabase-js'
import type { SessionContext } from '@/lib/supabase/rpc'

export type AuthStatus = 'loading' | 'signed_out' | 'authenticated'
export type ContextStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface AuthValue {
  status: AuthStatus
  session: Session | null
  /** Server-derived (fn_get_session_context): profile, tenant, role, permissions, station access. Never JWT claims. */
  context: SessionContext | null
  contextStatus: ContextStatus
  /** UX only. The server (RLS + RPC checks) is the actual authorization ceiling. */
  can: (permission: string) => boolean
  signOut: () => Promise<void>
  refreshContext: () => void
}

export const AuthContext = createContext<AuthValue | null>(null)

export function useAuth(): AuthValue {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>')
  return value
}
