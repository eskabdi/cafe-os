import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { fetchStaffRoster, type RosterResult } from '@/lib/supabase/staff-roster'
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

  const roster = useQuery<RosterResult>({
    queryKey: ['staff-roster', slug],
    enabled: Boolean(slug && token),
    retry: false,
    staleTime: 0,
    gcTime: 0, // names of staff are not kept around once the terminal is left
    refetchOnWindowFocus: true, // picks up a revocation without polling
    queryFn: () => {
      if (!slug || !token) throw new Error('unreachable')
      return fetchStaffRoster({ restaurant_slug: slug, kiosk_token: token })
    },
  })

  const invalid = roster.data && !roster.data.ok && roster.data.reason === 'invalid_kiosk'
  useEffect(() => {
    if (invalid && slug) {
      clearKioskToken(slug)
      setToken(null)
      setSelectedId(null)
    }
  }, [invalid, slug])

  if (!slug || !token) return <TerminalUnauthorized slug={slug} />

  if (roster.isPending) {
    return (
      <TerminalShell slug={slug}>
        <p role="status" className="pt-8 text-center text-sm text-muted-foreground">
          Loading…
        </p>
      </TerminalShell>
    )
  }

  if (roster.isError || !roster.data || !roster.data.ok) {
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
            onSignedIn={() => navigate(`/r/${slug}`, { replace: true })}
          />
        )}
      </div>
    </TerminalShell>
  )
}
