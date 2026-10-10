import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { FormError, FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { useAuth } from '@/features/auth'
import { formatDateTime } from '@/lib/domain/portal'
import { supabase } from '@/lib/supabase/client'
import { portalErrorMessage } from '@/lib/supabase/portal-errors'
import { acceptTenantAdminInvitation, getMyInvitation } from '@/lib/supabase/tenant-admin'

const TOKEN_HASH_RE = /^[A-Za-z0-9_-]{16,256}$/
const LINK_TYPES = ['invite', 'magiclink', 'email'] as const
type LinkType = (typeof LINK_TYPES)[number]
export const MIN_PASSWORD = 12

/** Reads ?token_hash=&type= once and removes them from the address bar (the token must not stay in history). */
function takeLinkParams(): { tokenHash: string; type: LinkType } | null {
  const params = new URLSearchParams(window.location.search)
  const tokenHash = params.get('token_hash') ?? ''
  const type = params.get('type') ?? ''
  if (params.has('token_hash')) window.history.replaceState(null, '', window.location.pathname)
  if (!TOKEN_HASH_RE.test(tokenHash) || !(LINK_TYPES as readonly string[]).includes(type)) return null
  return { tokenHash, type: type as LinkType }
}

export function passwordProblem(pw: string, confirm: string): string | null {
  if (pw.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`
  if (pw.length > 72) return 'Use at most 72 characters.'
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) return 'Use letters and at least one digit.'
  if (pw !== confirm) return 'The two passwords differ.'
  return null
}

/**
 * /invite: the invitee arrives from the invitation e-mail (link carries a one-time token hash). The page signs them in with it
 * (verifyOtp), shows where they are invited, lets them choose a password and accepts (fn_accept_tenant_admin_invitation binds
 * the account as that restaurant's Tenant Admin). Next step: set up the authenticator app on the Security page.
 */
export function AcceptInvitationPage() {
  const { status, refreshContext } = useAuth()
  const navigate = useNavigate()
  const link = useRef(takeLinkParams())
  const [linkState, setLinkState] = useState<'verifying' | 'done' | 'failed'>(link.current ? 'verifying' : 'done')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const l = link.current
    if (!l) return
    link.current = null
    void supabase.auth
      .verifyOtp({ token_hash: l.tokenHash, type: l.type })
      .then(({ error: e }) => setLinkState(e ? 'failed' : 'done'))
      .catch(() => setLinkState('failed'))
  }, [])

  const signedIn = status === 'authenticated'
  const invitation = useQuery({
    queryKey: ['my-invitation'],
    queryFn: getMyInvitation,
    enabled: signedIn && linkState === 'done',
    retry: false,
  })

  const accept = async (e: FormEvent) => {
    e.preventDefault()
    const problem = passwordProblem(password, confirm)
    if (problem) return setError(problem)
    setBusy(true)
    setError(null)
    try {
      const { error: pwError } = await supabase.auth.updateUser({ password })
      if (pwError) {
        setError('The password could not be saved. Choose another one.')
        return
      }
      const r = await acceptTenantAdminInvitation()
      setPassword('')
      setConfirm('')
      refreshContext()
      navigate(`/r/${r.slug}/settings/security`, { replace: true })
    } catch (err) {
      setError(portalErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  let body: React.ReactNode
  if (linkState === 'verifying' || status === 'loading' || (signedIn && invitation.isPending)) {
    body = <p role="status" className="text-sm text-muted-foreground">Checking your invitation…</p>
  } else if (linkState === 'failed') {
    body = <p role="alert" className="text-sm text-status-error">This invitation link is invalid or has already been used. Ask for a new invitation.</p>
  } else if (!signedIn) {
    body = <p className="text-sm text-muted-foreground">Open the link in your invitation e-mail to continue.</p>
  } else if (invitation.isError) {
    body = <p role="alert" className="text-sm text-status-error">The invitation could not be loaded. Reload the page.</p>
  } else if (!invitation.data) {
    body = <p className="text-sm text-muted-foreground">There is no open invitation for this account.</p>
  } else if (invitation.data.expired) {
    body = <p role="alert" className="text-sm text-status-error">This invitation has expired. Ask your administrator to send a new one.</p>
  } else {
    const inv = invitation.data
    body = (
      <form onSubmit={(e) => void accept(e)} className="space-y-4" noValidate>
        <p className="text-sm text-ink">
          You are invited as <strong>Tenant Admin</strong> of <strong>{inv.restaurant.name}</strong> (username {inv.username}). The
          invitation is valid until {formatDateTime(inv.expires_at)}.
        </p>
        <FormField id="inv-pw" label="Choose a password" hint={`At least ${MIN_PASSWORD} characters, letters and a digit.`}>
          {(a) => <Input {...a} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
        </FormField>
        <FormField id="inv-pw2" label="Repeat the password">
          {(a) => <Input {...a} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />}
        </FormField>
        <FormError message={error} />
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? 'Accepting…' : 'Accept invitation'}
        </Button>
        <p className="text-xs text-muted-foreground">Next you will set up an authenticator app; it is required for administrators.</p>
      </form>
    )
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-6">
      <header className="space-y-1 text-center">
        <p className="text-2xl font-bold text-ink">
          Cafe<span className="text-primary">OS</span>
        </p>
        <h1 className="text-lg font-semibold text-ink">Accept your invitation</h1>
      </header>
      <div className="rounded-card border border-line bg-white p-5 shadow-sm">{body}</div>
    </main>
  )
}
