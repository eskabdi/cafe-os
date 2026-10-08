import { useQuery } from '@tanstack/react-query'
import { useAuth } from '@/features/auth'
import {
  allStationsKey,
  categoriesKey,
  fetchAllStations,
  fetchCategories,
} from '@/lib/supabase/reference-data'

// Reference rows shared by the menu and inventory screens. Freshness comes from the page's single Realtime channel
// (useMenuRealtime / useInventoryRealtime invalidate these keys); no polling.

/** The identity's own restaurant id (session context), never the URL slug. */
export function useRestaurantId(): string {
  const { context } = useAuth()
  return context?.restaurant?.id ?? ''
}

/** Every category row of the tenant (dynamic domain, UUID rows with their own colour / icon). */
export function useCategories() {
  const rid = useRestaurantId()
  return useQuery({ queryKey: categoriesKey(rid), queryFn: fetchCategories, enabled: Boolean(rid) })
}

/** Every station row of the tenant (active and inactive), for labels and pickers. */
export function useAllStations() {
  const rid = useRestaurantId()
  return useQuery({ queryKey: allStationsKey(rid), queryFn: fetchAllStations, enabled: Boolean(rid) })
}
