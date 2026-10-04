import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useIsMutating, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { terminalPath } from '@/features/terminal/terminal-paths'
import { getKioskToken } from '@/lib/utils/kiosk-token'
import { idlePhase, inactivityTimings, isInactivityManaged } from './inactivity'
import { useAuth } from './useAuth'

const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'touchstart', 'wheel'] as const
const TICK_MS = 1000
const BROADCAST_THROTTLE_MS = 5000

type Msg = { type: 'activity' } | { type: 'signout' }

/**
 * Mounted once inside AuthProvider. Ends the session of staff (everyone except tenant_admin / platform admins) after
 * IDLE_MS + WARN_MS of inactivity, with a "Still there?" alertdialog for the last WARN_MS. signOut deletes the server session
 * (frees the one-session rule), the query cache is cleared, and the user lands on the terminal (kiosk device) or staff login.
 * Deadline checks use Date.now(), so a tablet that slept signs out on the first tick/visibility event after waking.
 * UX/hygiene only: server-side session limits remain the authority.
 */
export function InactivityGuard() {
  const { status, context, signOut } = useAuth()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const mutating = useIsMutating()
  const managed = status === 'authenticated' && isInactivityManaged(context)
  const slug = context?.restaurant?.slug ?? null

  const last = useRef(Date.now())
  const lastBroadcast = useRef(0)
  const channel = useRef<BroadcastChannel | null>(null)
  const mutatingRef = useRef(0)
  const done = useRef(false)
  const warningRef = useRef(false)
  const continueRef = useRef<HTMLButtonElement>(null)
  const [remainingS, setRemainingS] = useState<number | null>(null) // non-null = warning visible

  useEffect(() => {
    mutatingRef.current = mutating
  }, [mutating])

  const post = useCallback((m: Msg) => {
    try {
      channel.current?.postMessage(m)
    } catch {
      // channel closed: cross-tab sync is optional
    }
  }, [])

  const endSession = useCallback(
    async (broadcast: boolean) => {
      if (done.current) return
      done.current = true
      warningRef.current = false
      setRemainingS(null)
      if (broadcast) post({ type: 'signout' })
      const target = slug ? (getKioskToken(slug) ? terminalPath(slug) : `/r/${slug}/login`) : '/'
      try {
        await signOut()
      } catch {
        // the local session is dropped below either way
      }
      qc.clear()
      navigate(target, { replace: true })
    },
    [navigate, post, qc, signOut, slug],
  )

  const resetActivity = useCallback(
    (broadcast: boolean) => {
      last.current = Date.now()
      warningRef.current = false
      setRemainingS(null)
      const now = Date.now()
      if (broadcast && now - lastBroadcast.current >= BROADCAST_THROTTLE_MS) {
        lastBroadcast.current = now
        post({ type: 'activity' })
      }
    },
    [post],
  )

  useEffect(() => {
    if (!managed) return
    done.current = false
    last.current = Date.now()
    warningRef.current = false
    const timings = inactivityTimings()

    try {
      channel.current = new BroadcastChannel('cafeos-session')
      channel.current.onmessage = (e: MessageEvent<Msg>) => {
        if (e.data?.type === 'activity') resetActivity(false)
        else if (e.data?.type === 'signout') void endSession(false)
      }
    } catch {
      channel.current = null
    }

    const check = () => {
      if (done.current) return
      if (mutatingRef.current > 0 && !warningRef.current) last.current = Date.now() // never interrupt a write
      const elapsed = Date.now() - last.current
      const phase = idlePhase(elapsed, timings)
      if (phase === 'expired') void endSession(true)
      else if (phase === 'warning') {
        warningRef.current = true
        setRemainingS(Math.max(0, Math.ceil((timings.idleMs + timings.warnMs - elapsed) / 1000)))
      }
    }

    const onActivity = () => {
      if (warningRef.current) return // only Continue answers the warning
      resetActivity(true)
    }
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      check() // a device that slept past the deadline signs out now
      if (!done.current && !warningRef.current) resetActivity(true)
    }

    for (const ev of ACTIVITY_EVENTS) document.addEventListener(ev, onActivity, true)
    document.addEventListener('visibilitychange', onVisible)
    const timer = setInterval(check, TICK_MS)
    return () => {
      clearInterval(timer)
      for (const ev of ACTIVITY_EVENTS) document.removeEventListener(ev, onActivity, true)
      document.removeEventListener('visibilitychange', onVisible)
      channel.current?.close()
      channel.current = null
    }
  }, [managed, endSession, resetActivity])

  useEffect(() => {
    if (remainingS !== null) continueRef.current?.focus()
  }, [remainingS === null]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!managed || remainingS === null) return null

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="inactivity-title"
        aria-describedby="inactivity-desc"
        className="w-full max-w-sm space-y-4 rounded-card border border-line bg-white p-6 shadow-lg"
        onKeyDown={(e) => {
          if (e.key !== 'Tab') return
          const buttons = Array.from(e.currentTarget.querySelectorAll('button'))
          const first = buttons[0]
          const lastB = buttons[buttons.length - 1]
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault()
            lastB?.focus()
          } else if (!e.shiftKey && document.activeElement === lastB) {
            e.preventDefault()
            first?.focus()
          }
        }}
      >
        <h2 id="inactivity-title" className="text-lg font-semibold text-ink">
          Still there?
        </h2>
        <p id="inactivity-desc" className="text-sm text-muted-foreground">
          For your security you will be signed out soon.
        </p>
        <p role="status" aria-live="polite" className="text-sm font-medium text-ink">
          Signing out in {remainingS} seconds
        </p>
        <div className="flex gap-2">
          <Button ref={continueRef} className="flex-1" onClick={() => resetActivity(true)}>
            Continue
          </Button>
          <Button variant="outline" className="flex-1" onClick={() => void endSession(true)}>
            Sign out
          </Button>
        </div>
      </div>
    </div>
  )
}
