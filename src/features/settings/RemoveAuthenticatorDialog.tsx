import { useEffect, useRef, useState, type FormEvent } from 'react'
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
import { totpCodeSchema } from '@/lib/domain/authenticator'
import { supabase } from '@/lib/supabase/client'
import { AUTHENTICATOR_MESSAGES, authenticatorErrorMessage, verifyErrorMessage } from './authenticator-errors'
import type { AuthenticatorFactor } from './authenticator-factors'

export interface RemoveAuthenticatorDialogProps {
  /** The authenticator to remove; null closes the dialog. */
  factor: AuthenticatorFactor | null
  onCancel: () => void
  /** Called after the authenticator was removed. */
  onRemoved: () => Promise<void> | void
}

/**
 * Confirm + verify + remove. The "fresh code" step is a UX guard only (it confirms the person at the keyboard holds the
 * authenticator being removed): Supabase Auth, not this dialog, decides whether the unenroll is allowed (it only needs an
 * aal2 session, which an earlier code may already provide), and nothing in the database trusts that a fresh code was entered.
 */
export function RemoveAuthenticatorDialog({ factor, onCancel, onRemoved }: RemoveAuthenticatorDialogProps) {
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const factorId = factor?.id ?? null
  // keep the last non-null name while the dialog animates closed (factor becomes null the moment it is dismissed)
  const lastName = useRef('')
  if (factor) lastName.current = factor.name
  const factorName = factor?.name ?? lastName.current

  useEffect(() => {
    setCode('')
    setError(null)
    setBusy(false)
  }, [factorId])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy || !factor) return
    if (!totpCodeSchema.safeParse(code).success) {
      setError(AUTHENTICATOR_MESSAGES.code)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({ factorId: factor.id, code })
      setCode('')
      if (verifyError) {
        setError(verifyErrorMessage(verifyError))
        return
      }
      const { error: removeError } = await supabase.auth.mfa.unenroll({ factorId: factor.id })
      if (removeError) {
        setError(authenticatorErrorMessage(removeError))
        return
      }
      await onRemoved()
    } catch {
      setError(AUTHENTICATOR_MESSAGES.generic)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={factor !== null} onOpenChange={(open) => !open && !busy && onCancel()}>
      <DialogContent>
        <form onSubmit={(e) => void submit(e)} noValidate className="space-y-4">
          <DialogHeader>
            <DialogTitle>Remove this authenticator?</DialogTitle>
            <DialogDescription>
              Without an authenticator, approving PIN changes and changing the session timers will stop
              working for this account until you set one up again. Enter a code from &ldquo;{factorName}
              &rdquo; to confirm.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="remove-authenticator-code">Authentication code</Label>
            <Input
              id="remove-authenticator-code"
              name="totp"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              autoComplete="one-time-code"
              value={code}
              disabled={busy}
              onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, ''))}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'remove-authenticator-error' : undefined}
            />
          </div>
          {error && (
            <p id="remove-authenticator-error" role="alert" className="text-sm font-medium text-status-error">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? 'Removing…' : 'Remove authenticator'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
