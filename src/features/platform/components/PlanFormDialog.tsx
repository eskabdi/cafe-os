import { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { FormError, FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/select'
import { parseDecimal } from '@/lib/domain/decimal'
import { formatFeatures, MIB, parseFeatures, parseLimit } from '@/lib/domain/portal'
import type { Plan, PlanInput } from '@/lib/supabase/platform'

const limit = (max?: number) =>
  z.string().refine((v) => parseLimit(v, max) !== undefined, 'Enter a positive whole number, or leave empty for unlimited.')

export const planFormSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name.').max(60, 'At most 60 characters.'),
  description: z.string().trim().max(300, 'At most 300 characters.'),
  price: z
    .string()
    .refine((v) => {
      const n = parseDecimal(v, 2)
      return n !== null && n <= 10_000_000
    }, 'Enter a price from 0 to 10,000,000 with at most 2 decimals.'),
  max_staff: limit(),
  max_menu_items: limit(),
  max_stations: limit(),
  max_kiosks: limit(),
  max_orders_per_month: limit(),
  max_storage_mib: limit(1024 * 1024),
  features: z.string().refine((v) => parseFeatures(v) !== null, 'One "key = value" per line; keys a-z, 0-9, _ (at most 50).'),
  sort_order: z.string().regex(/^-?\d{1,6}$/, 'Whole number.'),
})
export type PlanFormValues = z.infer<typeof planFormSchema>

const str = (n: number | null | undefined) => (n === null || n === undefined ? '' : String(n))

export function planToForm(p: Plan | null): PlanFormValues {
  return {
    name: p?.name ?? '',
    description: p?.description ?? '',
    price: p ? String(p.price_etb_monthly) : '',
    max_staff: str(p?.max_staff),
    max_menu_items: str(p?.max_menu_items),
    max_stations: str(p?.max_stations),
    max_kiosks: str(p?.max_kiosks),
    max_orders_per_month: str(p?.max_orders_per_month),
    max_storage_mib: p?.max_storage_bytes ? String(Math.max(1, Math.round(p.max_storage_bytes / MIB))) : '',
    features: formatFeatures(p?.features ?? null),
    sort_order: String(p?.sort_order ?? 0),
  }
}

export function formToPlan(v: PlanFormValues): PlanInput {
  const storage = parseLimit(v.max_storage_mib, 1024 * 1024) ?? null
  return {
    name: v.name.trim(),
    description: v.description.trim() || null,
    price_etb_monthly: parseDecimal(v.price, 2) ?? 0,
    max_staff: parseLimit(v.max_staff) ?? null,
    max_menu_items: parseLimit(v.max_menu_items) ?? null,
    max_stations: parseLimit(v.max_stations) ?? null,
    max_kiosks: parseLimit(v.max_kiosks) ?? null,
    max_orders_per_month: parseLimit(v.max_orders_per_month) ?? null,
    max_storage_bytes: storage === null ? null : storage * MIB,
    features: parseFeatures(v.features) ?? {},
    sort_order: Number(v.sort_order),
  }
}

const LIMIT_FIELDS: ReadonlyArray<{ key: keyof PlanFormValues; label: string }> = [
  { key: 'max_staff', label: 'Max active staff' },
  { key: 'max_menu_items', label: 'Max active menu items' },
  { key: 'max_stations', label: 'Max stations' },
  { key: 'max_kiosks', label: 'Max terminals' },
  { key: 'max_orders_per_month', label: 'Max orders per month' },
  { key: 'max_storage_mib', label: 'Max storage (MiB)' },
]

/** Create / edit a catalogue plan (fn_platform_create_plan / fn_platform_update_plan). Empty limit = unlimited. */
export function PlanFormDialog({
  open,
  plan,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  open: boolean
  plan: Plan | null
  busy: boolean
  error: string | null
  onSubmit: (p: PlanInput) => void
  onClose: () => void
}) {
  const form = useForm<PlanFormValues>({ resolver: zodResolver(planFormSchema), defaultValues: planToForm(plan) })
  useEffect(() => {
    if (open) form.reset(planToForm(plan))
  }, [open, plan, form])
  const e = form.formState.errors

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto">
        <form onSubmit={form.handleSubmit((v) => onSubmit(formToPlan(v)))} noValidate className="space-y-4">
          <DialogHeader>
            <DialogTitle>{plan ? `Edit plan ${plan.name}` : 'New plan'}</DialogTitle>
            <DialogDescription>Prices in ETB per month. Leave a limit empty for unlimited.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField id="plan-name" label="Name" error={e.name?.message}>
              {(a) => <Input {...a} {...form.register('name')} />}
            </FormField>
            <FormField id="plan-price" label="Price (ETB / month)" error={e.price?.message}>
              {(a) => <Input {...a} inputMode="decimal" {...form.register('price')} />}
            </FormField>
          </div>
          <FormField id="plan-description" label="Description" error={e.description?.message}>
            {(a) => <Textarea {...a} {...form.register('description')} />}
          </FormField>
          <div className="grid gap-3 sm:grid-cols-3">
            {LIMIT_FIELDS.map((f) => (
              <FormField key={f.key} id={`plan-${f.key}`} label={f.label} error={e[f.key]?.message}>
                {(a) => <Input {...a} inputMode="numeric" placeholder="Unlimited" {...form.register(f.key)} />}
              </FormField>
            ))}
          </div>
          <FormField id="plan-features" label="Features" hint="One per line, e.g. qr_ordering = true" error={e.features?.message}>
            {(a) => <Textarea {...a} {...form.register('features')} />}
          </FormField>
          <FormField id="plan-sort" label="Sort order" error={e.sort_order?.message}>
            {(a) => <Input {...a} inputMode="numeric" {...form.register('sort_order')} />}
          </FormField>
          <FormError message={error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? 'Saving…' : plan ? 'Save plan' : 'Create plan'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
