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
import { Textarea } from '@/components/ui/select'
import { useStepUp } from '@/features/auth'
import { formatSignedQty } from '@/lib/domain/decimal'
import { movementReasonText, newIdempotencyKey } from '@/lib/domain/inventory'
import type { StockMovement } from '@/lib/supabase/inventory'
import { errorField, menuInventoryErrorMessage } from '@/lib/supabase/menu-inventory-errors'
import { reverseFormSchema, type ReverseFormValues } from './inventory-form'
import { useReverseMovement } from './useInventory'

/** Posts a compensating ledger row for one movement (the original row is never edited). One idempotency key per opening. */
export function ReverseMovementDialog({
  movement,
  onClose,
}: {
  movement: StockMovement | null
  onClose: () => void
}) {
  const open = movement !== null
  const reverse = useReverseMovement()
  const stepUp = useStepUp()
  const [key, setKey] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const { register, handleSubmit, reset, setError, formState } = useForm<ReverseFormValues>({
    resolver: zodResolver(reverseFormSchema),
    defaultValues: { reason: '' },
  })

  useEffect(() => {
    if (!open) return
    setKey(newIdempotencyKey())
    setFormError(null)
    reset({ reason: '' })
  }, [open, movement, reset])

  const submit = async (v: ReverseFormValues) => {
    if (!movement) return
    setFormError(null)
    const args = { movementId: movement.id, reason: v.reason.trim(), idempotencyKey: key }
    try {
      await stepUp.run(() => reverse.mutateAsync(args))
      toast.success('Movement reversed')
      onClose()
    } catch (err) {
      if (errorField(err) === 'reason')
        setError('reason', { type: 'server', message: menuInventoryErrorMessage(err) })
      else setFormError(menuInventoryErrorMessage(err))
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !reverse.isPending && onClose()}>
      <DialogContent>
        {movement && (
          <form noValidate className="space-y-4" onSubmit={(ev) => void handleSubmit(submit)(ev)}>
            <DialogHeader>
              <DialogTitle>Reverse movement</DialogTitle>
              <DialogDescription>
                {movementReasonText(movement.reason)} of {formatSignedQty(movement.qty_delta)} {movement.unit}{' '}
                for {movement.ingredient_name}. A reversal of {formatSignedQty(-movement.qty_delta)}{' '}
                {movement.unit} is added to the log; the original row stays unchanged.
              </DialogDescription>
            </DialogHeader>
            <FormField id="rev-reason" label="Reason (required)" error={formState.errors.reason?.message}>
              {(a) => <Textarea {...a} maxLength={300} {...register('reason')} />}
            </FormField>
            <FormError message={formError} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose} disabled={reverse.isPending}>
                Cancel
              </Button>
              <Button type="submit" disabled={reverse.isPending}>
                {reverse.isPending ? 'Saving…' : 'Reverse movement'}
              </Button>
            </DialogFooter>
          </form>
        )}
        {stepUp.dialog}
      </DialogContent>
    </Dialog>
  )
}
