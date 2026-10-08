import { z } from 'zod'
import { isUuid } from '@/lib/domain/navigation'
import { supabase } from './client'

// Station rows for the navigation and the generic StationKDS. RLS (stations_select) limits SELECT to the caller's own tenant
// (restaurant_id = current_restaurant_id()); no restaurant_id is ever sent as a filter by the client. Per-station access is
// role_station_access, reported by fn_get_session_context as station_ids and enforced by current_station_ids() in RLS.

export const stationRowSchema = z.object({
  id: z.string().refine(isUuid),
  name: z.string().min(1).max(60),
  description: z.string().max(300).nullable().optional(),
  // mirrors the stations table checks; anything else is dropped to null (never applied to a style)
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional().catch(null),
  icon: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/).nullable().optional().catch(null),
  sort_order: z.number().int().nullable().optional(),
  is_active: z.boolean(),
})
export type StationRow = z.infer<typeof stationRowSchema>

const COLUMNS = 'id,name,description,color,icon,sort_order,is_active'

/** Query key root; scoped by the identity's restaurant id so a different tenant never reuses a cached list. */
export const stationsKey = (restaurantId: string) => ['stations', restaurantId] as const

type Result = { data: unknown; error: { message: string } | null }
interface StationQuery extends PromiseLike<Result> {
  select(columns: string): StationQuery
  eq(column: string, value: boolean | string): StationQuery
  order(column: string, options: { ascending: boolean }): StationQuery
}

/** Active stations of the caller's tenant. Rows failing validation are dropped, never rendered. Throws a safe code. */
export async function fetchActiveStations(): Promise<StationRow[]> {
  const client = supabase as unknown as { from: (table: string) => StationQuery }
  const { data, error } = await client
    .from('stations')
    .select(COLUMNS)
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
  if (error) throw new Error('stations_unavailable')
  if (!Array.isArray(data)) return []
  const out: StationRow[] = []
  for (const row of data) {
    const parsed = stationRowSchema.safeParse(row)
    if (parsed.success && parsed.data.is_active) out.push(parsed.data)
  }
  return out
}

export interface StationsSubscription {
  /** A stations row of the tenant changed (added, renamed, recoloured, deactivated). */
  onStationsChange: () => void
  /** The caller's role gained or lost station access (role_station_access). */
  onAccessChange: () => void
}

/**
 * Realtime changes to the tenant's stations and to the caller's role station access (RLS applies to Realtime too; the
 * filters only narrow the stream). Returns an unsubscribe function. No polling.
 */
export function subscribeToStations(restaurantId: string, roleId: string, handlers: StationsSubscription): () => void {
  if (!isUuid(restaurantId) || !isUuid(roleId)) return () => {}
  const channel = supabase
    .channel(`stations:${restaurantId}:${roleId}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'stations', filter: `restaurant_id=eq.${restaurantId}` },
      () => handlers.onStationsChange(),
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'role_station_access', filter: `role_id=eq.${roleId}` },
      () => handlers.onAccessChange(),
    )
    .subscribe()
  return () => {
    void supabase.removeChannel(channel)
  }
}
