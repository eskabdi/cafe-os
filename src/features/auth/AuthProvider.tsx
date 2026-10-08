import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase/client'
import { getSessionContext, type SessionContext } from '@/lib/supabase/rpc'
import { AuthContext, type AuthValue, type ContextStatus } from './useAuth'

interface ContextState {
  userId: string | null
  status: 'loading' | 'ready' | 'error'
  context: SessionContext | null
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [initialized, setInitialized] = useState(false)
  const [ctx, setCtx] = useState<ContextState>({ userId: null, status: 'loading', context: null })
  const [reloadTick, setReloadTick] = useState(0)

  // Supabase emits INITIAL_SESSION on subscribe, then SIGNED_IN / TOKEN_REFRESHED / SIGNED_OUT.
  // The callback only stores the session: no Supabase calls inside it (they can deadlock the auth lock).
  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next)
      setInitialized(true)
    })
    return () => data.subscription.unsubscribe()
  }, [])

  const userId = session?.user.id ?? null

  // The query cache is per browser, not per user: drop it whenever the signed-in user changes or signs out, so a shared
  // browser never shows the previous user's tenant data (pending PIN approvals, timers...).
  const queryClient = useQueryClient()
  const lastUserId = useRef<string | null>(null)
  useEffect(() => {
    if (lastUserId.current !== userId) {
      if (lastUserId.current !== null || userId === null) queryClient.clear()
      lastUserId.current = userId
    }
  }, [userId, queryClient])

  // Reload the server-derived context when the user changes (not on every token refresh). refreshContext() for the SAME
  // user reloads in the background: the previous context stays visible until the new one arrives, so a live transition
  // (e.g. PIN change approved) does not unmount the signed-in tree behind a loading screen.
  useEffect(() => {
    if (!userId) return
    let active = true
    setCtx((prev) =>
      prev.userId === userId && prev.status === 'ready' ? prev : { userId, status: 'loading', context: null },
    )
    getSessionContext()
      .then((context) => {
        if (active) setCtx({ userId, status: 'ready', context })
      })
      .catch(() => {
        // A failed background refresh keeps the previous ready context (inactivity guard and gate stay in force).
        if (active)
          setCtx((prev) =>
            prev.userId === userId && prev.status === 'ready'
              ? prev
              : { userId, status: 'error', context: null },
          )
      })
    return () => {
      active = false
    }
  }, [userId, reloadTick])

  const signOut = useCallback(async () => {
    await supabase.auth.signOut()
  }, [])
  const refreshContext = useCallback(() => setReloadTick((n) => n + 1), [])

  const value = useMemo<AuthValue>(() => {
    const permissions = ctx.userId === userId ? (ctx.context?.permissions ?? []) : []
    const contextStatus: ContextStatus = !userId ? 'idle' : ctx.userId !== userId ? 'loading' : ctx.status
    return {
      status: !initialized ? 'loading' : session ? 'authenticated' : 'signed_out',
      session,
      context: userId && ctx.userId === userId ? ctx.context : null,
      contextStatus,
      can: (permission) => permissions.includes(permission),
      signOut,
      refreshContext,
    }
  }, [initialized, session, userId, ctx, signOut, refreshContext])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
