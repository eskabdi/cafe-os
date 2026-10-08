import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRestaurantId } from '@/hooks/useReferenceData'
import { ingredientsKey } from '@/lib/supabase/inventory'
import {
  createMenuItem,
  fetchMenuItems,
  fetchRecipe,
  menuItemsKey,
  recipeKey,
  setMenuItemActive,
  setRecipe,
  subscribeToMenu,
  updateMenuItem,
  type MenuItemInput,
  type MenuItemPatch,
  type RecipeLine,
} from '@/lib/supabase/menu'
import { menuImageUrlKey, signedMenuImageUrl, SIGNED_URL_TTL_SECONDS } from '@/lib/supabase/menu-images'
import { allStationsKey, categoriesKey } from '@/lib/supabase/reference-data'

export function useMenuItems() {
  const rid = useRestaurantId()
  return useQuery({ queryKey: menuItemsKey(rid), queryFn: fetchMenuItems, enabled: Boolean(rid) })
}

export function useRecipe(menuItemId: string | null) {
  const rid = useRestaurantId()
  return useQuery({
    queryKey: recipeKey(rid, menuItemId ?? ''),
    queryFn: () => fetchRecipe(menuItemId ?? ''),
    enabled: Boolean(rid && menuItemId),
  })
}

/** Signed URL for a private menu image; re-signed well before it expires. */
export function useMenuImageUrl(path: string | null | undefined) {
  const rid = useRestaurantId()
  return useQuery({
    queryKey: menuImageUrlKey(rid, path ?? ''),
    queryFn: () => signedMenuImageUrl(path ?? ''),
    enabled: Boolean(rid && path),
    staleTime: (SIGNED_URL_TTL_SECONDS - 300) * 1000,
    gcTime: (SIGNED_URL_TTL_SECONDS - 300) * 1000,
  })
}

/**
 * One Realtime channel per menu screen: any menu / recipe / category / station / ingredient change invalidates the matching
 * query. Ingredients feed the recipe editor's list, and recipe changes alter an ingredient's "used in a recipe" state.
 */
export function useMenuRealtime() {
  const rid = useRestaurantId()
  const qc = useQueryClient()
  useEffect(() => {
    if (!rid) return
    return subscribeToMenu(rid, (table) => {
      if (table === 'menu_items') void qc.invalidateQueries({ queryKey: menuItemsKey(rid) })
      else if (table === 'recipe_lines') {
        void qc.invalidateQueries({ queryKey: ['recipe', rid] })
        void qc.invalidateQueries({ queryKey: ingredientsKey(rid) })
      } else if (table === 'ingredients') void qc.invalidateQueries({ queryKey: ingredientsKey(rid) })
      else if (table === 'categories') void qc.invalidateQueries({ queryKey: categoriesKey(rid) })
      else void qc.invalidateQueries({ queryKey: allStationsKey(rid) })
    })
  }, [rid, qc])
}

function useInvalidateMenu() {
  const rid = useRestaurantId()
  const qc = useQueryClient()
  return () => void qc.invalidateQueries({ queryKey: menuItemsKey(rid) })
}

export function useCreateMenuItem() {
  const invalidate = useInvalidateMenu()
  return useMutation({ mutationFn: (input: MenuItemInput) => createMenuItem(input), onSuccess: invalidate })
}

export function useUpdateMenuItem() {
  const invalidate = useInvalidateMenu()
  return useMutation({
    mutationFn: (a: { id: string; patch: MenuItemPatch }) => updateMenuItem(a.id, a.patch),
    onSuccess: invalidate,
  })
}

export function useSetMenuItemActive() {
  const invalidate = useInvalidateMenu()
  return useMutation({
    mutationFn: (a: { id: string; active: boolean }) => setMenuItemActive(a.id, a.active),
    onSuccess: invalidate,
  })
}

export function useSetRecipe() {
  const rid = useRestaurantId()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (a: { menuItemId: string; lines: RecipeLine[] }) => setRecipe(a.menuItemId, a.lines),
    onSuccess: (res) => {
      qc.setQueryData(recipeKey(rid, res.menu_item_id), res.lines)
      void qc.invalidateQueries({ queryKey: recipeKey(rid, res.menu_item_id) })
      // an ingredient's "used in an active recipe" state may have changed
      void qc.invalidateQueries({ queryKey: ingredientsKey(rid) })
    },
  })
}
