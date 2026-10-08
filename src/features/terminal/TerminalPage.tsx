import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { pinPadIdleMs } from '@/lib/domain/session-timers'
import { fetchStaffRoster, RosterError, type RosterTile } from '@/lib/supabase/staff-roster'
import { isValidSlug } from '@/lib/utils/host'
import { clearKioskToken, getKioskToken } from '@/lib/utils/kiosk-token'
import { StaffTileGrid } from './StaffTileGrid'
import { TerminalPinEntry } from './TerminalPinEntry'
import { TerminalShell } from './TerminalShell'
import { TerminalUnauthorized } from './TerminalUnauthorized'
import { hostTenantSlug } from './terminal-paths'

/** Tenant slug for this page: the hostname first, then the `/r/:slug/terminal` dev/preview fallback. Pre-auth resolver only. */
function useTerminalSlug(): string | null {
  const { slug: param } = useParams<{ slug: string }>()
  const fromHost = hostTenantSlug()
  if (fromHost) return fromHost
  const candidate = param?.toLowerCase() ?? null
  return candidate && isValidSlug(candidate) ? candidate : null
}

/**
 * Shared floor terminal: staff tiles for a REGISTERED kiosk device. No stored token, or any invalid answer from the
 * roster, shows one neutral "not set up" screen (and forgets the token on 401); the reason is never revealed.
 */
export function TerminalPage() {
  const slug = useTerminalSlug()
  const navigate = useNavigate()
  const [token, setToken] = useState<string | null>(() => (slug ? getKioskToken(slug) : null))
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [returnFocusId, setReturnFocusId] = useState<string | null>(null)

  const roster = useQuery<{ staff: RosterTile[]; idleMs: number }, RosterError>({
    queryKey: ['staff-roster', slug],
    enabled: Boolean(slug && token),
    retry: false,
    staleTime: 0,
    gcTime: 0, // names of staff are not kept around once the terminal is left
    refetchOnWindowFocus: true, // picks up a revocation without polling
    queryFn: async () => {
      if (!slug || !token) throw new Error('unreachable')
      const res = await fetchStaffRoster({ restaurant_slug: slug, kiosk_token: token })
      // Throwing keeps the previous data in the cache, so a failed background refetch never discards tiles mid-entry.
      if (!res.ok) throw new RosterError(res.reason)
      // the tenant's PIN-pad idle timer (clamped 15..300 s, 60 s when the response has none)
      return { staff: res.staff, idleMs: pinPadIdleMs(res.pinPadIdleSeconds) }
    },
  })

  const removeSetup = () => {
    if (slug) clearKioskToken(slug)
    setToken(null)
    setSelectedId(null)
  }

  // A 401 never erases the stored token (a suspended tenant or a gateway 401 would otherwise wipe every terminal):
  // the same neutral screen is shown and a manual "Remove setup" is offered. Derived from the error, so no flash.
  const notRegistered = roster.error?.reason === 'invalid_kiosk'
  if (!slug || !token || notRegistered) {
    return <TerminalUnauthorized slug={slug} onRemoveSetup={slug && token ? removeSetup : undefined} />
  }

  if (!roster.data && roster.isPending) {
    return (
      <TerminalShell slug={slug}>
        <p role="status" className="pt-8 text-center text-sm text-muted-foreground">
          Loading…
        </p>
      </TerminalShell>
    )
  }

  if (!roster.data) {
    return (
      <TerminalShell slug={slug}>
        <section className="mx-auto max-w-md space-y-3 pt-8 text-center">
          <p role="alert" className="text-base text-muted-foreground">
            We could not load the team. Check the connection and try again.
          </p>
          <Button variant="outline" onClick={() => void roster.refetch()}>
            Try again
          </Button>
        </section>
      </TerminalShell>
    )
  }

  const staff = roster.data.staff
  const selected = staff.find((t) => t.id === selectedId) ?? null

  const back = () => {
    setReturnFocusId(selectedId)
    setSelectedId(null)
  }

  return (
    <TerminalShell slug={slug}>
      <div className="space-y-6">
        <h1 className="text-center text-xl font-semibold text-ink">Who is signing in?</h1>
        {staff.length === 0 ? (
          <p role="status" className="text-center text-base text-muted-foreground">
            No one is available on this terminal yet. Ask a manager.
          </p>
        ) : (
          <StaffTileGrid
            tiles={staff}
            selectedId={selected?.id ?? null}
            focusId={selected ? null : returnFocusId}
            onSelect={(id) => {
              setReturnFocusId(null)
              setSelectedId(id)
            }}
          />
        )}
        {selected && (
          <TerminalPinEntry
            key={selected.id}
            slug={slug}
            kioskToken={token}
            tile={selected}
            onCancel={back}
            idleMs={roster.data.idleMs}
            onSignedIn={() => navigate(`/r/${slug}`, { replace: true })}
          />
        )}
      </div>
    </TerminalShell>
  )
}
