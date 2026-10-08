import { useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { pinLogin } from '@/lib/supabase/pin-login'
import {
  PIN_LOGIN_MESSAGES,
  PIN_MIN_LENGTH,
  USERNAME_PATTERN,
  PIN_PATTERN,
} from '@/lib/supabase/pin-login-errors'
import { PinPad } from './PinPad'

export interface StaffLoginProps {
  /** Tenant slug from the route. Only a pre-auth resolver: identity is derived server-side after sign-in. */
  slug: string
  onSignedIn?: () => void
}

/**
 * Staff PIN sign-in for a device bound to a tenant (slug route). Two steps: username, then PIN keypad.
 * Username entry (not a staff picker) so no staff list is ever exposed to anonymous callers.
 */
export function StaffLogin({ slug, onSignedIn }: StaffLoginProps) {
  const [step, setStep] = useState<'username' | 'pin'>('username')
  const [username, setUsername] = useState('')
  const [pin, setPin] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const normalized = username.trim().toLowerCase()

  const next = (e: FormEvent) => {
    e.preventDefault()
    if (!USERNAME_PATTERN.test(normalized)) {
      setError(PIN_LOGIN_MESSAGES.invalid_request)
      return
    }
    setError(null)
    setStep('pin')
  }

  const submit = async () => {
    if (busy) return
    if (!PIN_PATTERN.test(pin)) {
      setError(PIN_LOGIN_MESSAGES.invalid_request)
      return
    }
    setBusy(true)
    setError(null)
    const attempt = pin
    // Clear immediately: the PIN is never kept in state longer than the request needs.
    setPin('')
    try {
      const result = await pinLogin({ restaurant_slug: slug, username: normalized, pin: attempt })
      if (result.ok) onSignedIn?.()
      else setError(PIN_LOGIN_MESSAGES[result.reason])
    } catch {
      setError(PIN_LOGIN_MESSAGES.server_error)
    } finally {
      setBusy(false)
    }
  }

  if (step === 'username') {
    return (
      <form onSubmit={next} className="space-y-4" noValidate>
        <div className="space-y-2">
          <Label htmlFor="staff-username">Username</Label>
          <Input
            id="staff-username"
            name="username"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            aria-describedby={error ? 'staff-login-error' : undefined}
            aria-invalid={error ? true : undefined}
          />
        </div>
        {error && (
          <p id="staff-login-error" role="alert" className="text-sm font-medium text-status-error">
            {error}
          </p>
        )}
        <Button type="submit" className="w-full">
          Continue
        </Button>
      </form>
    )
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Signing in as <span className="font-semibold text-ink">{normalized}</span>. Enter your PIN.
      </p>
      <PinPad value={pin} onChange={setPin} onSubmit={() => void submit()} disabled={busy} />
      <div className="min-h-[2.5rem]" aria-live="polite">
        {error && (
          <p role="alert" className="text-center text-sm font-medium text-status-error">
            {error}
          </p>
        )}
      </div>
      <Button className="w-full" disabled={busy || pin.length < PIN_MIN_LENGTH} onClick={() => void submit()}>
        {busy ? 'Signing in…' : 'Sign in'}
      </Button>
      <Button
        variant="ghost"
        className="w-full"
        disabled={busy}
        onClick={() => {
          setStep('username')
          setPin('')
          setError(null)
        }}
      >
        Not you? Change username
      </Button>
    </div>
  )
}
