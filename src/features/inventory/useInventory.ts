import { useEffect } from 'react'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRestaurantId } from '@/hooks/useReferenceData'
import {
  adjustStock,
  createIngredient,
  fetchIngredients,
  fetchStockStepupThreshold,
  ingredientsKey,
  listStockMovements,
  movementsKey,
  receiveStock,
  reverseStockMovement,
  setIngredientActive,
  setStockStepupThreshold,
  stepUpThresholdKey,
  subscribeToInventory,
  updateIngredient,
  type IngredientInput,
  type IngredientPatch,
  type MovementCursor,
} from '@/lib/supabase/inventory'
import { menuItemsKey } from '@/lib/supabase/menu'
import { allStationsKey } from '@/lib/supabase/reference-data'

export const MOVEMENTS_PAGE_SIZE = 25

export function useIngredients(enabled = true) {
  const rid = useRestaurantId()
  return useQuery({
    queryKey: ingredientsKey(rid),
    queryFn: fetchIngredients,
    enabled: enabled && Boolean(rid),
  })
}

export function useStepUpThreshold() {
  const rid = useRestaurantId()
  return useQuery({
    queryKey: stepUpThresholdKey(rid),
    queryFn: () => fetchStockStepupThreshold(rid),
    enabled: Boolean(rid),
  })
}

/** Movement log, newest first, keyset-paged on (created_at, id): the next page starts after the last row loaded. */
export function useStockMovements(ingredientId: string | null) {
  const rid = useRestaurantId()
  return useInfiniteQuery({
    queryKey: movementsKey(rid, ingredientId),
    queryFn: ({ pageParam }) =>
      listStockMovements({ ingredientId, limit: MOVEMENTS_PAGE_SIZE, cursor: pageParam }),
    initialPageParam: null as MovementCursor | null,
    getNextPageParam: (last) => {
      const tail = last[last.length - 1]
      return last.length < MOVEMENTS_PAGE_SIZE || !tail
        ? undefined
        : { before: tail.created_at, beforeId: tail.id }
    },
    enabled: Boolean(rid),
  })
}

/** One Realtime channel per inventory screen: ingredient / ledger / station changes invalidate the matching queries. */
export function useInventoryRealtime() {
  const rid = useRestaurantId()
  const qc = useQueryClient()
  useEffect(() => {
    if (!rid) return
    return subscribeToInventory(rid, (table) => {
      if (table === 'stations') void qc.invalidateQueries({ queryKey: allStationsKey(rid) })
      else if (table === 'ingredients') {
        void qc.invalidateQueries({ queryKey: ingredientsKey(rid) })
        // cheap: only refetched if a menu list is mounted (otherwise just marked stale)
        void qc.invalidateQueries({ queryKey: menuItemsKey(rid) })
      } else {
        void qc.invalidateQueries({ queryKey: ['stock-movements', rid] })
        void qc.invalidateQueries({ queryKey: ingredientsKey(rid) })
      }
    })
  }, [rid, qc])
}

function useInvalidateInventory() {
  const rid = useRestaurantId()
  const qc = useQueryClient()
  return () => {
    void qc.invalidateQueries({ queryKey: ingredientsKey(rid) })
    void qc.invalidateQueries({ queryKey: ['stock-movements', rid] })
  }
}

export function useCreateIngredient() {
  const invalidate = useInvalidateInventory()
  return useMutation({
    mutationFn: (input: IngredientInput) => createIngredient(input),
    onSuccess: invalidate,
  })
}

export function useUpdateIngredient() {
  const invalidate = useInvalidateInventory()
  return useMutation({
    mutationFn: (a: { id: string; patch: IngredientPatch }) => updateIngredient(a.id, a.patch),
    onSuccess: invalidate,
  })
}

export function useSetIngredientActive() {
  const invalidate = useInvalidateInventory()
  return useMutation({
    mutationFn: (a: { id: string; active: boolean }) => setIngredientActive(a.id, a.active),
    onSuccess: invalidate,
  })
}

export function useReceiveStock() {
  const invalidate = useInvalidateInventory()
  return useMutation({
    mutationFn: (a: Parameters<typeof receiveStock>[0]) => receiveStock(a),
    onSuccess: invalidate,
  })
}

export function useAdjustStock() {
  const invalidate = useInvalidateInventory()
  return useMutation({
    mutationFn: (a: Parameters<typeof adjustStock>[0]) => adjustStock(a),
    onSuccess: invalidate,
  })
}

export function useReverseMovement() {
  const invalidate = useInvalidateInventory()
  return useMutation({
    mutationFn: (a: Parameters<typeof reverseStockMovement>[0]) => reverseStockMovement(a),
    onSuccess: invalidate,
  })
}

export function useSetStepUpThreshold() {
  const rid = useRestaurantId()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (threshold: number) => setStockStepupThreshold(threshold),
    onSuccess: (value) => qc.setQueryData(stepUpThresholdKey(rid), value),
  })
}
