import { useEffect, useRef } from 'react'
import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '@/features/auth'
import { pinChangeStatusOf } from '@/lib/supabase/rpc'
import { pinGateTarget, type PinGateState } from './pin-paths'

/**
 * Layout route behind RequireAuth for every tenant route. Sends a user whose PIN must change to the Change PIN screen and a
 * user waiting for approval to the waiting screen. UX only: the server (fn_pin_restricted behind has_permission, station
 * access and RLS) is the ceiling, so a bypassed gate exposes nothing.
 */
export function PinChangeGate() {
  const { context } = useAuth()
  const { pathname } = useLocation()
  const status = pinChangeStatusOf(context)
  const slug = context?.restaurant?.slug
  const previous = useRef(status)
  // pending -> required while mounted means a manager rejected the new PIN (fn_reject_pin_change).
  const rejected = previous.current === 'pending_approval' && status === 'required'

  useEffect(() => {
    previous.current = status
  }, [status])

  if (!slug || !context?.user) return <Outlet />
  const target = pinGateTarget(status, pathname, slug)
  if (target) {
    const state: PinGateState | undefined = rejected ? { pinChangeRejected: true } : undefined
    return <Navigate to={target} replace state={state} />
  }
  return <Outlet />
}
