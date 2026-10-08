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
import { Textarea } from '@/components/ui/select'
import { useStepUp } from '@/features/auth'
import { formatQty, parseDecimal } from '@/lib/domain/decimal'
import { newIdempotencyKey, stepUpLikely } from '@/lib/domain/inventory'
import type { Ingredient } from '@/lib/supabase/inventory'
import { errorField, menuInventoryErrorMessage } from '@/lib/supabase/menu-inventory-errors'
import {
  adjustFormSchema,
  receiveFormSchema,
  type AdjustFormValues,
  type ReceiveFormValues,
} from './inventory-form'
import { useAdjustStock, useReceiveStock } from './useInventory'

export type StockAction = { kind: 'receive' | 'adjust'; ingredient: Ingredient }

/**
 * Receive stock (inventory.receive) or adjust it with a mandatory reason (inventory.adjust). ONE idempotency key per opened
 * dialog (= one intent): a retry of the same submission (network error, step-up) reuses it so it can never post twice.
 */
export function StockMovementDialog({
  action,
  threshold,
  onClose,
}: {
  action: StockAction | null
  threshold: number | null | undefined
  onClose: () => void
}) {
  const open = action !== null
  const [key, setKey] = useState('')
  useEffect(() => {
    if (open) setKey(newIdempotencyKey())
  }, [open, action])

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        {action?.kind === 'receive' && key && (
          <ReceiveForm
            ingredient={action.ingredient}
            threshold={threshold}
            idempotencyKey={key}
            onDone={onClose}
          />
        )}
        {action?.kind === 'adjust' && key && (
          <AdjustForm
            ingredient={action.ingredient}
            threshold={threshold}
            idempotencyKey={key}
            onDone={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function StepUpHint({ show }: { show: boolean }) {
  if (!show) return null
  return (
    <p className="rounded-md bg-bg p-3 text-sm text-ink" role="note">
      This is a large stock change: you will be asked to verify with your authenticator app.
    </p>
  )
}

function ReceiveForm({
  ingredient,
  threshold,
  idempotencyKey,
  onDone,
}: {
  ingredient: Ingredient
  threshold: number | null | undefined
  idempotencyKey: string
  onDone: () => void
}) {
  const receive = useReceiveStock()
  const stepUp = useStepUp()
  const [formError, setFormError] = useState<string | null>(null)
  const { register, handleSubmit, watch, setError, formState } = useForm<ReceiveFormValues>({
    resolver: zodResolver(receiveFormSchema),
    defaultValues: { qty: '', note: '' },
  })
  const qty = parseDecimal(watch('qty'), 3)

  const submit = async (v: ReceiveFormValues) => {
    setFormError(null)
    const args = {
      ingredientId: ingredient.id,
      qty: parseDecimal(v.qty, 3) ?? 0,
      note: v.note.trim() || null,
      idempotencyKey,
    }
    try {
      const res = await stepUp.run(() => receive.mutateAsync(args))
      toast.success(`Received. ${ingredient.name} now has ${formatQty(res.stock)} ${ingredient.unit}.`)
      onDone()
    } catch (err) {
      const field = errorField(err)
      if (field === 'qty' || field === 'note')
        setError(field, { type: 'server', message: menuInventoryErrorMessage(err) })
      else setFormError(menuInventoryErrorMessage(err))
    }
  }

  return (
    <>
      <form noValidate className="space-y-4" onSubmit={(ev) => void handleSubmit(submit)(ev)}>
        <DialogHeader>
          <DialogTitle>Receive {ingredient.name}</DialogTitle>
          <DialogDescription>
            On hand: {formatQty(ingredient.stock)} {ingredient.unit}. The received quantity is added by the
            server.
          </DialogDescription>
        </DialogHeader>
        <FormField
          id="recv-qty"
          label={`Quantity received (${ingredient.unit})`}
          error={formState.errors.qty?.message}
        >
          {(a) => <Input {...a} inputMode="decimal" autoComplete="off" {...register('qty')} />}
        </FormField>
        <FormField
          id="recv-note"
          label="Note (optional)"
          hint="Supplier, invoice number…"
          error={formState.errors.note?.message}
        >
          {(a) => <Textarea {...a} maxLength={300} {...register('note')} />}
        </FormField>
        <StepUpHint show={qty !== null && stepUpLikely(qty, ingredient.cost_per_unit, threshold)} />
        <FormError message={formError} />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onDone} disabled={receive.isPending}>
            Cancel
          </Button>
          <Button type="submit" disabled={receive.isPending}>
            {receive.isPending ? 'Saving…' : 'Receive stock'}
          </Button>
        </DialogFooter>
      </form>
      {stepUp.dialog}
    </>
  )
}

function AdjustForm({
  ingredient,
  threshold,
  idempotencyKey,
  onDone,
}: {
  ingredient: Ingredient
  threshold: number | null | undefined
  idempotencyKey: string
  onDone: () => void
}) {
  const adjust = useAdjustStock()
  const stepUp = useStepUp()
  const [formError, setFormError] = useState<string | null>(null)
  const { register, handleSubmit, watch, setError, formState } = useForm<AdjustFormValues>({
    resolver: zodResolver(adjustFormSchema),
    defaultValues: { qty_delta: '', reason: '' },
  })
  const delta = parseDecimal(watch('qty_delta'), 3, true)

  const submit = async (v: AdjustFormValues) => {
    setFormError(null)
    const args = {
      ingredientId: ingredient.id,
      qtyDelta: parseDecimal(v.qty_delta, 3, true) ?? 0,
      reason: v.reason.trim(),
      idempotencyKey,
    }
    try {
      const res = await stepUp.run(() => adjust.mutateAsync(args))
      toast.success(`Adjusted. ${ingredient.name} now has ${formatQty(res.stock)} ${ingredient.unit}.`)
      onDone()
    } catch (err) {
      const field = errorField(err)
      if (field === 'qty_delta' || field === 'reason')
        setError(field, { type: 'server', message: menuInventoryErrorMessage(err) })
      else setFormError(menuInventoryErrorMessage(err))
    }
  }

  return (
    <>
      <form noValidate className="space-y-4" onSubmit={(ev) => void handleSubmit(submit)(ev)}>
        <DialogHeader>
          <DialogTitle>Adjust {ingredient.name}</DialogTitle>
          <DialogDescription>
            On hand: {formatQty(ingredient.stock)} {ingredient.unit}. Use a negative number to remove stock
            (waste, count difference).
          </DialogDescription>
        </DialogHeader>
        <FormField
          id="adj-qty"
          label={`Change (${ingredient.unit})`}
          hint="For example 2 or -0.5"
          error={formState.errors.qty_delta?.message}
        >
          {(a) => <Input {...a} inputMode="decimal" autoComplete="off" {...register('qty_delta')} />}
        </FormField>
        <FormField id="adj-reason" label="Reason (required)" error={formState.errors.reason?.message}>
          {(a) => <Textarea {...a} maxLength={300} {...register('reason')} />}
        </FormField>
        {delta !== null && delta !== 0 && (
          <p className="text-sm text-muted-foreground" role="status">
            Expected after the change: {formatQty(ingredient.stock + delta)} {ingredient.unit} (the server
            decides).
          </p>
        )}
        <StepUpHint show={delta !== null && stepUpLikely(delta, ingredient.cost_per_unit, threshold)} />
        <FormError message={formError} />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onDone} disabled={adjust.isPending}>
            Cancel
          </Button>
          <Button type="submit" disabled={adjust.isPending}>
            {adjust.isPending ? 'Saving…' : 'Adjust stock'}
          </Button>
        </DialogFooter>
      </form>
      {stepUp.dialog}
    </>
  )
}
