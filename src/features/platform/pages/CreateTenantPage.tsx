import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { z } from 'zod'
import { Card, PageHeader } from '@/components/portal/page-header'
import { Button } from '@/components/ui/button'
import { FormError, FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/select'
import { useStepUp } from '@/features/auth'
import { formatEtb } from '@/lib/domain/decimal'
import { isValidSlug } from '@/lib/domain/portal'
import { portalErrorMessage } from '@/lib/supabase/portal-errors'
import { platformTenantPath } from '../platform-nav'
import { useCreateTenant, usePlans } from '../usePlatform'

export const createTenantSchema = z.object({
  name: z.string().trim().min(1, 'Enter the restaurant name.').max(120, 'At most 120 characters.'),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .refine(isValidSlug, 'Use 3 to 40 lowercase letters, digits or single hyphens; start and end with a letter or digit.'),
  planId: z.string().uuid('Choose a plan.'),
  trialDays: z.coerce.number().int('Whole days only.').min(0, 'From 0 to 90 days.').max(90, 'From 0 to 90 days.'),
  timezone: z.string().trim().min(1, 'Enter a time zone.').max(64),
})
type Values = z.infer<typeof createTenantSchema>

/** "Fresh Café 2" -> "fresh-caf-2": a suggestion only; the server validates and reserves. */
export function suggestSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 40)
    .replace(/-+$/g, '')
}

/**
 * Provision a tenant WITHOUT an owner (fn_platform_create_tenant): restaurant, trial subscription, default configuration rows
 * (roles, stations, categories, payment methods, areas, expense categories as UUID rows) and day 1. The first Tenant Admin is
 * then invited from the tenant page.
 */
export function CreateTenantPage() {
  const navigate = useNavigate()
  const plans = usePlans()
  const create = useCreateTenant()
  const stepUp = useStepUp()
  const [error, setError] = useState<string | null>(null)
  const [slugTouched, setSlugTouched] = useState(false)
  const form = useForm<Values>({
    resolver: zodResolver(createTenantSchema),
    defaultValues: { name: '', slug: '', planId: '', trialDays: 14, timezone: 'Africa/Addis_Ababa' },
  })
  const e = form.formState.errors
  const activePlans = (plans.data ?? []).filter((p) => p.is_active)

  const submit = form.handleSubmit(async (v) => {
    setError(null)
    try {
      const res = await stepUp.run(() => create.mutateAsync(v))
      toast.success('Tenant created. Invite its first Tenant Admin.')
      navigate(`${platformTenantPath(res.restaurant_id)}?invite=1`)
    } catch (err) {
      setError(portalErrorMessage(err))
    }
  })

  const nameField = form.register('name')
  return (
    <div className="mx-auto max-w-2xl space-y-5 p-4 lg:p-6">
      <PageHeader title="Create tenant" description="Creates the restaurant with default configuration. No owner yet: invite one next." />
      <Card title="Restaurant">
        <form onSubmit={(ev) => void submit(ev)} noValidate className="space-y-4">
          <FormField id="tenant-name" label="Restaurant name" error={e.name?.message}>
            {(a) => (
              <Input
                {...a}
                {...nameField}
                onChange={(ev) => {
                  void nameField.onChange(ev)
                  if (!slugTouched) form.setValue('slug', suggestSlug(ev.target.value))
                }}
              />
            )}
          </FormField>
          <FormField id="tenant-slug" label="Slug" hint="Used in the restaurant’s address: /r/<slug>. Cannot be changed later." error={e.slug?.message}>
            {(a) => (
              <Input
                {...a}
                autoComplete="off"
                {...form.register('slug', { onChange: () => setSlugTouched(true) })}
              />
            )}
          </FormField>
          <FormField id="tenant-plan-select" label="Plan" error={e.planId?.message}>
            {(a) => (
              <NativeSelect {...a} {...form.register('planId')}>
                <option value="">Choose a plan</option>
                {activePlans.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({formatEtb(p.price_etb_monthly)} / month)
                  </option>
                ))}
              </NativeSelect>
            )}
          </FormField>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField id="tenant-trial" label="Trial days" hint="0 starts the subscription as active." error={e.trialDays?.message}>
              {(a) => <Input {...a} inputMode="numeric" {...form.register('trialDays')} />}
            </FormField>
            <FormField id="tenant-tz" label="Time zone" error={e.timezone?.message}>
              {(a) => <Input {...a} autoComplete="off" {...form.register('timezone')} />}
            </FormField>
          </div>
          <FormError message={error} />
          <Button type="submit" disabled={create.isPending}>
            {create.isPending ? 'Creating…' : 'Create tenant'}
          </Button>
        </form>
      </Card>
      {stepUp.dialog}
    </div>
  )
}
