import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { FormError, FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { LOGIN_NOTICES, useAuth, type LoginNoticeKey } from '@/features/auth'
import { PASSWORD_HINT, passwordProblem } from '@/lib/domain/password'
import { supabase } from '@/lib/supabase/client'
import { getSessionContext } from '@/lib/supabase/rpc'
import { parseRecoveryLink, takeRecoveryLink } from './recovery-link'

type LinkState = 'verifying' | 'ready' | 'expired' | 'invalid' | 'none' | 'done'

const PASSWORD_CHANGED: LoginNoticeKey = 'password_changed'
const PASSWORD_CHANGED_SIGNOUT_UNCONFIRMED: LoginNoticeKey = 'password_changed_signout_unconfirmed'

const MESSAGES = {
  expired:
    'This link has expired or has already been used. Ask the platform administrator to resend the recovery email.',
  invalid:
    'This is not a valid password-reset link. Open the link in the most recent e-mail, or ask the platform administrator to resend the recovery email.',
  none: 'Open the link in the password-reset e-mail to continue.',
  rateLimited: 'Too many attempts. Wait a few minutes and try again.',
  samePassword: 'Choose a password you have not used for this account before.',
  weak: 'This password is too weak or too common. Choose a longer, less predictable one.',
  generic: 'The password could not be saved. Try again.',
} as const

const SESSION_GONE_CODES = new Set([
  'session_not_found',
  'session_expired',
  'bad_jwt',
  'user_not_found',
  'refresh_token_not_found',
])

/** Maps an updateUser error to a fixed message, or to 'expired' when the recovery session is no longer valid. */
export function updatePasswordOutcome(error: { status?: number; code?: string }): 'expired' | string {
  if (error.status === 401 || error.status === 403 || (error.code && SESSION_GONE_CODES.has(error.code)))
    return 'expired'
  if (error.status === 429 || error.code === 'over_request_rate_limit') return MESSAGES.rateLimited
  if (error.code === 'same_password') return MESSAGES.samePassword
  if (error.code === 'weak_password') return MESSAGES.weak
  return MESSAGES.generic
}

function initialState(): LinkState {
  const link = parseRecoveryLink(window.location.hash, window.location.search)
  return link.kind === 'session' ? 'verifying' : link.kind
}

/**
 * Signs out every session of the account; if GoTrue refuses the global sign-out, at least this browser is signed out. Returns
 * whether the GLOBAL sign-out was confirmed (false: the page warns, without blocking).
 */
async function signOutEverywhere(): Promise<boolean> {
  try {
    const { error } = await supabase.auth.signOut({ scope: 'global' })
    if (!error) return true
  } catch {
    // fall through to the local sign-out
  }
  await supabase.auth.signOut({ scope: 'local' }).catch(() => undefined)
  return false
}

/**
 * /reset-password: landing page of the password-recovery e-mail sent after a Super Admin reset a Tenant Admin's authenticator
 * (Edge Function tenant-admin-mfa-reset, RECOVERY_REDIRECT_URL). The page takes the recovery session from the link (implicit
 * flow, `type=recovery` only), lets the person choose a new password (updateUser), signs the account out everywhere and sends
 * them to their restaurant's admin sign-in, where they set up the authenticator again. The password is never logged or stored.
 */
export function ResetPasswordPage() {
  const { status, context } = useAuth()
  const navigate = useNavigate()
  const [linkState, setLinkState] = useState<LinkState>(initialState)
  const started = useRef(false)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [signOutConfirmed, setSignOutConfirmed] = useState(true)

  useEffect(() => {
    if (started.current) return
    started.current = true
    const link = takeRecoveryLink() // also removes the tokens from the address bar
    if (link.kind !== 'session') return
    void supabase.auth
      .setSession({ access_token: link.accessToken, refresh_token: link.refreshToken })
      .then(({ error: e }) => setLinkState(e ? 'expired' : 'ready'))
      .catch(() => setLinkState('expired'))
  }, [])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    const problem = passwordProblem(password, confirm)
    if (problem) return setError(problem)
    setBusy(true)
    setError(null)
    try {
      const { error: pwError } = await supabase.auth.updateUser({ password })
      if (pwError) {
        const outcome = updatePasswordOutcome(pwError)
        if (outcome === 'expired') setLinkState('expired')
        else setError(outcome)
        return
      }
      setPassword('')
      setConfirm('')
      // where to sign in again: the restaurant of this (server-derived) identity, read before the session ends
      let slug = context?.restaurant?.slug ?? null
      if (!slug) slug = (await getSessionContext().catch(() => null))?.restaurant?.slug ?? null
      const everywhere = await signOutEverywhere()
      setSignOutConfirmed(everywhere)
      setLinkState('done')
      if (slug) {
        navigate(`/r/${encodeURIComponent(slug)}/admin-login`, {
          replace: true,
          state: { notice: everywhere ? PASSWORD_CHANGED : PASSWORD_CHANGED_SIGNOUT_UNCONFIRMED },
        })
      }
    } catch {
      setError(MESSAGES.generic)
    } finally {
      setBusy(false)
    }
  }

  let body: ReactNode
  if (linkState === 'done') {
    // only reached when no restaurant could be resolved (with one, the page has already moved to its admin sign-in)
    body = (
      <div className="space-y-3">
        <p role="status" className="text-sm text-ink">
          {LOGIN_NOTICES[signOutConfirmed ? PASSWORD_CHANGED : PASSWORD_CHANGED_SIGNOUT_UNCONFIRMED]}
        </p>
        <p className="text-sm text-muted-foreground">
          Sign in on your restaurant&apos;s admin sign-in page: the CafeOS address you normally use, of the
          form /r/&lt;your restaurant&gt;/admin-login. If you do not have it, ask the platform administrator
          for it.
        </p>
        <Button asChild variant="outline" className="w-full">
          <Link to="/">Go to the start page</Link>
        </Button>
      </div>
    )
  } else if (linkState === 'verifying' || (linkState === 'ready' && status === 'loading')) {
    body = (
      <p role="status" className="text-sm text-muted-foreground">
        Checking your link…
      </p>
    )
  } else if (linkState === 'expired' || (linkState === 'ready' && status === 'signed_out')) {
    body = (
      <p role="alert" className="text-sm text-status-error">
        {MESSAGES.expired}
      </p>
    )
  } else if (linkState === 'invalid') {
    body = (
      <p role="alert" className="text-sm text-status-error">
        {MESSAGES.invalid}
      </p>
    )
  } else if (linkState === 'none') {
    body = <p className="text-sm text-muted-foreground">{MESSAGES.none}</p>
  } else {
    body = (
      <form onSubmit={(ev) => void submit(ev)} className="space-y-4" noValidate>
        <p className="text-sm text-ink">
          The platform administrator reset your authenticator, so your old password no longer works. Choose a
          new password. After that you are signed out on every device; sign in again and set up your
          authenticator app.
        </p>
        <FormField id="reset-pw" label="New password" hint={PASSWORD_HINT}>
          {(a) => (
            <Input
              {...a}
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(ev) => setPassword(ev.target.value)}
            />
          )}
        </FormField>
        <FormField id="reset-pw2" label="Repeat the new password">
          {(a) => (
            <Input
              {...a}
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(ev) => setConfirm(ev.target.value)}
            />
          )}
        </FormField>
        <FormError message={error} />
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? 'Saving…' : 'Save new password'}
        </Button>
      </form>
    )
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-6">
      <header className="space-y-1 text-center">
        <p className="text-2xl font-bold text-ink">
          Cafe<span className="text-primary">OS</span>
        </p>
        <h1 className="text-lg font-semibold text-ink">Set a new password</h1>
        <p className="text-sm text-muted-foreground">
          After an authenticator reset by the platform administrator
        </p>
      </header>
      <div className="rounded-card border border-line bg-white p-5 shadow-sm">{body}</div>
    </main>
  )
}
