import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/features/auth'
import { usesSupabaseAuthSignIn } from '@/lib/domain/authenticator'
import { supabase } from '@/lib/supabase/client'
import { AuthenticatorEnroll } from './AuthenticatorEnroll'
import { AUTHENTICATOR_MESSAGES } from './authenticator-errors'
import {
  AUTHENTICATOR_FACTORS_KEY,
  listAuthenticators,
  type AuthenticatorFactor,
} from './authenticator-factors'
import { RemoveAuthenticatorDialog } from './RemoveAuthenticatorDialog'

function addedOn(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString('en-GB')
}

/**
 * Tenant settings > Security: self-service authenticator (TOTP) setup for accounts that sign in with email and password
 * (in practice the tenant admin: only tenant_admin accounts use email and password). PIN sessions never see it. Gate is UX only: Supabase Auth decides who can
 * enrol, and the database re-checks the verified session on every command that needs it.
 */
export function SecurityPage() {
  const { session, context, refreshContext } = useAuth()
  const slug = context?.restaurant?.slug ?? ''
  const qc = useQueryClient()
  const eligible = usesSupabaseAuthSignIn(session)
  const [removing, setRemoving] = useState<AuthenticatorFactor | null>(null)

  const factors = useQuery({
    queryKey: AUTHENTICATOR_FACTORS_KEY,
    queryFn: listAuthenticators,
    enabled: eligible,
  })

  // After a factor is added or removed: pick up the new session (so the token reflects the verification), reload the
  // server-derived context and the factor list.
  const afterChange = async (message: string) => {
    try {
      await supabase.auth.refreshSession()
    } catch {
      // the previous session stays valid; the list below still reflects the change
    }
    refreshContext()
    await qc.invalidateQueries({ queryKey: AUTHENTICATOR_FACTORS_KEY })
    toast.success(message)
  }

  if (!eligible) {
    return (
      <main className="mx-auto max-w-2xl space-y-3 p-6">
        <h1 className="text-xl font-semibold text-ink">Security</h1>
        <p role="alert" className="text-sm text-muted-foreground">
          This page is only available to accounts that sign in with an email address and password.
        </p>
        <Link className="text-sm text-ink underline underline-offset-4" to={`/r/${slug}`}>
          Back
        </Link>
      </main>
    )
  }

  const list = factors.data ?? []

  return (
    <main className="mx-auto max-w-2xl space-y-6 p-6">
      <header className="space-y-1">
        <Link className="text-sm text-ink underline underline-offset-4" to={`/r/${slug}`}>
          Back
        </Link>
        <h1 className="text-xl font-semibold text-ink">Security</h1>
        <p className="text-sm text-muted-foreground">
          An authenticator app on your phone gives you a short code that proves it is you. It is needed to
          approve PIN changes and to change the session timers.
        </p>
      </header>

      {factors.isPending && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading…
        </p>
      )}
      {factors.isError && (
        <div className="space-y-2">
          <p role="alert" className="text-sm font-medium text-status-error">
            {AUTHENTICATOR_MESSAGES.loadFailed}
          </p>
          <Button variant="outline" onClick={() => void factors.refetch()}>
            Try again
          </Button>
        </div>
      )}

      {factors.isSuccess && (
        <section
          aria-labelledby="authenticators-heading"
          className="space-y-4 rounded-card border border-line bg-white p-5"
        >
          <h2 id="authenticators-heading" className="text-base font-semibold text-ink">
            Authenticator app
          </h2>
          {list.length > 0 ? (
            <ul className="divide-y divide-line">
              {list.map((f) => {
                const date = addedOn(f.createdAt)
                return (
                  <li key={f.id} className="flex flex-wrap items-center gap-3 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-ink">{f.name}</p>
                      <p className="text-sm text-muted-foreground">
                        <span className="font-medium text-status-success">Active</span>
                        {date ? ` · Added ${date}` : ''}
                      </p>
                    </div>
                    <Button variant="outline" onClick={() => setRemoving(f)}>
                      Remove
                    </Button>
                  </li>
                )
              })}
            </ul>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                No authenticator is set up for this account yet. Set one up now.
              </p>
              <AuthenticatorEnroll onEnrolled={() => afterChange('Authenticator set up')} />
            </>
          )}
        </section>
      )}

      <RemoveAuthenticatorDialog
        factor={removing}
        onCancel={() => setRemoving(null)}
        onRemoved={async () => {
          setRemoving(null)
          await afterChange('Authenticator removed')
        }}
      />
    </main>
  )
}
