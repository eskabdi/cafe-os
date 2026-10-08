import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/features/auth'
import { STATION_BOARD_PERMISSION, visibleStations } from '@/lib/domain/navigation'
import { fetchActiveStations, stationsKey, subscribeToStations } from '@/lib/supabase/stations'
import { StationsContext, type StationsState } from './useStations'

/** Bursts of Realtime events collapse into one session-context reload after this quiet period. */
export const CONTEXT_REFRESH_DEBOUNCE_MS = 300

/**
 * Active stations of the signed-in tenant (RLS-scoped read), filtered to the stations the user holds access to. Mounted
 * once in AppShell so there is a single query and a single Realtime channel. A stations change invalidates the query AND
 * (coalesced) reloads the session context, because station_ids lives there; a role_station_access change only reloads it.
 * Only fetched when the user holds the board permission.
 */
export function StationsProvider({ children }: { children: ReactNode }) {
  const { context, can, refreshContext } = useAuth()
  const restaurantId = context?.restaurant?.id
  const roleId = context?.role?.id
  const enabled = Boolean(restaurantId) && can(STATION_BOARD_PERMISSION)
  const qc = useQueryClient()

  const query = useQuery({
    queryKey: stationsKey(restaurantId ?? ''),
    queryFn: fetchActiveStations,
    enabled,
  })

  const refreshRef = useRef(refreshContext)
  useEffect(() => {
    refreshRef.current = refreshContext
  }, [refreshContext])

  useEffect(() => {
    if (!enabled || !restaurantId || !roleId) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const scheduleRefresh = () => {
      clearTimeout(timer)
      timer = setTimeout(() => refreshRef.current(), CONTEXT_REFRESH_DEBOUNCE_MS)
    }
    const unsubscribe = subscribeToStations(restaurantId, roleId, {
      onStationsChange: () => {
        void qc.invalidateQueries({ queryKey: stationsKey(restaurantId) })
        scheduleRefresh()
      },
      onAccessChange: scheduleRefresh,
    })
    return () => {
      clearTimeout(timer)
      unsubscribe()
    }
  }, [enabled, restaurantId, roleId, qc])

  const stationIds = context?.station_ids
  const stations = useMemo(
    () => visibleStations(query.data ?? [], { stationIds: stationIds ?? [], can }),
    [query.data, stationIds, can],
  )

  const { refetch } = query
  const value = useMemo<StationsState>(
    () => ({
      stations,
      status: !enabled ? 'idle' : query.isPending ? 'loading' : query.isError ? 'error' : 'ready',
      retry: () => void refetch(),
    }),
    [stations, enabled, query.isPending, query.isError, refetch],
  )
  return <StationsContext.Provider value={value}>{children}</StationsContext.Provider>
}
