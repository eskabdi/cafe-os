import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  authenticatorNameSchema,
  DEFAULT_AUTHENTICATOR_NAME,
  formatSetupKey,
  qrImageSrc,
  totpCodeSchema,
} from '@/lib/domain/authenticator'
import { supabase } from '@/lib/supabase/client'
import { AUTHENTICATOR_MESSAGES, authenticatorErrorMessage, verifyErrorMessage } from './authenticator-errors'
import { listUnfinishedAuthenticatorIds } from './authenticator-factors'

/** The secret lives only in this state: never logged, stored, cached or put in the query cache. */
interface Pending {
  factorId: string
  secret: string
  qrSrc: string | null
}

export interface AuthenticatorEnrollProps {
  /** Called once the new authenticator is verified, after this component has dropped the secret. */
  onEnrolled: () => Promise<void> | void
}

async function discardUnverified(factorId: string) {
  try {
    await supabase.auth.mfa.unenroll({ factorId })
  } catch {
    // best effort: an abandoned, unverified factor grants nothing and is cleaned up on the next setup
  }
}

/** Set up an authenticator app: name -> QR + setup key -> 6-digit code. Supabase Auth issues and verifies the factor. */
export function AuthenticatorEnroll({ onEnrolled }: AuthenticatorEnrollProps) {
  const [name, setName] = useState(DEFAULT_AUTHENTICATOR_NAME)
  const [pending, setPending] = useState<Pending | null>(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const pendingId = useRef<string | null>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      // leaving the page mid-setup drops the secret with the state and removes the unfinished factor
      if (pendingId.current) void discardUnverified(pendingId.current)
      pendingId.current = null
    }
  }, [])

  const start = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    const parsedName = authenticatorNameSchema.safeParse(name)
    if (!parsedName.success) {
      setError(AUTHENTICATOR_MESSAGES.name)
      return
    }
    setBusy(true)
    setError(null)
    try {
      // an abandoned earlier attempt would hold the name (and a stale secret): remove it first
      for (const id of await listUnfinishedAuthenticatorIds()) await discardUnverified(id)
      const { data, error: enrollError } = await supabase.auth.mfa.enroll({
        factorType: 'totp',
        friendlyName: parsedName.data,
      })
      if (enrollError || !data) {
        setError(authenticatorErrorMessage(enrollError))
        return
      }
      if (!alive.current) {
        await discardUnverified(data.id)
        return
      }
      pendingId.current = data.id
      setPending({ factorId: data.id, secret: data.totp.secret, qrSrc: qrImageSrc(data.totp.qr_code) })
      setCode('')
      setCopied(false)
    } catch {
      setError(AUTHENTICATOR_MESSAGES.generic)
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  const cancel = async () => {
    const id = pendingId.current
    pendingId.current = null
    setPending(null)
    setCode('')
    setError(null)
    if (id) await discardUnverified(id)
  }

  const verify = async (e: FormEvent) => {
    e.preventDefault()
    if (busy || !pending) return
    if (!totpCodeSchema.safeParse(code).success) {
      setError(AUTHENTICATOR_MESSAGES.code)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({
        factorId: pending.factorId,
        code,
      })
      setCode('')
      if (verifyError) {
        setError(verifyErrorMessage(verifyError))
        return
      }
      // verified: forget the secret before anything else happens
      pendingId.current = null
      setPending(null)
      await onEnrolled()
    } catch {
      setError(AUTHENTICATOR_MESSAGES.generic)
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  const copySecret = async () => {
    if (!pending) return
    try {
      await navigator.clipboard.writeText(pending.secret)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  const errorEl = error && (
    <p id="authenticator-error" role="alert" className="text-sm font-medium text-status-error">
      {error}
    </p>
  )

  if (!pending) {
    return (
      <form onSubmit={(e) => void start(e)} noValidate className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="authenticator-name">Name</Label>
          <Input
            id="authenticator-name"
            maxLength={40}
            autoComplete="off"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-invalid={error === AUTHENTICATOR_MESSAGES.name ? true : undefined}
            aria-describedby={error ? 'authenticator-error' : undefined}
          />
          <p className="text-xs text-muted-foreground">Helps you tell your authenticators apart.</p>
        </div>
        {errorEl}
        <Button type="submit" disabled={busy}>
          {busy ? 'Starting…' : 'Set up authenticator'}
        </Button>
      </form>
    )
  }

  return (
    <form onSubmit={(e) => void verify(e)} noValidate className="space-y-5">
      <ol className="list-decimal space-y-1 pl-5 text-sm text-ink">
        <li>Open your authenticator app and add an account.</li>
        <li>Scan the picture below, or type the setup key.</li>
        <li>Enter the 6-digit code the app shows.</li>
      </ol>

      {pending.qrSrc && (
        <img
          src={pending.qrSrc}
          alt="Setup picture to scan with your authenticator app"
          width={192}
          height={192}
          className="h-48 w-48 rounded-md border border-line bg-white p-2"
        />
      )}

      <div className="space-y-1.5">
        <Label htmlFor="authenticator-key">Setup key</Label>
        <div className="flex flex-wrap items-center gap-2">
          <code
            id="authenticator-key"
            data-testid="authenticator-key"
            className="select-all break-all rounded-md border border-line bg-bg px-3 py-2 font-mono text-sm tracking-wider text-ink"
          >
            {formatSetupKey(pending.secret)}
          </code>
          <Button type="button" variant="outline" onClick={() => void copySecret()}>
            Copy key
          </Button>
          <span role="status" aria-live="polite" className="text-sm text-muted-foreground">
            {copied ? 'Copied' : ''}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          Keep this key private. It is not shown again after setup.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="authenticator-code">Authentication code</Label>
        <Input
          id="authenticator-code"
          name="totp"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={6}
          autoComplete="one-time-code"
          className="max-w-[10rem]"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, ''))}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'authenticator-error' : undefined}
        />
      </div>
      {errorEl}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy}>
          {busy ? 'Verifying…' : 'Verify and finish'}
        </Button>
        <Button type="button" variant="outline" disabled={busy} onClick={() => void cancel()}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
