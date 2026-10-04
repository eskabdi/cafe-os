import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
import { z } from 'zod'
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
import { RequirePermission, useAuth } from '@/features/auth'
import { listKiosks, registerKiosk, revokeKiosk, RpcError, type KioskDevice } from '@/lib/supabase/rpc'
import { clearKioskToken, getKioskToken, setKioskToken } from '@/lib/utils/kiosk-token'
import { kioskErrorMessage } from './kiosk-errors'
import { terminalPath } from './terminal-paths'

const nameSchema = z
  .string()
  .trim()
  .min(1, 'Enter a name for the terminal.')
  .max(60, 'Use at most 60 characters.')
const KIOSKS_KEY = ['kiosks'] as const
/** The one-time setup code disappears on its own after this long. */
export const TOKEN_VISIBLE_MS = 3 * 60_000

function when(iso: string | null | undefined): string {
  if (!iso) return 'Never'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? 'Never' : format(d, 'yyyy-MM-dd HH:mm')
}

function codeOf(e: unknown): string | undefined {
  return e instanceof RpcError ? e.code : undefined
}

/** Tenant settings > Terminals. Gate is UX only: fn_list/register/revoke_kiosk and RLS enforce kiosks.manage server-side. */
export function TerminalsPage() {
  return (
    <RequirePermission permission="kiosks.manage">
      <TerminalsContent />
    </RequirePermission>
  )
}

function TerminalsContent() {
  const { slug = '' } = useParams<{ slug: string }>()
  const { context } = useAuth()
  // Use the identity's own tenant for storage and links; the URL slug is only a fallback (never trusted for access).
  const tenantSlug = context?.restaurant?.slug ?? slug
  const qc = useQueryClient()

  const kiosks = useQuery({ queryKey: KIOSKS_KEY, queryFn: listKiosks })

  const [name, setName] = useState('')
  const [nameError, setNameError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  // The raw token lives only here (never in the query/mutation cache) until the admin dismisses it.
  const [issued, setIssued] = useState<{ name: string; token: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [deviceSet, setDeviceSet] = useState<boolean>(() => getKioskToken(tenantSlug) !== null)
  const [deviceNote, setDeviceNote] = useState<string | null>(null)
  const [toRevoke, setToRevoke] = useState<KioskDevice | null>(null)

  // Hides the code and, if it was copied, tries to overwrite the clipboard (best effort; may be refused by the browser).
  const dismissToken = useCallback(() => {
    setIssued(null)
    if (copied) {
      try {
        void navigator.clipboard.writeText('').catch(() => {})
      } catch {
        // clipboard unavailable
      }
    }
    setCopied(false)
  }, [copied])

  useEffect(() => {
    if (!issued) return
    const t = setTimeout(dismissToken, TOKEN_VISIBLE_MS)
    return () => clearTimeout(t)
  }, [issued, dismissToken])

  const register = useMutation({ mutationFn: (n: string) => registerKiosk(n) })
  const revoke = useMutation({ mutationFn: (id: string) => revokeKiosk(id) })

  const onRegister = async (e: FormEvent) => {
    e.preventDefault()
    setActionError(null)
    const parsed = nameSchema.safeParse(name)
    if (!parsed.success) {
      setNameError(parsed.error.issues[0]?.message ?? 'Enter a name for the terminal.')
      return
    }
    setNameError(null)
    try {
      const res = await register.mutateAsync(parsed.data)
      register.reset()
      setIssued({ name: res.name, token: res.token })
      setCopied(false)
      setDeviceNote(null)
      setName('')
      void qc.invalidateQueries({ queryKey: KIOSKS_KEY })
    } catch (err) {
      setActionError(kioskErrorMessage(codeOf(err)))
    }
  }

  const copy = async () => {
    if (!issued) return
    try {
      await navigator.clipboard.writeText(issued.token)
      setCopied(true)
    } catch {
      setDeviceNote('Copy is not available here. Use "Set this device up" on the terminal itself.')
    }
  }

  const setUpThisDevice = () => {
    if (!issued) return
    const ok = setKioskToken(tenantSlug, issued.token)
    setDeviceSet(ok)
    setDeviceNote(ok ? 'This device is now a terminal.' : 'This browser could not store the terminal setup.')
  }

  const confirmRevoke = async () => {
    if (!toRevoke) return
    setActionError(null)
    try {
      await revoke.mutateAsync(toRevoke.id)
      void qc.invalidateQueries({ queryKey: KIOSKS_KEY })
    } catch (err) {
      setActionError(kioskErrorMessage(codeOf(err)))
    } finally {
      setToRevoke(null)
    }
  }

  const removeFromDevice = () => {
    clearKioskToken(tenantSlug)
    setDeviceSet(false)
    setDeviceNote('This device is no longer a terminal.')
  }

  return (
    <main className="mx-auto max-w-2xl space-y-6 p-6">
      <header className="space-y-1">
        <Link className="text-sm text-ink underline underline-offset-4" to={`/r/${tenantSlug}`}>
          Back
        </Link>
        <h1 className="text-xl font-semibold text-ink">Terminals</h1>
        <p className="text-sm text-muted-foreground">
          Shared floor devices show staff tiles with a PIN pad. Register a terminal, then set it up on the
          device.
        </p>
      </header>

      <section
        aria-labelledby="register-title"
        className="space-y-3 rounded-card border border-line bg-white p-4"
      >
        <h2 id="register-title" className="text-base font-semibold text-ink">
          Register a terminal
        </h2>
        <form onSubmit={(e) => void onRegister(e)} className="space-y-3" noValidate>
          <div className="space-y-2">
            <Label htmlFor="terminal-name">Terminal name</Label>
            <Input
              id="terminal-name"
              value={name}
              maxLength={60}
              autoComplete="off"
              onChange={(e) => setName(e.target.value)}
              aria-invalid={nameError ? true : undefined}
              aria-describedby={nameError ? 'terminal-name-error' : undefined}
            />
            {nameError && (
              <p id="terminal-name-error" role="alert" className="text-sm font-medium text-status-error">
                {nameError}
              </p>
            )}
          </div>
          <Button type="submit" disabled={register.isPending}>
            {register.isPending ? 'Registering…' : 'Register terminal'}
          </Button>
        </form>
        {actionError && (
          <p role="alert" className="text-sm font-medium text-status-error">
            {actionError}
          </p>
        )}
      </section>

      {issued && (
        <section
          aria-labelledby="token-title"
          className="space-y-3 rounded-card border-2 border-ink bg-white p-4"
        >
          <h2 id="token-title" className="text-base font-semibold text-ink">
            Setup code for {issued.name}
          </h2>
          <p className="text-sm text-muted-foreground">
            This code is shown only once and hides itself after 3 minutes. Set up the terminal now, or copy it
            and enter it on the device. If it is lost, register a new terminal and revoke this one.
          </p>
          <code
            data-testid="kiosk-token"
            className="block break-all rounded-md border border-line bg-bg p-3 font-mono text-sm text-ink"
          >
            {issued.token}
          </code>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => void copy()}>
              {copied ? 'Copied' : 'Copy code'}
            </Button>
            <Button onClick={setUpThisDevice}>Set this device up</Button>
            <Button variant="ghost" onClick={dismissToken}>
              I have saved it
            </Button>
          </div>
        </section>
      )}

      {deviceNote && (
        <p role="status" className="text-sm text-ink">
          {deviceNote}
        </p>
      )}
      {deviceSet && (
        <section className="flex flex-wrap items-center gap-2 rounded-card border border-line bg-white p-4 text-sm">
          <span className="text-ink">This browser is set up as a terminal.</span>
          <Link className="text-ink underline underline-offset-4" to={terminalPath(tenantSlug)}>
            Open the terminal
          </Link>
          <Button variant="ghost" size="sm" onClick={removeFromDevice}>
            Remove from this device
          </Button>
        </section>
      )}

      <section aria-labelledby="list-title" className="space-y-3">
        <h2 id="list-title" className="text-base font-semibold text-ink">
          Registered terminals
        </h2>
        {kiosks.isPending && (
          <p role="status" className="text-sm text-muted-foreground">
            Loading…
          </p>
        )}
        {kiosks.isError && (
          <p role="alert" className="text-sm font-medium text-status-error">
            {kioskErrorMessage(codeOf(kiosks.error))}
          </p>
        )}
        {kiosks.data && kiosks.data.length === 0 && (
          <p className="text-sm text-muted-foreground">No terminals registered yet.</p>
        )}
        {kiosks.data && kiosks.data.length > 0 && (
          <ul className="divide-y divide-line rounded-card border border-line bg-white">
            {kiosks.data.map((k) => (
              <li key={k.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                <div className="min-w-0 space-y-0.5">
                  <p className="break-words font-medium text-ink">{k.name}</p>
                  <p className="text-sm text-muted-foreground">
                    Registered {when(k.created_at)} · Last seen {when(k.last_seen_at)}
                  </p>
                  {k.revoked_at && (
                    <p className="text-sm font-medium text-status-cancelled">Revoked {when(k.revoked_at)}</p>
                  )}
                </div>
                {!k.revoked_at && (
                  <Button variant="outline" onClick={() => setToRevoke(k)} aria-label={`Revoke ${k.name}`}>
                    Revoke
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <Dialog open={toRevoke !== null} onOpenChange={(open) => !open && setToRevoke(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke this terminal?</DialogTitle>
            <DialogDescription>
              {toRevoke?.name} will stop working the next time it loads or signs someone in. This cannot be
              undone; register a new terminal to replace it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setToRevoke(null)}>
              Cancel
            </Button>
            <Button onClick={() => void confirmRevoke()} disabled={revoke.isPending}>
              Revoke terminal
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  )
}
