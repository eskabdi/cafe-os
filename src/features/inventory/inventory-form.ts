import { z } from 'zod'
import { parseDecimal } from '@/lib/domain/decimal'
import { INGREDIENT_UNITS, type IngredientUnit } from '@/lib/domain/inventory'
import { isUuid } from '@/lib/domain/navigation'
import type { Ingredient, IngredientInput, IngredientPatch } from '@/lib/supabase/inventory'

// Form schemas mirror the RPC validation of migration 0029 for instant feedback; the server re-validates. Numbers stay
// strings until parsed so exactly the typed decimal is sent.

const qty3 = (max: number, msg: string) =>
  z
    .string()
    .trim()
    .refine((v) => {
      const n = parseDecimal(v, 3)
      return n !== null && n <= max
    }, msg)

const money2 = (msg: string) =>
  z
    .string()
    .trim()
    .refine((v) => {
      const n = parseDecimal(v, 2)
      return n !== null && n <= 9999999999.99
    }, msg)

export const ingredientFormSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name.').max(120, 'Use at most 120 characters.'),
  station_id: z.string().refine(isUuid, 'Choose a station.'),
  unit: z.enum(INGREDIENT_UNITS, { errorMap: () => ({ message: 'Choose a unit.' }) }),
  min_level: qty3(999999999, 'Enter 0 or more with at most 3 decimals.'),
  cost_per_unit: money2('Enter 0 or more with at most 2 decimals.'),
  initial_stock: qty3(999999999, 'Enter 0 or more with at most 3 decimals.'),
})
export type IngredientFormValues = z.infer<typeof ingredientFormSchema>

export function emptyIngredientForm(): IngredientFormValues {
  return { name: '', station_id: '', unit: 'kg', min_level: '0', cost_per_unit: '0', initial_stock: '0' }
}

export function ingredientFormFrom(i: Ingredient): IngredientFormValues {
  return {
    name: i.name,
    station_id: i.station_id,
    unit: i.unit,
    min_level: String(i.min_level),
    cost_per_unit: String(i.cost_per_unit),
    initial_stock: '0',
  }
}

export function toIngredientInput(v: IngredientFormValues): IngredientInput {
  return {
    name: v.name.trim(),
    station_id: v.station_id,
    unit: v.unit as IngredientUnit,
    min_level: parseDecimal(v.min_level, 3) ?? 0,
    cost_per_unit: parseDecimal(v.cost_per_unit, 2) ?? 0,
    initial_stock: parseDecimal(v.initial_stock, 3) ?? 0,
  }
}

/** Changed fields only (stock is never part of a patch). */
export function ingredientPatch(i: Ingredient, v: IngredientFormValues): IngredientPatch {
  const next = toIngredientInput(v)
  const patch: IngredientPatch = {}
  if (next.name !== i.name) patch.name = next.name
  if (next.station_id !== i.station_id) patch.station_id = next.station_id
  if (next.unit !== i.unit) patch.unit = next.unit
  if (next.min_level !== i.min_level) patch.min_level = next.min_level
  if (next.cost_per_unit !== i.cost_per_unit) patch.cost_per_unit = next.cost_per_unit
  return patch
}

export const receiveFormSchema = z.object({
  qty: qty3(1_000_000, 'Enter a quantity above 0 with at most 3 decimals.').refine(
    (v) => (parseDecimal(v, 3) ?? 0) > 0,
    'Enter a quantity above 0.',
  ),
  note: z.string().trim().max(300, 'Use at most 300 characters.'),
})
export type ReceiveFormValues = z.infer<typeof receiveFormSchema>

export const adjustFormSchema = z.object({
  qty_delta: z
    .string()
    .trim()
    .refine((v) => {
      const n = parseDecimal(v, 3, true)
      return n !== null && n !== 0 && Math.abs(n) <= 1_000_000
    }, 'Enter a non-zero change such as 2 or -0.5 (at most 3 decimals).'),
  reason: z
    .string()
    .trim()
    .min(3, 'Enter a reason of at least 3 characters.')
    .max(300, 'Use at most 300 characters.'),
})
export type AdjustFormValues = z.infer<typeof adjustFormSchema>

export const reverseFormSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(3, 'Enter a reason of at least 3 characters.')
    .max(300, 'Use at most 300 characters.'),
})
export type ReverseFormValues = z.infer<typeof reverseFormSchema>

export const thresholdFormSchema = z.object({
  threshold: z
    .string()
    .trim()
    .refine((v) => {
      const n = parseDecimal(v, 2)
      return n !== null && n >= 100 && n <= 1_000_000
    }, 'Enter an amount between 100 and 1,000,000 with at most 2 decimals.'),
})
export type ThresholdFormValues = z.infer<typeof thresholdFormSchema>
