import { useState, type FormEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { FormError, FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { useAuth } from '@/features/auth'
import { AuthenticatorEnroll } from '@/features/settings/AuthenticatorEnroll'
import { supabase } from '@/lib/supabase/client'

async function firstVerifiedTotp(): Promise<string | null> {
  const { data, error } = await supabase.auth.mfa.listFactors()
  if (error || !data) throw new Error('factors_unavailable')
  return data.totp[0]?.id ?? null
}

/**
 * Every platform RPC needs aal2 with a live authenticator (fn_platform_guard), so the Platform Admin Portal opens only after
 * the Super Admin verified a TOTP code in this session (or set one up first). UX only: the database re-checks on every call.
 */
export function PlatformMfaGate() {
  const { refreshContext, signOut } = useAuth()
  const factor = useQuery({ queryKey: ['platform-mfa-factor'], queryFn: firstVerifiedTotp, retry: false, gcTime: 0 })
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const done = async () => {
    try {
      await supabase.auth.refreshSession()
    } catch {
      // the verified session from challengeAndVerify stays in place
    }
    refreshContext()
  }

  const verify = async (e: FormEvent) => {
    e.preventDefault()
    if (busy || !factor.data) return
    if (!/^[0-9]{6}$/.test(code)) {
      setError('Enter the current 6-digit code from your authenticator app.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({ factorId: factor.data, code })
      setCode('')
      if (verifyError) setError('That code did not work. Enter the current 6-digit code from your authenticator app.')
      else await done()
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-5 p-6">
      <header className="space-y-1 text-center">
        <p className="text-2xl font-bold text-ink">
          Cafe<span className="text-primary">OS</span>
        </p>
        <h1 className="text-lg font-semibold text-ink">Verify it is you</h1>
        <p className="text-sm text-muted-foreground">
          The Platform Admin Portal requires two-step verification with an authenticator app for every session.
        </p>
      </header>
      <div className="rounded-card border border-line bg-white p-5 shadow-sm">
        {factor.isPending && (
          <p role="status" className="text-sm text-muted-foreground">
            Loading…
          </p>
        )}
        {factor.isError && (
          <div className="space-y-3">
            <p role="alert" className="text-sm font-medium text-status-error">
              Your authenticator could not be checked. Please try again.
            </p>
            <Button variant="outline" onClick={() => void factor.refetch()}>
              Try again
            </Button>
          </div>
        )}
        {factor.isSuccess && factor.data && (
          <form onSubmit={(e) => void verify(e)} noValidate className="space-y-4">
            <FormField id="platform-mfa-code" label="Authentication code">
              {(a11y) => (
                <Input
                  {...a11y}
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={6}
                  autoComplete="one-time-code"
                  value={code}
                  disabled={busy}
                  onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, ''))}
                />
              )}
            </FormField>
            <FormError message={error} />
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? 'Verifying…' : 'Verify'}
            </Button>
          </form>
        )}
        {factor.isSuccess && !factor.data && (
          <div className="space-y-3">
            <p className="text-sm text-ink">Set up an authenticator app to continue.</p>
            <AuthenticatorEnroll onEnrolled={done} />
          </div>
        )}
      </div>
      <Button variant="outline" onClick={() => void signOut()}>
        Sign out
      </Button>
    </main>
  )
}
