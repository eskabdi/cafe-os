import { useEffect, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/features/auth'
import { STATION_BOARD_PERMISSION, visibleStations } from '@/lib/domain/navigation'
import {
  fetchActiveStations,
  stationsKey,
  subscribeToStations,
  type StationRow,
} from '@/lib/supabase/stations'

export interface StationsState {
  /** Active stations the user may open (station access + board permission), ordered for display. */
  stations: StationRow[]
  status: 'idle' | 'loading' | 'error' | 'ready'
  retry: () => void
}

/**
 * Active stations of the signed-in tenant (RLS-scoped read), filtered to the stations the user holds access to. Kept fresh
 * by Realtime: a stations change invalidates the query, a role_station_access change reloads the session context (which
 * carries station_ids). Only fetched when the user holds the board permission.
 */
export function useStations(): StationsState {
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

  useEffect(() => {
    if (!enabled || !restaurantId || !roleId) return
    return subscribeToStations(restaurantId, roleId, {
      onStationsChange: () => void qc.invalidateQueries({ queryKey: stationsKey(restaurantId) }),
      onAccessChange: refreshContext,
    })
  }, [enabled, restaurantId, roleId, qc, refreshContext])

  const stationIds = context?.station_ids
  const stations = useMemo(
    () => visibleStations(query.data ?? [], { stationIds: stationIds ?? [], can }),
    [query.data, stationIds, can],
  )

  const { refetch } = query
  return {
    stations,
    status: !enabled ? 'idle' : query.isPending ? 'loading' : query.isError ? 'error' : 'ready',
    retry: () => void refetch(),
  }
}
