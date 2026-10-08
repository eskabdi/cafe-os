import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
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
import { FormError, FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/select'
import { useStepUp } from '@/features/auth'
import { INGREDIENT_UNITS, pickerRows } from '@/lib/domain/inventory'
import type { Ingredient } from '@/lib/supabase/inventory'
import { errorField, menuInventoryErrorMessage } from '@/lib/supabase/menu-inventory-errors'
import type { StationRow } from '@/lib/supabase/stations'
import {
  emptyIngredientForm,
  ingredientFormFrom,
  ingredientFormSchema,
  ingredientPatch,
  toIngredientInput,
  type IngredientFormValues,
} from './inventory-form'
import { useCreateIngredient, useUpdateIngredient } from './useInventory'

const FORM_FIELDS = new Set<string>(['name', 'unit', 'min_level', 'cost_per_unit', 'initial_stock'])

/** Create (ingredient = null) or edit an ingredient's master data. Stock only moves through the ledger commands. */
export function IngredientFormDialog({
  open,
  ingredient,
  stations,
  onClose,
}: {
  open: boolean
  ingredient: Ingredient | null
  stations: StationRow[]
  onClose: () => void
}) {
  const create = useCreateIngredient()
  const update = useUpdateIngredient()
  const stepUp = useStepUp()
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const form = useForm<IngredientFormValues>({
    resolver: zodResolver(ingredientFormSchema),
    defaultValues: emptyIngredientForm(),
  })
  const { register, handleSubmit, reset, setError, watch, formState } = form

  useEffect(() => {
    if (!open) return
    reset(ingredient ? ingredientFormFrom(ingredient) : emptyIngredientForm())
    setFormError(null)
  }, [open, ingredient, reset])

  const stationId = watch('station_id')
  const stationOptions = pickerRows(stations, ingredient?.station_id ?? stationId)

  const submit = async (values: IngredientFormValues) => {
    setFormError(null)
    setBusy(true)
    try {
      if (!ingredient) {
        const input = toIngredientInput(values)
        await stepUp.run(() => create.mutateAsync(input))
        toast.success('Ingredient created')
      } else {
        const patch = ingredientPatch(ingredient, values)
        if (Object.keys(patch).length > 0)
          await stepUp.run(() => update.mutateAsync({ id: ingredient.id, patch }))
        toast.success('Ingredient saved')
      }
      onClose()
    } catch (err) {
      const field = errorField(err)
      if (field && FORM_FIELDS.has(field)) {
        setError(
          field as keyof IngredientFormValues,
          { type: 'server', message: menuInventoryErrorMessage(err) },
          { shouldFocus: true },
        )
      } else setFormError(menuInventoryErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const e = formState.errors
  return (
    <>
      <Dialog open={open} onOpenChange={(next) => !next && !busy && onClose()}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <form noValidate className="space-y-4" onSubmit={(ev) => void handleSubmit(submit)(ev)}>
            <DialogHeader>
              <DialogTitle>{ingredient ? 'Edit ingredient' : 'New ingredient'}</DialogTitle>
              <DialogDescription>
                {ingredient
                  ? 'Stock is not edited here: use Receive or Adjust so every change is in the movement log.'
                  : 'An initial stock above 0 is recorded as an opening movement in the open business day.'}
              </DialogDescription>
            </DialogHeader>
            <FormField id="ing-name" label="Name" error={e.name?.message}>
              {(a) => <Input {...a} maxLength={120} autoComplete="off" {...register('name')} />}
            </FormField>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField id="ing-station" label="Station" error={e.station_id?.message}>
                {(a) => (
                  <NativeSelect {...a} {...register('station_id')}>
                    <option value="">Choose…</option>
                    {stationOptions.map((s) => (
                      <option key={s.id} value={s.id} disabled={!s.is_active}>
                        {s.is_active ? s.name : `${s.name} (inactive)`}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </FormField>
              <FormField
                id="ing-unit"
                label="Unit"
                hint={ingredient ? 'Locked once the ingredient has movements or is in a recipe' : undefined}
                error={e.unit?.message}
              >
                {(a) => (
                  <NativeSelect {...a} {...register('unit')}>
                    {INGREDIENT_UNITS.map((u) => (
                      <option key={u} value={u}>
                        {u}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </FormField>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                id="ing-min"
                label="Minimum level"
                hint="Low-stock alert at or below this"
                error={e.min_level?.message}
              >
                {(a) => <Input {...a} inputMode="decimal" autoComplete="off" {...register('min_level')} />}
              </FormField>
              <FormField id="ing-cost" label="Cost per unit (ETB)" error={e.cost_per_unit?.message}>
                {(a) => (
                  <Input {...a} inputMode="decimal" autoComplete="off" {...register('cost_per_unit')} />
                )}
              </FormField>
            </div>
            {!ingredient && (
              <FormField id="ing-initial" label="Initial stock" error={e.initial_stock?.message}>
                {(a) => (
                  <Input {...a} inputMode="decimal" autoComplete="off" {...register('initial_stock')} />
                )}
              </FormField>
            )}
            <FormError message={formError} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? 'Saving…' : ingredient ? 'Save changes' : 'Create ingredient'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      {stepUp.dialog}
    </>
  )
}
