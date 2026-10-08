import { useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { supabase } from '@/lib/supabase/client'

export interface AdminLoginFormProps {
  /**
   * Optional authoritative check run after the final factor (e.g. is_platform_super_admin via RPC).
   * Returning false signs the user out again and shows `deniedMessage`.
   */
  verify?: () => Promise<boolean>
  deniedMessage?: string
  onSignedIn?: () => void
}

const MESSAGES = {
  credentials: 'Incorrect email or password.',
  rateLimited: 'Too many attempts. Please wait a few minutes and try again.',
  code: 'That code is incorrect or has expired. Try the next code.',
  generic: 'Something went wrong. Please try again.',
  denied: 'This account is not authorised for this area.',
  noFactor: 'Two-step verification could not be started. Please contact your administrator.',
} as const

function signInErrorMessage(error: { status?: number; code?: string }): string {
  if (error.status === 429 || error.code === 'over_request_rate_limit') return MESSAGES.rateLimited
  if (error.status !== undefined && error.status >= 500) return MESSAGES.generic
  // invalid credentials, unconfirmed email, unknown user: one message, no account enumeration
  return MESSAGES.credentials
}

/** Email + password sign-in for tenant_admin / platform admins (Supabase Auth), with a TOTP step when enrolled. */
export function AdminLoginForm({ verify, deniedMessage = MESSAGES.denied, onSignedIn }: AdminLoginFormProps) {
  const [step, setStep] = useState<'credentials' | 'mfa'>('credentials')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [factorId, setFactorId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const abort = async (message: string) => {
    await supabase.auth.signOut()
    setStep('credentials')
    setFactorId(null)
    setCode('')
    setPassword('')
    setError(message)
  }

  const finish = async () => {
    if (verify) {
      let allowed = false
      try {
        allowed = await verify()
      } catch {
        allowed = false
      }
      if (!allowed) return abort(deniedMessage)
    }
    onSignedIn?.()
  }

  const submitCredentials = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const { error: signInError } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
      if (signInError) {
        setPassword('')
        setError(signInErrorMessage(signInError))
        return
      }
      const { data: aal, error: aalError } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
      if (aalError || !aal) return await abort(MESSAGES.generic)
      if (aal.nextLevel === 'aal2' && aal.currentLevel !== 'aal2') {
        const { data: factors, error: factorError } = await supabase.auth.mfa.listFactors()
        const totp = factors?.totp[0]
        if (factorError || !totp) return await abort(MESSAGES.noFactor)
        setFactorId(totp.id)
        setPassword('')
        setStep('mfa')
        return
      }
      await finish()
    } catch {
      setError(MESSAGES.generic)
    } finally {
      setBusy(false)
    }
  }

  const submitCode = async (e: FormEvent) => {
    e.preventDefault()
    if (busy || !factorId) return
    if (!/^[0-9]{6}$/.test(code)) {
      setError(MESSAGES.code)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const { error: mfaError } = await supabase.auth.mfa.challengeAndVerify({ factorId, code })
      if (mfaError) {
        setCode('')
        setError(MESSAGES.code)
        return
      }
      await finish()
    } catch {
      setError(MESSAGES.generic)
    } finally {
      setBusy(false)
    }
  }

  const errorEl = error && (
    <p role="alert" className="text-sm font-medium text-status-error">
      {error}
    </p>
  )

  if (step === 'mfa') {
    return (
      <form onSubmit={submitCode} className="space-y-4" noValidate>
        <div className="space-y-2">
          <Label htmlFor="admin-totp">Authentication code</Label>
          <Input
            id="admin-totp"
            name="totp"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={6}
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, ''))}
          />
          <p className="text-xs text-muted-foreground">Enter the 6-digit code from your authenticator app.</p>
        </div>
        {errorEl}
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? 'Verifying…' : 'Verify'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="w-full"
          disabled={busy}
          onClick={() => void abort('')}
        >
          Cancel
        </Button>
      </form>
    )
  }

  return (
    <form onSubmit={submitCredentials} className="space-y-4" noValidate>
      <div className="space-y-2">
        <Label htmlFor="admin-email">Email</Label>
        <Input
          id="admin-email"
          name="email"
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="admin-password">Password</Label>
        <Input
          id="admin-password"
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </div>
      {errorEl}
      <Button type="submit" className="w-full" disabled={busy || !email || !password}>
        {busy ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  )
}
