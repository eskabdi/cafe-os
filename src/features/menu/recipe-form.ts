import { parseDecimal } from '@/lib/domain/decimal'
import { isUuid } from '@/lib/domain/navigation'
import type { RecipeLine } from '@/lib/supabase/menu'

// Recipe editor rows. Quantities stay strings until validated (<= 3 decimals, > 0, like fn_set_recipe).

export const MAX_RECIPE_LINES = 50

export interface DraftLine {
  key: string
  ingredient_id: string
  qty: string
}

export type RecipeValidation =
  { ok: true; lines: RecipeLine[] } | { ok: false; errors: Record<string, string>; message?: string }

export function draftFromRecipe(lines: readonly RecipeLine[]): DraftLine[] {
  return lines.map((l) => ({
    key: crypto.randomUUID(),
    ingredient_id: l.ingredient_id,
    qty: String(l.qty_per_serving),
  }))
}

/** Validates the draft; errors are keyed by DraftLine.key. */
export function validateRecipe(draft: readonly DraftLine[]): RecipeValidation {
  if (draft.length > MAX_RECIPE_LINES)
    return { ok: false, errors: {}, message: `A recipe can have at most ${MAX_RECIPE_LINES} ingredients.` }
  const errors: Record<string, string> = {}
  const seen = new Set<string>()
  const lines: RecipeLine[] = []
  for (const d of draft) {
    if (!isUuid(d.ingredient_id)) {
      errors[d.key] = 'Choose an ingredient.'
      continue
    }
    if (seen.has(d.ingredient_id)) {
      errors[d.key] = 'This ingredient is already in the recipe.'
      continue
    }
    seen.add(d.ingredient_id)
    const q = parseDecimal(d.qty, 3)
    if (q === null || q <= 0 || q > 1_000_000) {
      errors[d.key] = 'Enter a quantity above 0 with at most 3 decimals.'
      continue
    }
    lines.push({ ingredient_id: d.ingredient_id, qty_per_serving: q })
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, lines }
}

/** PREVIEW ONLY: estimated ingredient cost of one serving (the server never takes this number). */
export function recipeCostPreview(
  lines: readonly RecipeLine[],
  costOf: (ingredientId: string) => number | undefined,
): number {
  let minor = 0
  for (const l of lines) minor += Math.round(l.qty_per_serving * (costOf(l.ingredient_id) ?? 0) * 100)
  return minor / 100
}
