import type { ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import { Home, KeyRound, ShieldCheck, Timer, UserCheck, type LucideIcon } from 'lucide-react'
import { useAuth } from '@/features/auth'
import {
  changePinPath,
  pinApprovalsPath,
  securityPath,
  sessionTimersPath,
  tenantHomePath,
} from '@/features/pin-change/pin-paths'
import { useStations } from '@/features/stations/useStations'
import { iconForSlug } from '@/features/terminal/tile-icons'
import { usesSupabaseAuthSignIn } from '@/lib/domain/authenticator'
import { accountLinkIds, groupModules, visibleModules, type AccountLinkId } from '@/lib/domain/navigation'
import { pinChangeStatusOf } from '@/lib/domain/pin-change'
import { tileStyle } from '@/lib/domain/tile-style'
import { cn } from '@/lib/utils/cn'
import { DEFAULT_STATION_ICON, GROUP_LABELS, MODULE_NAV } from './nav-config'
import { modulePath, stationPath } from './paths'
import { NavSkeleton } from './states'

const linkClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    'flex min-h-[44px] items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
    isActive ? 'bg-primary/10 text-primary' : 'text-ink hover:bg-accent',
  )

const ACCOUNT_LINKS: Readonly<
  Record<AccountLinkId, { label: string; icon: LucideIcon; path: (slug: string) => string }>
> = {
  'change-pin': { label: 'Change PIN', icon: KeyRound, path: changePinPath },
  'pin-approvals': { label: 'PIN approvals', icon: UserCheck, path: pinApprovalsPath },
  'session-timers': { label: 'Session timers', icon: Timer, path: sessionTimersPath },
  security: { label: 'Security', icon: ShieldCheck, path: securityPath },
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <h2 className="px-3 pt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>
      <ul className="space-y-1">{children}</ul>
    </div>
  )
}

function StationLinks({ slug, onNavigate }: { slug: string; onNavigate?: () => void }) {
  const { stations, status, retry } = useStations()
  if (status === 'idle') return null
  return (
    <Section title="Stations">
      {status === 'loading' && (
        <li>
          <NavSkeleton rows={2} label="Loading stations" />
        </li>
      )}
      {status === 'error' && (
        <li className="space-y-1 px-3 text-sm">
          <p role="alert" className="text-muted-foreground">
            Stations could not be loaded.
          </p>
          <button
            type="button"
            onClick={retry}
            className="min-h-[44px] font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Try again
          </button>
        </li>
      )}
      {status === 'ready' && stations.length === 0 && (
        <li className="px-3 py-2 text-sm text-muted-foreground">No stations assigned to you.</li>
      )}
      {status === 'ready' &&
        stations.map((s) => {
          const Icon = iconForSlug(s.icon, DEFAULT_STATION_ICON)
          const chip = tileStyle(s.color)
          return (
            <li key={s.id}>
              <NavLink to={stationPath(slug, s.id)} className={linkClass} onClick={onNavigate}>
                <span
                  aria-hidden="true"
                  className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
                  style={{ backgroundColor: chip.background, color: chip.foreground }}
                >
                  <Icon className="h-4 w-4" />
                </span>
                <span className="truncate">{s.name}</span>
              </NavLink>
            </li>
          )
        })}
    </Section>
  )
}

/**
 * The tenant navigation, generated from MODULE_NAV (permission-keyed) plus the tenant's station rows. Rendered in the
 * desktop sidebar and in the mobile drawer. UX only: every page re-checks on the server.
 */
export function ShellNav({ slug, onNavigate }: { slug: string; onNavigate?: () => void }) {
  const { context, can, session } = useAuth()
  const status = pinChangeStatusOf(context)
  const groups = groupModules(visibleModules(MODULE_NAV, can))
  const account = accountLinkIds({ status, can, supabaseAuthSession: usesSupabaseAuthSignIn(session) })

  return (
    <nav aria-label="Main" className="space-y-2 p-2">
      <ul>
        <li>
          <NavLink to={tenantHomePath(slug)} end className={linkClass} onClick={onNavigate}>
            <Home aria-hidden="true" className="h-5 w-5 shrink-0" />
            Home
          </NavLink>
        </li>
      </ul>
      {groups.map(({ group, items }) => (
        <Section key={group} title={GROUP_LABELS[group]}>
          {items.map((m) => (
            <li key={m.id}>
              <NavLink to={modulePath(slug, m.segment)} className={linkClass} onClick={onNavigate}>
                <m.icon aria-hidden="true" className="h-5 w-5 shrink-0" />
                {m.label}
              </NavLink>
            </li>
          ))}
        </Section>
      ))}
      <StationLinks slug={slug} onNavigate={onNavigate} />
      {account.length > 0 && (
        <Section title="Account">
          {account.map((id) => {
            const link = ACCOUNT_LINKS[id]
            return (
              <li key={id}>
                <NavLink to={link.path(slug)} className={linkClass} onClick={onNavigate}>
                  <link.icon aria-hidden="true" className="h-5 w-5 shrink-0" />
                  {link.label}
                </NavLink>
              </li>
            )
          })}
        </Section>
      )}
    </nav>
  )
}
