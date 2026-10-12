import type { ReactNode } from 'react'
import { Outlet, useParams } from 'react-router-dom'
import { useAuth } from '@/features/auth'
import { tenantHomePath } from '@/features/pin-change/pin-paths'
import { canOpenModule, canOpenStation } from '@/lib/domain/navigation'
import { ForbiddenState } from './states'

// Route guards for the tenant shell. UX only: they decide what to render. RLS and the security-definer RPC checks are the
// authorization ceiling, so a bypassed guard exposes no data.

/** Renders the route only when the session context holds `permission`; otherwise an in-shell 403 page. */
export function RequireNavPermission({
  permission,
  anyOf,
  children,
}: {
  permission: string
  /** Further codes that also open the route (any of them), mirroring the nav entry's `alsoPermissions`. */
  anyOf?: readonly string[]
  children?: ReactNode
}) {
  const { can, context } = useAuth()
  const slug = context?.restaurant?.slug ?? ''
  if (!canOpenModule({ permission, alsoPermissions: anyOf }, can))
    return <ForbiddenState homePath={tenantHomePath(slug)} />
  return <>{children ?? <Outlet />}</>
}

/** Station board guard: board permission + station access for `:stationId` (role_station_access; tenant_admin: all). */
export function RequireStationAccess({ children }: { children?: ReactNode }) {
  const { stationId } = useParams<{ stationId: string }>()
  const { can, context } = useAuth()
  const slug = context?.restaurant?.slug ?? ''
  if (!canOpenStation(stationId, { stationIds: context?.station_ids ?? [], can })) {
    return <ForbiddenState homePath={tenantHomePath(slug)} />
  }
  return <>{children ?? <Outlet />}</>
}
