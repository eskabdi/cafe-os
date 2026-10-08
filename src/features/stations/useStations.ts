import { createContext, useContext } from 'react'
import type { StationRow } from '@/lib/supabase/stations'

export interface StationsState {
  /** Active stations the user may open (station access + board permission), ordered for display. */
  stations: StationRow[]
  status: 'idle' | 'loading' | 'error' | 'ready'
  retry: () => void
}

export const StationsContext = createContext<StationsState | null>(null)

/** Shared stations state from the single StationsProvider (mounted in AppShell): one query, one Realtime channel. */
export function useStations(): StationsState {
  const value = useContext(StationsContext)
  if (!value) throw new Error('useStations must be used inside <StationsProvider>')
  return value
}
