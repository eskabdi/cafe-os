import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { isStepUpRequired, ClientActionError } from '@/lib/supabase/menu-inventory-errors'
import { StepUpDialog } from './StepUpDialog'

interface Pending {
  retry: () => Promise<unknown>
  resolve: (v: unknown) => void
  reject: (e: unknown) => void
}

export interface StepUpRunner {
  /**
   * Runs `action`. If the server answers `mfa_required`, the step-up dialog opens and the returned promise stays pending until
   * the user verifies (the SAME action, with the same arguments and idempotency key, runs once more) or cancels
   * (rejects with ClientActionError('step_up_cancelled')). A newer run() that also needs step-up, or unmounting, cancels
   * the older pending prompt the same way. A second `mfa_required` after a verified step-up is returned as an
   * error, never asked again, so nothing loops without the user acting. Every other error is rethrown unchanged.
   */
  run: <T>(action: () => Promise<T>) => Promise<T>
  /** Render once in the component that calls run(). */
  dialog: ReactNode
}

/** Step-up (aal2) wrapper for RPCs that may answer mfa_required. The server re-checks; this only drives the prompt. */
export function useStepUp(): StepUpRunner {
  const [open, setOpen] = useState(false)
  const pending = useRef<Pending | null>(null)

  const run = useCallback(async <T,>(action: () => Promise<T>): Promise<T> => {
    try {
      return await action()
    } catch (err) {
      if (!isStepUpRequired(err)) throw err
      return new Promise<T>((resolve, reject) => {
        // Only one prompt at a time: a newer step-up supersedes (cancels) the older one so its caller never hangs.
        pending.current?.reject(new ClientActionError('step_up_cancelled'))
        pending.current = { retry: action, resolve: resolve as (v: unknown) => void, reject }
        setOpen(true)
      })
    }
  }, [])

  // Unmount: settle any pending step-up so awaiting callers do not hang forever.
  useEffect(
    () => () => {
      const p = pending.current
      pending.current = null
      p?.reject(new ClientActionError('step_up_cancelled'))
    },
    [],
  )

  const onVerified = useCallback(() => {
    const p = pending.current
    pending.current = null
    setOpen(false)
    if (!p) return
    p.retry().then(p.resolve, p.reject)
  }, [])

  const onCancel = useCallback(() => {
    const p = pending.current
    pending.current = null
    setOpen(false)
    p?.reject(new ClientActionError('step_up_cancelled'))
  }, [])

  return { run, dialog: <StepUpDialog open={open} onVerified={onVerified} onCancel={onCancel} /> }
}
