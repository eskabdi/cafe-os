import { useEffect, useMemo, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { FormError } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/select'
import { useIngredients } from '@/features/inventory/useInventory'
import { formatEtb } from '@/lib/domain/decimal'
import { pickerRows } from '@/lib/domain/inventory'
import type { MenuItem } from '@/lib/supabase/menu'
import { menuInventoryErrorMessage } from '@/lib/supabase/menu-inventory-errors'
import {
  draftFromRecipe,
  MAX_RECIPE_LINES,
  recipeCostPreview,
  validateRecipe,
  type DraftLine,
} from './recipe-form'
import { useRecipe, useSetRecipe } from './useMenu'

/** Edits the ingredients consumed per serving of one menu item (fn_set_recipe replaces the whole recipe). */
export function RecipeEditorDialog({ item, onClose }: { item: MenuItem | null; onClose: () => void }) {
  const open = item !== null
  const recipe = useRecipe(item?.id ?? null)
  const ingredients = useIngredients(open)
  const save = useSetRecipe()
  const [draft, setDraft] = useState<DraftLine[] | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      setDraft(null)
      return
    }
    if (recipe.data && draft === null) setDraft(draftFromRecipe(recipe.data))
  }, [open, recipe.data, draft])

  useEffect(() => {
    setErrors({})
    setFormError(null)
  }, [item?.id])

  const byId = useMemo(() => new Map((ingredients.data ?? []).map((i) => [i.id, i])), [ingredients.data])
  const lines = draft ?? []
  const valid = validateRecipe(lines)
  const cost = valid.ok ? recipeCostPreview(valid.lines, (id) => byId.get(id)?.cost_per_unit) : null

  const setLine = (key: string, patch: Partial<DraftLine>) =>
    setDraft((d) => (d ?? []).map((l) => (l.key === key ? { ...l, ...patch } : l)))

  const submit = async () => {
    if (!item) return
    setFormError(null)
    const v = validateRecipe(lines)
    if (!v.ok) {
      setErrors(v.errors)
      setFormError(v.message ?? 'Fix the highlighted lines.')
      return
    }
    setErrors({})
    try {
      await save.mutateAsync({ menuItemId: item.id, lines: v.lines })
      toast.success('Recipe saved')
      onClose()
    } catch (err) {
      setFormError(menuInventoryErrorMessage(err))
    }
  }

  const loading = recipe.isPending || ingredients.isPending
  const failed = recipe.isError || ingredients.isError

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !save.isPending && onClose()}>
      <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Recipe: {item?.name}</DialogTitle>
          <DialogDescription>
            Ingredients used for one serving. Stock is deducted by the server when an order is placed.
          </DialogDescription>
        </DialogHeader>
        {loading && !failed && (
          <p role="status" className="text-sm text-muted-foreground">
            Loading…
          </p>
        )}
        {failed && <FormError message="The recipe could not be loaded. Close and try again." />}
        {!loading && !failed && (
          <div className="space-y-3">
            {lines.length === 0 && <p className="text-sm text-muted-foreground">No ingredients yet.</p>}
            <ul className="space-y-3" aria-label="Recipe ingredients">
              {lines.map((l, idx) => {
                const ing = byId.get(l.ingredient_id)
                const options = pickerRows(ingredients.data ?? [], l.ingredient_id)
                const err = errors[l.key]
                return (
                  <li key={l.key} className="space-y-1">
                    <div className="flex flex-wrap items-end gap-2">
                      <div className="min-w-[12rem] flex-1 space-y-1">
                        <label htmlFor={`rl-ing-${l.key}`} className="text-xs font-medium text-ink">
                          Ingredient {idx + 1}
                        </label>
                        <NativeSelect
                          id={`rl-ing-${l.key}`}
                          value={l.ingredient_id}
                          aria-invalid={err ? true : undefined}
                          aria-describedby={err ? `rl-err-${l.key}` : undefined}
                          onChange={(ev) => setLine(l.key, { ingredient_id: ev.target.value })}
                        >
                          <option value="">Choose…</option>
                          {options.map((o) => (
                            <option key={o.id} value={o.id} disabled={!o.is_active}>
                              {o.is_active ? `${o.name} (${o.unit})` : `${o.name} (inactive)`}
                            </option>
                          ))}
                        </NativeSelect>
                      </div>
                      <div className="w-36 space-y-1">
                        <label htmlFor={`rl-qty-${l.key}`} className="text-xs font-medium text-ink">
                          Quantity{ing ? ` (${ing.unit})` : ''}
                        </label>
                        <Input
                          id={`rl-qty-${l.key}`}
                          inputMode="decimal"
                          autoComplete="off"
                          value={l.qty}
                          aria-invalid={err ? true : undefined}
                          aria-describedby={err ? `rl-err-${l.key}` : undefined}
                          onChange={(ev) => setLine(l.key, { qty: ev.target.value })}
                        />
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        aria-label={`Remove ingredient ${idx + 1}`}
                        onClick={() => setDraft((d) => (d ?? []).filter((x) => x.key !== l.key))}
                      >
                        <Trash2 aria-hidden="true" className="h-4 w-4" />
                      </Button>
                    </div>
                    {err && (
                      <p
                        id={`rl-err-${l.key}`}
                        role="alert"
                        className="text-sm font-medium text-status-error"
                      >
                        {err}
                      </p>
                    )}
                  </li>
                )
              })}
            </ul>
            <Button
              type="button"
              variant="outline"
              disabled={lines.length >= MAX_RECIPE_LINES}
              onClick={() =>
                setDraft((d) => [...(d ?? []), { key: crypto.randomUUID(), ingredient_id: '', qty: '' }])
              }
            >
              <Plus aria-hidden="true" className="h-4 w-4" />
              Add ingredient
            </Button>
            {cost !== null && lines.length > 0 && (
              <p className="text-sm text-muted-foreground" data-testid="recipe-cost">
                Estimated ingredient cost per serving: {formatEtb(cost)}
              </p>
            )}
          </div>
        )}
        <FormError message={formError} />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={save.isPending || loading || failed}>
            {save.isPending ? 'Saving…' : 'Save recipe'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
