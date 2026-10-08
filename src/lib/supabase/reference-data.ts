import { z } from 'zod'
import { supabase } from './client'
import { rowColor, rowIcon, uuid } from './schemas'
import { stationRowSchema, type StationRow } from './stations'

// Tenant reference rows (categories, stations) for the menu and inventory screens: dynamic domains, keyed by UUID, with
// their own colour / icon. RLS (<table>_select) limits SELECT to the caller's tenant; no restaurant_id filter is sent.
// Inactive rows are included so existing items still show their category / station; pickers offer only active rows.

export const categoryRowSchema = z.object({
  id: uuid,
  name: z.string().min(1).max(60),
  description: z.string().max(300).nullable().optional(),
  color: rowColor,
  icon: rowIcon,
  sort_order: z.number().int().nullable().optional(),
  is_active: z.boolean(),
})
export type CategoryRow = z.infer<typeof categoryRowSchema>

export const categoriesKey = (restaurantId: string) => ['categories', restaurantId] as const
export const allStationsKey = (restaurantId: string) => ['stations-all', restaurantId] as const

function parseRows<S extends z.ZodTypeAny>(schema: S, data: unknown): Array<z.output<S>> {
  if (!Array.isArray(data)) return []
  const out: Array<z.output<S>> = []
  for (const row of data) {
    const parsed = schema.safeParse(row)
    if (parsed.success) out.push(parsed.data)
  }
  return out
}

/** Every category row of the caller's tenant (active and inactive). Invalid rows are dropped, never rendered. */
export async function fetchCategories(): Promise<CategoryRow[]> {
  const { data, error } = await supabase
    .from('categories')
    .select('id,name,description,color,icon,sort_order,is_active')
    .order('sort_order', { ascending: true })
  if (error) throw new Error('categories_unavailable')
  return parseRows(categoryRowSchema, data)
}

/** Every station row of the caller's tenant (active and inactive), for labels and pickers. */
export async function fetchAllStations(): Promise<StationRow[]> {
  const { data, error } = await supabase
    .from('stations')
    .select('id,name,description,color,icon,sort_order,is_active')
    .order('sort_order', { ascending: true })
  if (error) throw new Error('stations_unavailable')
  return parseRows(stationRowSchema, data)
}
