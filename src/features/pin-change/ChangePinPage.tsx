import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { PinPad, useAuth } from '@/features/auth'
import { validatePinChangeForm } from '@/lib/domain/pin-change'
import { changePin, type PinChangeRequest, type PinChangeResult } from '@/lib/supabase/pin-change'
import { pinChangeMessage } from '@/lib/supabase/pin-change-errors'
import type { PinGateState } from './pin-paths'

type Step = 'current' | 'new' | 'confirm'

const STEP_TEXT: Record<Step, { title: string; submit: string; index: number }> = {
  current: { title: 'Enter your current PIN', submit: 'Next', index: 1 },
  new: { title: 'Choose a new PIN', submit: 'Next', index: 2 },
  confirm: { title: 'Enter the new PIN again', submit: 'Change PIN', index: 3 },
}

/** Forced PIN change (route /r/:slug/change-pin). The length comes from the server (pin_length: 4, or 6 for the Cashier exception). */
export function ChangePinPage() {
  const { context, signOut, refreshContext } = useAuth()
  const pinLength = context?.pin_length
  if (pinLength !== 4 && pinLength !== 6) {
    return (
      <main className="mx-auto max-w-md space-y-3 p-6">
        <h1 className="text-xl font-semibold text-ink">Change your PIN</h1>
        <p role="alert" className="text-sm text-muted-foreground">
          Your PIN settings could not be loaded. Please try again.
        </p>
        <div className="flex gap-2">
          <Button onClick={refreshContext}>Retry</Button>
          <Button variant="outline" onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
      </main>
    )
  }
  return <ChangePinForm pinLength={pinLength} />
}

type Done = Extract<PinChangeResult, { ok: true }>

function ChangePinForm({ pinLength }: { pinLength: number }) {
  const { signOut, refreshContext } = useAuth()
  const location = useLocation()
  const rejected = (location.state as PinGateState | null)?.pinChangeRejected === true

  const [step, setStep] = useState<Step>('current')
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sessionEnded, setSessionEnded] = useState(false)
  const [retryUntil, setRetryUntil] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [done, setDone] = useState<Done | null>(null)
  // Entered PINs live only in these refs between steps and are wiped before the request is awaited.
  const currentPin = useRef('')
  const newPin = useRef('')
  // Hand-off to the mutation without putting the PINs into the mutation cache (no `variables`).
  const outgoing = useRef<PinChangeRequest | null>(null)
  const doneHeading = useRef<HTMLHeadingElement>(null)

  const mutation = useMutation({
    gcTime: 0,
    mutationFn: async (): Promise<PinChangeResult> => {
      const req = outgoing.current
      outgoing.current = null
      if (!req) return { ok: false, reason: 'invalid_request' }
      return changePin(req)
    },
  })

  const waitingS = retryUntil ? Math.max(0, Math.ceil((retryUntil - now) / 1000)) : 0
  useEffect(() => {
    if (!retryUntil) return
    const t = setInterval(() => {
      const n = Date.now()
      setNow(n)
      if (n >= retryUntil) {
        setRetryUntil(null)
        setError(null)
      }
    }, 1000)
    return () => clearInterval(t)
  }, [retryUntil])

  useEffect(() => {
    if (done) doneHeading.current?.focus()
  }, [done])

  const wipe = () => {
    currentPin.current = ''
    newPin.current = ''
    setValue('')
  }

  const restart = (message: string | null) => {
    wipe()
    setStep('current')
    setError(message)
  }

  const submitChange = async () => {
    const form = { current_pin: currentPin.current, new_pin: newPin.current, confirm_pin: value }
    const issue = validatePinChangeForm(form, pinLength)
    if (issue === 'mismatch') {
      newPin.current = ''
      setValue('')
      setStep('new')
      setError('The two new PINs did not match. Choose your new PIN again.')
      return
    }
    if (issue) {
      restart(pinChangeMessage(issue === 'same_pin' ? 'same_pin' : 'invalid_request', pinLength))
      return
    }
    outgoing.current = { current_pin: form.current_pin, new_pin: form.new_pin }
    wipe() // the PINs leave component state before the request is awaited
    setError(null)
    let result: PinChangeResult
    try {
      result = await mutation.mutateAsync()
    } catch {
      result = { ok: false, reason: 'server_error' }
    } finally {
      outgoing.current = null
    }
    if (result.ok) {
      setDone(result)
      return
    }
    if (result.reason === 'unauthorized') setSessionEnded(true)
    if (result.reason === 'rate_limited') {
      const n = Date.now()
      setNow(n)
      setRetryUntil(n + (result.retryAfterSec ?? 30) * 1000)
    }
    restart(pinChangeMessage(result.reason, pinLength, result.retryAfterSec))
  }

  const onSubmit = () => {
    if (mutation.isPending || waitingS > 0 || value.length !== pinLength) return
    if (step === 'current') {
      currentPin.current = value
      setValue('')
      setError(null)
      setStep('new')
    } else if (step === 'new') {
      if (value === currentPin.current) {
        setValue('')
        setError(pinChangeMessage('same_pin', pinLength))
        return
      }
      newPin.current = value
      setValue('')
      setError(null)
      setStep('confirm')
    } else {
      void submitChange()
    }
  }

  const back = () => {
    setError(null)
    setValue('')
    if (step === 'confirm') {
      newPin.current = ''
      setStep('new')
    } else {
      wipe()
      setStep('current')
    }
  }

  if (done) {
    return (
      <main className="mx-auto max-w-md space-y-4 p-6">
        <h1 ref={doneHeading} tabIndex={-1} className="text-xl font-semibold text-ink outline-none">
          Your PIN has been changed
        </h1>
        <div role="status" className="space-y-2 text-sm text-ink">
          {done.pendingApproval ? (
            <p>A manager needs to approve the change before you can continue.</p>
          ) : (
            <p>You can continue working.</p>
          )}
          {!done.otherSessionsRevoked && (
            <p className="border-l-4 border-status-warning pl-2 font-medium text-ink">
              Sign out on any other device where you may still be signed in.
            </p>
          )}
        </div>
        <Button className="w-full" onClick={refreshContext}>
          Continue
        </Button>
      </main>
    )
  }

  const text = STEP_TEXT[step]
  const busy = mutation.isPending
  return (
    <main className="mx-auto max-w-sm space-y-5 p-6">
      <header className="space-y-1 text-center">
        <h1 className="text-xl font-semibold text-ink">Change your PIN</h1>
        <p className="text-sm text-muted-foreground">
          For your security, choose a new {pinLength}-digit PIN before you continue. A manager will approve
          the change.
        </p>
      </header>
      {rejected && (
        <p role="status" className="rounded-card border border-line bg-white p-3 text-sm text-ink">
          Your manager did not approve your new PIN. Please choose a different PIN.
        </p>
      )}
      <section
        aria-labelledby="pin-step-title"
        className="space-y-4 rounded-card border border-line bg-white p-5"
      >
        <div className="space-y-0.5 text-center">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Step {text.index} of 3
          </p>
          <h2 id="pin-step-title" className="text-base font-semibold text-ink">
            {text.title}
          </h2>
        </div>
        <PinPad
          key={step}
          value={value}
          onChange={setValue}
          onSubmit={onSubmit}
          fixedLength={pinLength}
          submitLabel={busy ? 'Changing…' : text.submit}
          disabled={busy || waitingS > 0}
          label={`${text.title} keypad`}
        />
        <div className="min-h-[2.5rem] space-y-1" aria-live="polite">
          {error && (
            <p role="alert" className="text-center text-sm font-medium text-status-error">
              {error}
            </p>
          )}
          {waitingS > 0 && (
            <p className="text-center text-sm text-muted-foreground" data-testid="retry-countdown">
              You can try again in {waitingS} seconds.
            </p>
          )}
        </div>
        {step !== 'current' && (
          <Button variant="ghost" className="w-full" disabled={busy} onClick={back}>
            Back
          </Button>
        )}
      </section>
      <Button
        variant={sessionEnded ? 'default' : 'outline'}
        className="w-full"
        onClick={() => void signOut()}
      >
        {sessionEnded ? 'Sign in again' : 'Sign out'}
      </Button>
    </main>
  )
}
