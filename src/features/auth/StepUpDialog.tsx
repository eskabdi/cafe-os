import { useEffect, useState, type FormEvent } from 'react'
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
import { supabase } from '@/lib/supabase/client'

const MESSAGES = {
  code: 'That code did not work. Enter the current 6-digit code from your authenticator app.',
  noFactor:
    'An authenticator is required for this action. This account has none set up; ask your administrator.',
  generic: 'Something went wrong. Please try again.',
}

export interface StepUpDialogProps {
  open: boolean
  /** Called once the session is upgraded (aal2); the caller retries the action that answered mfa_required. */
  onVerified: () => void
  onCancel: () => void
}

/**
 * Step-up for an RPC that answered `mfa_required` (fn_require_step_up / fn_require_aal2): verifies a TOTP code with Supabase Auth, which upgrades
 * the session to aal2. The server re-checks the assurance level on the retried call; this dialog decides nothing itself.
 * An account with no authenticator (PIN-only staff) cannot pass fn_require_aal2: it gets the neutral `noFactor` message, no code input.
 */
export function StepUpDialog({ open, onVerified, onCancel }: StepUpDialogProps) {
  const [factorId, setFactorId] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    let active = true
    setCode('')
    setError(null)
    setFactorId(null)
    supabase.auth.mfa
      .listFactors()
      .then(({ data, error: factorError }) => {
        if (!active) return
        const totp = data?.totp[0]
        if (factorError || !totp) setError(MESSAGES.noFactor)
        else setFactorId(totp.id)
      })
      .catch(() => active && setError(MESSAGES.generic))
    return () => {
      active = false
    }
  }, [open])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy || !factorId) return
    if (!/^[0-9]{6}$/.test(code)) {
      setError(MESSAGES.code)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({ factorId, code })
      setCode('')
      if (verifyError) setError(MESSAGES.code)
      else onVerified()
    } catch {
      setError(MESSAGES.generic)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent>
        <form onSubmit={(e) => void submit(e)} noValidate className="space-y-4">
          <DialogHeader>
            <DialogTitle>Verify it is you</DialogTitle>
            <DialogDescription>Verify with your authenticator to continue.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="step-up-code">Authentication code</Label>
            <Input
              id="step-up-code"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              autoComplete="one-time-code"
              value={code}
              disabled={!factorId || busy}
              onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, ''))}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'step-up-error' : undefined}
            />
          </div>
          {error && (
            <p id="step-up-error" role="alert" className="text-sm font-medium text-status-error">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !factorId}>
              {busy ? 'Verifying…' : 'Verify'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
