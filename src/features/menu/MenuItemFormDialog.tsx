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
import { NativeSelect, Textarea } from '@/components/ui/select'
import { useRestaurantId } from '@/hooks/useReferenceData'
import { pickerRows } from '@/lib/domain/inventory'
import type { MenuItem } from '@/lib/supabase/menu'
import { removeMenuImage, uploadMenuImage } from '@/lib/supabase/menu-images'
import { errorField, menuInventoryErrorMessage } from '@/lib/supabase/menu-inventory-errors'
import type { CategoryRow } from '@/lib/supabase/reference-data'
import type { StationRow } from '@/lib/supabase/stations'
import {
  emptyMenuForm,
  menuFormFromItem,
  menuItemFormSchema,
  menuItemPatch,
  toMenuItemInput,
  type MenuItemFormValues,
} from './menu-form'
import { PhotoPicker, type PhotoChoice } from './PhotoPicker'
import { useCreateMenuItem, useUpdateMenuItem } from './useMenu'

const FORM_FIELDS = new Set<keyof MenuItemFormValues>([
  'name',
  'price',
  'category_id',
  'station_id',
  'description',
  'emoji',
  'sort_order',
])

/** Create (item = null) or edit a menu item, with an optional image upload to the tenant's private menu-images prefix. */
export function MenuItemFormDialog({
  open,
  item,
  categories,
  stations,
  onClose,
}: {
  open: boolean
  item: MenuItem | null
  categories: CategoryRow[]
  stations: StationRow[]
  onClose: () => void
}) {
  const rid = useRestaurantId()
  const create = useCreateMenuItem()
  const update = useUpdateMenuItem()
  const [photo, setPhoto] = useState<PhotoChoice>({ kind: 'keep' })
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const form = useForm<MenuItemFormValues>({
    resolver: zodResolver(menuItemFormSchema),
    defaultValues: emptyMenuForm(),
  })
  const { register, handleSubmit, reset, setError, watch, formState } = form

  useEffect(() => {
    if (!open) return
    reset(item ? menuFormFromItem(item) : emptyMenuForm())
    setPhoto({ kind: 'keep' })
    setFormError(null)
  }, [open, item, reset])

  const categoryId = watch('category_id')
  const stationId = watch('station_id')
  const categoryOptions = pickerRows(categories, item?.category_id ?? categoryId)
  const stationOptions = pickerRows(stations, item?.station_id ?? stationId)

  const submit = async (values: MenuItemFormValues) => {
    setFormError(null)
    setBusy(true)
    let uploaded: string | null = null
    try {
      if (photo.kind === 'new') uploaded = await uploadMenuImage(rid, photo.file)
      if (!item) {
        await create.mutateAsync(toMenuItemInput(values, uploaded))
        toast.success('Menu item created')
      } else {
        // new path / null = remove (fn_update_menu_item clears image_path on null) / undefined = unchanged
        const image = uploaded ?? (photo.kind === 'remove' ? null : undefined)
        const patch = menuItemPatch(item, values, image)
        if (Object.keys(patch).length > 0) {
          await update.mutateAsync({ id: item.id, patch })
          // the previous image is no longer referenced: remove it (best effort; the policy refuses a referenced one)
          if (patch.image_path !== undefined && item.image_path) void removeMenuImage(item.image_path)
        }
        toast.success('Menu item saved')
      }
      onClose()
    } catch (err) {
      if (uploaded) void removeMenuImage(uploaded) // nothing points at it: do not leave an orphan
      const field = errorField(err)
      if (field && FORM_FIELDS.has(field as keyof MenuItemFormValues)) {
        setError(
          field as keyof MenuItemFormValues,
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
    <Dialog open={open} onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <form noValidate className="space-y-4" onSubmit={(ev) => void handleSubmit(submit)(ev)}>
          <DialogHeader>
            <DialogTitle>{item ? 'Edit menu item' : 'New menu item'}</DialogTitle>
            <DialogDescription>Prices are in ETB. The server checks every value again.</DialogDescription>
          </DialogHeader>

          <FormField id="menu-name" label="Name" error={e.name?.message}>
            {(a) => <Input {...a} maxLength={120} autoComplete="off" {...register('name')} />}
          </FormField>
          <FormField
            id="menu-price"
            label="Price (ETB)"
            hint="For example 120 or 120.50"
            error={e.price?.message}
          >
            {(a) => <Input {...a} inputMode="decimal" autoComplete="off" {...register('price')} />}
          </FormField>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField id="menu-category" label="Category" error={e.category_id?.message}>
              {(a) => (
                <NativeSelect {...a} {...register('category_id')}>
                  <option value="">Choose…</option>
                  {categoryOptions.map((c) => (
                    <option key={c.id} value={c.id} disabled={!c.is_active}>
                      {c.is_active ? c.name : `${c.name} (inactive)`}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </FormField>
            <FormField id="menu-station" label="Prepared at station" error={e.station_id?.message}>
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
          </div>
          <FormField id="menu-description" label="Description (optional)" error={e.description?.message}>
            {(a) => <Textarea {...a} maxLength={500} {...register('description')} />}
          </FormField>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField id="menu-emoji" label="Emoji (optional)" error={e.emoji?.message}>
              {(a) => <Input {...a} autoComplete="off" {...register('emoji')} />}
            </FormField>
            <FormField
              id="menu-sort"
              label="Sort order"
              hint="Lower numbers are listed first"
              error={e.sort_order?.message}
            >
              {(a) => <Input {...a} inputMode="numeric" autoComplete="off" {...register('sort_order')} />}
            </FormField>
          </div>

          <PhotoPicker
            currentPath={item?.image_path ?? null}
            emoji={item?.emoji}
            choice={photo}
            onChange={setPhoto}
            disabled={busy}
          />

          <FormError message={formError} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? 'Saving…' : item ? 'Save changes' : 'Create item'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
