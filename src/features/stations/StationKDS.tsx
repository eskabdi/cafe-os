import { useParams } from 'react-router-dom'
import { ComingSoonState, EmptyState, ErrorState, PageSkeleton } from '@/features/shell/states'
import { DEFAULT_STATION_ICON } from '@/features/shell/nav-config'
import { iconForSlug } from '@/features/terminal/tile-icons'
import { tileStyle } from '@/lib/domain/tile-style'
import { useStations } from './useStations'

/**
 * THE generic kitchen display for any station (`/r/<slug>/stations/:stationId`). Everything is resolved from the station
 * row by UUID: name, colour, icon. There is no per-station component and no branching on a station name. Tickets, item
 * statuses and timers arrive with the orders phase (Realtime on order_items, RLS-filtered by current_station_ids()).
 */
export function StationKDS() {
  const { stationId } = useParams<{ stationId: string }>()
  const { stations, status, retry } = useStations()

  if (status === 'loading' || status === 'idle') return <PageSkeleton label="Loading station" />
  if (status === 'error') {
    return (
      <ErrorState title="Station could not be loaded" onRetry={retry}>
        <p>Please check your connection and try again.</p>
      </ErrorState>
    )
  }
  const station = stations.find((s) => s.id === stationId)
  if (!station) {
    return (
      <EmptyState title="Station unavailable">
        <p>This station does not exist, was deactivated, or is not assigned to you.</p>
      </EmptyState>
    )
  }

  const Icon = iconForSlug(station.icon, DEFAULT_STATION_ICON)
  const chip = tileStyle(station.color)
  return (
    <div className="space-y-4 p-4 lg:p-6" data-testid="station-kds" data-station-id={station.id}>
      <header className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="inline-flex h-12 w-12 items-center justify-center rounded-card"
          style={{ backgroundColor: chip.background, color: chip.foreground }}
        >
          <Icon className="h-6 w-6" />
        </span>
        <div>
          <h1 className="text-2xl font-semibold text-ink">{station.name}</h1>
          {station.description && <p className="text-sm text-muted-foreground">{station.description}</p>}
        </div>
      </header>
      <ComingSoonState
        level={2}
        title="Station display"
        summary="Live tickets, item statuses and timers for this station will appear here."
      />
    </div>
  )
}
