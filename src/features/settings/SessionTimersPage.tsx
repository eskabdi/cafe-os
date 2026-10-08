import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RequirePermission, StepUpDialog, useAuth } from '@/features/auth'
import {
  SESSION_TIMER_DEFAULTS,
  sessionTimersFormSchema,
  type SessionTimerField,
  type SessionTimersForm,
} from '@/lib/domain/session-timers'
import {
  getSessionTimers,
  resetSessionTimers,
  RpcError,
  updateSessionTimers,
  type SessionTimersRow,
} from '@/lib/supabase/rpc'
import { fieldErrorMessage, invalidField, sessionTimersErrorMessage } from './session-timer-errors'

export const SESSION_TIMERS_KEY = ['session-timers'] as const

const FIELDS: Array<{ name: SessionTimerField; label: string; hint: string; min: number; max?: number }> = [
  {
    name: 'idle_warning_seconds',
    label: 'Show the warning after (seconds)',
    hint: 'Seconds without activity before "Still there?" appears. At least 5, and less than the sign-out time.',
    min: 5,
  },
  {
    name: 'signout_seconds',
    label: 'Sign out after (seconds)',
    hint: 'Total seconds without activity before staff are signed out. 15 to 900.',
    min: 15,
    max: 900,
  },
  {
    name: 'pin_pad_idle_seconds',
    label: 'Terminal PIN pad timeout (seconds)',
    hint: 'On a shared terminal, an untouched PIN pad goes back to the staff tiles. 15 to 300.',
    min: 15,
    max: 300,
  },
]

/** Tenant settings > Session timers. Gate is UX only: fn_update/reset_session_timers check the permission, step-up and tenant. */
export function SessionTimersPage() {
  return (
    <RequirePermission permission="settings.session_timers">
      <SessionTimersContent />
    </RequirePermission>
  )
}

type Action = { kind: 'save'; values: SessionTimersRow } | { kind: 'reset' }

function SessionTimersContent() {
  const { context, refreshContext } = useAuth()
  const slug = context?.restaurant?.slug ?? ''
  const qc = useQueryClient()
  const timers = useQuery({ queryKey: SESSION_TIMERS_KEY, queryFn: getSessionTimers })
  const [formError, setFormError] = useState<string | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)
  const [stepUpFor, setStepUpFor] = useState<Action | null>(null)

  const form = useForm<SessionTimersForm>({
    resolver: zodResolver(sessionTimersFormSchema),
    defaultValues: SESSION_TIMER_DEFAULTS,
    mode: 'onChange',
  })
  const { register, handleSubmit, reset, setError, watch, formState } = form

  useEffect(() => {
    if (timers.data) reset(timers.data)
  }, [timers.data, reset])

  const save = useMutation({ mutationFn: updateSessionTimers })
  const restore = useMutation({ mutationFn: resetSessionTimers })
  const busy = save.isPending || restore.isPending

  const run = async (action: Action) => {
    setFormError(null)
    try {
      const stored =
        action.kind === 'save' ? await save.mutateAsync(action.values) : await restore.mutateAsync()
      qc.setQueryData(SESSION_TIMERS_KEY, stored)
      reset(stored)
      toast.success(action.kind === 'reset' ? 'Session timers reset to the defaults' : 'Session timers saved')
      refreshContext() // this device picks up the new values at once; other devices on their next session load
    } catch (err) {
      const code = err instanceof RpcError ? err.code : undefined
      if (code === 'mfa_required') {
        setStepUpFor(action)
        return
      }
      const field = code === 'invalid_input' && err instanceof RpcError ? invalidField(err.detail) : null
      if (field) setError(field, { type: 'server', message: fieldErrorMessage(field) }, { shouldFocus: true })
      else setFormError(sessionTimersErrorMessage(code))
    }
  }

  const warn = watch('idle_warning_seconds')
  const signout = watch('signout_seconds')
  const pinPad = watch('pin_pad_idle_seconds')
  const previewOk =
    Number.isInteger(warn) &&
    Number.isInteger(signout) &&
    warn >= 5 &&
    signout >= 15 &&
    signout <= 900 &&
    warn < signout

  return (
    <main className="mx-auto max-w-2xl space-y-6 p-6">
      <header className="space-y-1">
        <Link className="text-sm text-ink underline underline-offset-4" to={`/r/${slug}`}>
          Back
        </Link>
        <h1 className="text-xl font-semibold text-ink">Session timers</h1>
        <p className="text-sm text-muted-foreground">
          How long staff can be inactive before they are signed out, and how long a terminal PIN pad waits.
          Owners and managers who sign in with email are not signed out automatically.
        </p>
      </header>

      {timers.isPending && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading…
        </p>
      )}
      {timers.isError && (
        <p role="alert" className="text-sm font-medium text-status-error">
          {sessionTimersErrorMessage(timers.error instanceof RpcError ? timers.error.code : undefined)}
        </p>
      )}

      {timers.data && (
        <form
          noValidate
          className="space-y-5 rounded-card border border-line bg-white p-5"
          onSubmit={(e) => void handleSubmit((values) => run({ kind: 'save', values }))(e)}
        >
          {FIELDS.map((f) => {
            const error = formState.errors[f.name]?.message
            const hintId = `${f.name}-hint`
            const errorId = `${f.name}-error`
            return (
              <div key={f.name} className="space-y-1.5">
                <Label htmlFor={f.name}>{f.label}</Label>
                <Input
                  id={f.name}
                  type="number"
                  inputMode="numeric"
                  min={f.min}
                  max={f.max}
                  step={1}
                  className="max-w-[10rem]"
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? `${hintId} ${errorId}` : hintId}
                  {...register(f.name, { valueAsNumber: true })}
                />
                <p id={hintId} className="text-xs text-muted-foreground">
                  {f.hint}
                </p>
                {error && (
                  <p id={errorId} role="alert" className="text-sm font-medium text-status-error">
                    {error}
                  </p>
                )}
              </div>
            )
          })}

          <div
            role="status"
            aria-live="polite"
            className="rounded-md bg-bg p-3 text-sm text-ink"
            data-testid="timers-preview"
          >
            {previewOk ? (
              <>
                <p>
                  After {warn} seconds without activity staff see &ldquo;Still there?&rdquo;. The warning
                  stays visible for {signout - warn} seconds (sign-out minus warning), then they are signed
                  out at {signout} seconds.
                </p>
                {Number.isInteger(pinPad) && pinPad >= 15 && pinPad <= 300 && (
                  <p>An untouched terminal PIN pad returns to the staff tiles after {pinPad} seconds.</p>
                )}
              </>
            ) : (
              <p>Enter valid values to see how the timers behave.</p>
            )}
          </div>

          {formError && (
            <p role="alert" className="text-sm font-medium text-status-error">
              {formError}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy}>
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
            <Button type="button" variant="outline" disabled={busy} onClick={() => setConfirmReset(true)}>
              Reset to defaults
            </Button>
          </div>
        </form>
      )}

      <Dialog open={confirmReset} onOpenChange={(open) => !open && setConfirmReset(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reset to defaults?</DialogTitle>
            <DialogDescription>
              Warning after {SESSION_TIMER_DEFAULTS.idle_warning_seconds} seconds, sign-out after{' '}
              {SESSION_TIMER_DEFAULTS.signout_seconds} seconds, terminal PIN pad after{' '}
              {SESSION_TIMER_DEFAULTS.pin_pad_idle_seconds} seconds.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmReset(false)}>
              Cancel
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                setConfirmReset(false)
                void run({ kind: 'reset' })
              }}
            >
              Reset
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <StepUpDialog
        open={stepUpFor !== null}
        onCancel={() => {
          setStepUpFor(null)
          setFormError(sessionTimersErrorMessage('mfa_required'))
        }}
        onVerified={() => {
          const action = stepUpFor
          setStepUpFor(null)
          if (action) void run(action)
        }}
      />
    </main>
  )
}
