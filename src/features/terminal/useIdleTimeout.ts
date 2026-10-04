import { useEffect, useRef } from 'react'

const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'touchstart'] as const

/** Calls `onIdle` after `ms` without pointer/key/touch activity while `active`. Any activity restarts the countdown. */
export function useIdleTimeout(active: boolean, ms: number, onIdle: () => void): void {
  const cb = useRef(onIdle)
  useEffect(() => {
    cb.current = onIdle
  })

  useEffect(() => {
    if (!active) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const arm = () => {
      clearTimeout(timer)
      timer = setTimeout(() => cb.current(), ms)
    }
    arm()
    for (const e of ACTIVITY_EVENTS) document.addEventListener(e, arm, true)
    return () => {
      clearTimeout(timer)
      for (const e of ACTIVITY_EVENTS) document.removeEventListener(e, arm, true)
    }
  }, [active, ms])
}
