import { useEffect, useState } from 'react'
import { todayIn } from '@/lib/domain/reports-period'

/** How often the local clock is re-read (no server request; the date only changes at local midnight). */
export const TODAY_TICK_MS = 60_000

/**
 * The tenant-local calendar date "YYYY-MM-DD", kept current: re-read on window focus, when the tab becomes visible again
 * and on a one-minute local timer, so a page left open over midnight moves to the new day. Purely local (Intl), no polling
 * of the server. `timeZone` null = not known yet (the hook still returns a date, in the fallback zone of todayIn).
 */
export function useTenantToday(timeZone: string | null): string {
  const zone = timeZone ?? 'Africa/Addis_Ababa'
  const [today, setToday] = useState(() => todayIn(zone))
  const [shownZone, setShownZone] = useState(zone)
  if (shownZone !== zone) {
    // the tenant's zone resolved / changed: recompute during render (no stale frame)
    setShownZone(zone)
    setToday(todayIn(zone))
  }
  useEffect(() => {
    const refresh = () => setToday((prev) => {
      const next = todayIn(zone)
      return next === prev ? prev : next
    })
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', onVisibility)
    const timer = window.setInterval(refresh, TODAY_TICK_MS)
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', onVisibility)
      window.clearInterval(timer)
    }
  }, [zone])
  return today
}
