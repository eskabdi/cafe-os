import { z } from 'zod'
import { parseDecimal } from '@/lib/domain/decimal'
import { isUuid } from '@/lib/domain/navigation'
import type { MenuItem, MenuItemInput, MenuItemPatch } from '@/lib/supabase/menu'

// Form schema mirrors the RPC validation (fn_create_menu_item / fn_update_menu_item) for instant feedback only; the server
// re-validates everything. Numbers stay strings until parsed, so "12.50" is sent exactly as typed (never float-rounded).

const MAX_PRICE = 9999999999.99
const codePoints = (s: string) => [...s].length

export const menuItemFormSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name.').max(120, 'Use at most 120 characters.'),
  price: z
    .string()
    .trim()
    .refine((v) => {
      const n = parseDecimal(v, 2)
      return n !== null && n <= MAX_PRICE
    }, 'Enter a price such as 120 or 120.50 (at most 2 decimals).'),
  category_id: z.string().refine(isUuid, 'Choose a category.'),
  station_id: z.string().refine(isUuid, 'Choose a station.'),
  description: z.string().max(500, 'Use at most 500 characters.'),
  emoji: z
    .string()
    .trim()
    .refine((v) => codePoints(v) <= 16, 'Use at most 16 characters.'),
  sort_order: z
    .string()
    .trim()
    .regex(/^-?\d{1,7}$/, 'Use a whole number.')
    .refine((v) => Math.abs(Number(v)) <= 1_000_000, 'Use a number between -1,000,000 and 1,000,000.'),
})
export type MenuItemFormValues = z.infer<typeof menuItemFormSchema>

export function emptyMenuForm(): MenuItemFormValues {
  return { name: '', price: '', category_id: '', station_id: '', description: '', emoji: '', sort_order: '0' }
}

export function menuFormFromItem(item: MenuItem): MenuItemFormValues {
  return {
    name: item.name,
    price: String(item.price),
    category_id: item.category_id,
    station_id: item.station_id,
    description: item.description ?? '',
    emoji: item.emoji ?? '',
    sort_order: String(item.sort_order ?? 0),
  }
}

/** Validated form values -> RPC input. Empty optional text becomes null. */
export function toMenuItemInput(v: MenuItemFormValues, imagePath: string | null): MenuItemInput {
  return {
    name: v.name.trim(),
    price: parseDecimal(v.price, 2) ?? 0,
    category_id: v.category_id,
    station_id: v.station_id,
    description: v.description.trim() || null,
    emoji: v.emoji.trim() || null,
    image_path: imagePath,
    sort_order: Number(v.sort_order),
  }
}

/** Only the fields that changed (a no-op edit sends nothing). `image` undefined = unchanged, null = remove, string = new path. */
export function menuItemPatch(
  item: MenuItem,
  v: MenuItemFormValues,
  image: string | null | undefined,
): MenuItemPatch {
  const next = toMenuItemInput(v, image ?? null)
  const patch: MenuItemPatch = {}
  if (next.name !== item.name) patch.name = next.name
  if (next.price !== item.price) patch.price = next.price
  if (next.category_id !== item.category_id) patch.category_id = next.category_id
  if (next.station_id !== item.station_id) patch.station_id = next.station_id
  if ((next.description ?? null) !== (item.description ?? null)) patch.description = next.description ?? null
  if ((next.emoji ?? null) !== (item.emoji ?? null)) patch.emoji = next.emoji ?? null
  if (next.sort_order !== (item.sort_order ?? 0)) patch.sort_order = next.sort_order
  if (image !== undefined && image !== (item.image_path ?? null)) patch.image_path = image
  return patch
}
