import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Card, PageHeader } from '@/components/portal/page-header'
import { Button } from '@/components/ui/button'
import { FormError, FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { useAuth, useStepUp } from '@/features/auth'
import { ErrorState, PageSkeleton } from '@/features/shell/states'
import { STRICT_HEX_RE, checkLogoFile } from '@/lib/domain/portal'
import { removeLogo, signedLogoUrl, uploadLogo } from '@/lib/supabase/branding-logo'
import { portalErrorMessage } from '@/lib/supabase/portal-errors'
import type { RestaurantProfile } from '@/lib/supabase/tenant-admin'
import { useRestaurantProfile, useSaveBranding, useSaveBusiness, useSaveProfile } from './useTenantAdmin'

const PHONE_RE = /^\+?[0-9 ()-]{7,20}$/
const DEFAULT_PRIMARY = '#dc2626'
const DEFAULT_ACCENT = '#b91c1c'

function ProfileCard({ p }: { p: RestaurantProfile }) {
  const save = useSaveProfile()
  const stepUp = useStepUp()
  const [name, setName] = useState(p.name)
  const [phone, setPhone] = useState(p.phone ?? '')
  const [address, setAddress] = useState(p.address ?? '')
  const [timezone, setTimezone] = useState(p.timezone)
  const [error, setError] = useState<string | null>(null)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (name.trim().length < 2 || name.trim().length > 80) return setError('Enter a name of 2 to 80 characters.')
    if (phone.trim() && !PHONE_RE.test(phone.trim())) return setError('Enter a phone number with digits only, e.g. +251 911 223344.')
    stepUp
      .run(() =>
        save.mutateAsync({ name: name.trim(), phone: phone.trim() || null, address: address.trim() || null, timezone: timezone.trim() }),
      )
      .then(() => toast.success('Restaurant details saved.'))
      .catch((err: unknown) => setError(portalErrorMessage(err)))
  }
  return (
    <Card title="Restaurant details">
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2" noValidate>
        <FormField id="rp-name" label="Name">
          {(a) => <Input {...a} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />}
        </FormField>
        <FormField id="rp-phone" label="Phone">
          {(a) => <Input {...a} inputMode="tel" value={phone} maxLength={20} onChange={(e) => setPhone(e.target.value)} />}
        </FormField>
        <FormField id="rp-address" label="Address">
          {(a) => <Input {...a} value={address} maxLength={200} onChange={(e) => setAddress(e.target.value)} />}
        </FormField>
        <FormField id="rp-tz" label="Time zone" hint="IANA name, e.g. Africa/Addis_Ababa">
          {(a) => <Input {...a} value={timezone} maxLength={64} onChange={(e) => setTimezone(e.target.value)} />}
        </FormField>
        <div className="space-y-2 sm:col-span-2">
          <FormError message={error} />
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save details'}
          </Button>
        </div>
      </form>
      {stepUp.dialog}
    </Card>
  )
}

function BusinessCard({ p }: { p: RestaurantProfile }) {
  const save = useSaveBusiness()
  const stepUp = useStepUp()
  const [tin, setTin] = useState(p.tin ?? '')
  const [vat, setVat] = useState(String(p.vat_rate))
  const [float, setFloat] = useState(String(p.opening_float))
  const [autoConsume, setAutoConsume] = useState(p.auto_consume_stock)
  const [error, setError] = useState<string | null>(null)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!/^\d{1,2}(\.\d{1,2})?$/.test(vat.trim())) return setError('VAT is a percentage between 0 and 99.99.')
    if (!/^\d{1,9}(\.\d{1,2})?$/.test(float.trim())) return setError('The opening float is an amount in ETB with at most 2 decimals.')
    if (tin.trim() && !/^\d{10}$/.test(tin.trim())) return setError('The TIN has 10 digits.')
    stepUp
      .run(() =>
        save.mutateAsync({
          tin: tin.trim() || null,
          vat_rate: Number(vat.trim()),
          opening_float: Number(float.trim()),
          auto_consume_stock: autoConsume,
        }),
      )
      .then(() => toast.success('Business settings saved.'))
      .catch((err: unknown) => setError(portalErrorMessage(err)))
  }
  return (
    <Card title="Business settings">
      <p className="text-sm text-muted-foreground">Money settings need verification with your authenticator app.</p>
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2" noValidate>
        <FormField id="bs-tin" label="TIN">
          {(a) => <Input {...a} inputMode="numeric" value={tin} maxLength={10} onChange={(e) => setTin(e.target.value.replace(/[^0-9]/g, ''))} />}
        </FormField>
        <FormField id="bs-vat" label="VAT (%)">
          {(a) => <Input {...a} inputMode="decimal" value={vat} maxLength={5} onChange={(e) => setVat(e.target.value)} />}
        </FormField>
        <FormField id="bs-float" label="Opening float (ETB)">
          {(a) => <Input {...a} inputMode="decimal" value={float} maxLength={12} onChange={(e) => setFloat(e.target.value)} />}
        </FormField>
        <label className="flex min-h-[44px] items-center gap-3 self-end text-sm text-ink">
          <input type="checkbox" className="h-5 w-5 accent-primary" checked={autoConsume} onChange={(e) => setAutoConsume(e.target.checked)} />
          Deduct stock automatically from recipes
        </label>
        <div className="space-y-2 sm:col-span-2">
          <FormError message={error} />
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save business settings'}
          </Button>
        </div>
      </form>
      {stepUp.dialog}
    </Card>
  )
}

function ColorInput({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (v: string) => void }) {
  return (
    <FormField id={id} label={label} hint="#rrggbb" error={STRICT_HEX_RE.test(value) ? undefined : 'Use the form #rrggbb.'}>
      {(a) => (
        <div className="flex items-center gap-2">
          <input
            type="color"
            aria-label={`${label} picker`}
            className="h-11 w-14 cursor-pointer rounded border border-line"
            value={STRICT_HEX_RE.test(value) ? value : '#000000'}
            onChange={(e) => onChange(e.target.value)}
          />
          <Input {...a} value={value} maxLength={7} onChange={(e) => onChange(e.target.value.trim())} />
        </div>
      )}
    </FormField>
  )
}

function BrandingCard({ p }: { p: RestaurantProfile }) {
  const { context } = useAuth()
  const rid = context?.restaurant?.id ?? ''
  const save = useSaveBranding()
  const stepUp = useStepUp()
  const [primary, setPrimary] = useState(p.branding?.primary_color ?? DEFAULT_PRIMARY)
  const [accent, setAccent] = useState(p.branding?.accent_color ?? DEFAULT_ACCENT)
  const [logoPath, setLogoPath] = useState<string | null>(p.branding?.logo_path ?? null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const uploaded = useRef<string | null>(null)
  const logoUrl = useQuery({
    queryKey: ['tenant-admin', rid, 'logo-url', logoPath ?? ''],
    queryFn: () => (logoPath ? signedLogoUrl(logoPath) : Promise.resolve(null)),
    staleTime: 30 * 60_000,
  })
  // an uploaded logo that was never applied is removed when the page closes (best effort)
  useEffect(
    () => () => {
      if (uploaded.current) void removeLogo(uploaded.current)
    },
    [],
  )
  const pick = async (file: File | undefined) => {
    if (!file) return
    setError(null)
    const check = checkLogoFile(file)
    if (!check.ok) return setError('Choose a PNG, JPEG or WebP image of at most 1 MiB.')
    setUploading(true)
    try {
      if (uploaded.current) void removeLogo(uploaded.current)
      const path = await uploadLogo(rid, file)
      uploaded.current = path
      setLogoPath(path)
    } catch (e) {
      setError(portalErrorMessage(e))
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!STRICT_HEX_RE.test(primary) || !STRICT_HEX_RE.test(accent)) return setError('Colours use the form #rrggbb.')
    stepUp
      .run(() => save.mutateAsync({ primary, accent, logoPath }))
      .then(() => {
        uploaded.current = null
        toast.success('Branding saved.')
      })
      .catch((err: unknown) => setError(portalErrorMessage(err)))
  }
  return (
    <Card title="Branding">
      <p className="text-sm text-muted-foreground">
        Your colours replace the CafeOS red in buttons and highlights. Status colours (cancelled, overdue, errors) never change.
      </p>
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2" noValidate>
        <ColorInput id="br-primary" label="Primary colour" value={primary} onChange={setPrimary} />
        <ColorInput id="br-accent" label="Accent colour" value={accent} onChange={setAccent} />
        <div className="flex items-center gap-3 sm:col-span-2" aria-label="Preview">
          <span className="rounded-md px-4 py-2 text-sm font-semibold text-white" style={{ backgroundColor: STRICT_HEX_RE.test(primary) ? primary : DEFAULT_PRIMARY }}>
            Primary
          </span>
          <span className="rounded-md px-4 py-2 text-sm font-semibold text-white" style={{ backgroundColor: STRICT_HEX_RE.test(accent) ? accent : DEFAULT_ACCENT }}>
            Accent
          </span>
        </div>
        <div className="space-y-2 sm:col-span-2">
          <p className="text-sm font-medium text-ink">Logo</p>
          <div className="flex flex-wrap items-center gap-3">
            {logoPath && logoUrl.data ? (
              <img src={logoUrl.data} alt="Restaurant logo" className="h-16 w-16 rounded border border-line object-contain" />
            ) : (
              <span className="flex h-16 w-16 items-center justify-center rounded border border-dashed border-line text-xs text-muted-foreground">
                {logoPath ? '…' : 'No logo'}
              </span>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="sr-only"
              id="br-logo"
              onChange={(e) => void pick(e.target.files?.[0])}
            />
            <Button type="button" variant="outline" disabled={uploading} onClick={() => fileRef.current?.click()}>
              {uploading ? 'Uploading…' : logoPath ? 'Replace logo' : 'Upload logo'}
            </Button>
            {logoPath && (
              <Button type="button" variant="ghost" onClick={() => setLogoPath(null)}>
                Remove logo
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">PNG, JPEG or WebP, at most 1 MiB. Shown on your sign-in page.</p>
        </div>
        <div className="space-y-2 sm:col-span-2">
          <FormError message={error} />
          <Button type="submit" disabled={save.isPending || uploading}>
            {save.isPending ? 'Saving…' : 'Save branding'}
          </Button>
        </div>
      </form>
      {stepUp.dialog}
    </Card>
  )
}

/** Tenant Portal > Settings > Restaurant: details, business (money) settings and branding. The server re-checks everything. */
export function RestaurantSettingsPage() {
  const profile = useRestaurantProfile()
  if (profile.isPending) return <PageSkeleton label="Loading the restaurant settings" />
  if (profile.isError) return <ErrorState title="The restaurant settings could not be loaded" onRetry={() => void profile.refetch()} />
  const p = profile.data
  return (
    <div className="mx-auto max-w-3xl space-y-5 p-4 lg:p-6">
      <PageHeader title="Restaurant" description={`Web address: /r/${p.slug} (set by CafeOS).`} />
      <ProfileCard key={`p-${p.updated_at ?? ''}`} p={p} />
      <BusinessCard key={`b-${p.updated_at ?? ''}`} p={p} />
      <BrandingCard key={`br-${p.updated_at ?? ''}`} p={p} />
    </div>
  )
}
