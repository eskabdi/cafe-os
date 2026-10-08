import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { FormError, FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { useStepUp } from '@/features/auth'
import { formatEtb, parseDecimal } from '@/lib/domain/decimal'
import { menuInventoryErrorMessage } from '@/lib/supabase/menu-inventory-errors'
import { thresholdFormSchema, type ThresholdFormValues } from './inventory-form'
import { useSetStepUpThreshold } from './useInventory'

/**
 * settings.manage: the ETB value at which a stock movement asks for the authenticator. The RPC needs an aal2 session with a
 * verified authenticator (mfa_required opens the step-up prompt).
 */
export function StepUpThresholdCard({ current }: { current: number | null | undefined }) {
  const save = useSetStepUpThreshold()
  const stepUp = useStepUp()
  const [formError, setFormError] = useState<string | null>(null)
  const { register, handleSubmit, reset, formState } = useForm<ThresholdFormValues>({
    resolver: zodResolver(thresholdFormSchema),
    defaultValues: { threshold: '' },
  })
  useEffect(() => {
    if (current !== null && current !== undefined) reset({ threshold: String(current) })
  }, [current, reset])

  const submit = async (v: ThresholdFormValues) => {
    setFormError(null)
    const value = parseDecimal(v.threshold, 2) ?? 0
    try {
      const stored = await stepUp.run(() => save.mutateAsync(value))
      toast.success(`Verification threshold set to ${formatEtb(stored)}`)
    } catch (err) {
      setFormError(menuInventoryErrorMessage(err))
    }
  }

  return (
    <section
      aria-labelledby="threshold-title"
      className="space-y-3 rounded-card border border-line bg-white p-4"
    >
      <h2 id="threshold-title" className="text-base font-semibold text-ink">
        Verification threshold
      </h2>
      <p className="text-sm text-muted-foreground">
        Stock changes worth at least this much (quantity × cost per unit) ask for the authenticator app.
        Current: {formatEtb(current)}.
      </p>
      <form
        noValidate
        className="flex flex-wrap items-end gap-3"
        onSubmit={(ev) => void handleSubmit(submit)(ev)}
      >
        <div className="w-56">
          <FormField id="threshold" label="Threshold (ETB)" error={formState.errors.threshold?.message}>
            {(a) => <Input {...a} inputMode="decimal" autoComplete="off" {...register('threshold')} />}
          </FormField>
        </div>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save threshold'}
        </Button>
      </form>
      <FormError message={formError} />
      {stepUp.dialog}
    </section>
  )
}
