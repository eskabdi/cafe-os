import { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { FormError, FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { USERNAME_RE } from '@/lib/domain/portal'

export const inviteSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(254, 'Enter a valid e-mail address.')
    .regex(/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i, 'Enter a valid e-mail address.')
    .refine((v) => !v.endsWith('.invalid'), 'Enter a valid e-mail address.'),
  firstName: z.string().trim().min(1, 'Enter a first name.').max(60, 'At most 60 characters.'),
  middleName: z.string().trim().max(60, 'At most 60 characters.'),
  lastName: z.string().trim().max(60, 'At most 60 characters.'),
  username: z
    .string()
    .trim()
    .toLowerCase()
    .regex(USERNAME_RE, 'Use 2 to 32 lowercase letters, digits, dot, underscore or hyphen.'),
})
export type InviteValues = z.infer<typeof inviteSchema>

/**
 * Invite a Tenant Admin by e-mail (tenant-admin-invite). Used by the Super Admin (for a named tenant) and by a tenant_admin
 * (own tenant; no tenant id sent). The invitee gets an e-mail link, sets a password and accepts. Names: First + Middle + Last.
 */
export function InviteTenantAdminDialog({
  open,
  tenantName,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  open: boolean
  tenantName: string
  busy: boolean
  error: string | null
  onSubmit: (v: InviteValues) => void
  onClose: () => void
}) {
  const form = useForm<InviteValues>({
    resolver: zodResolver(inviteSchema),
    defaultValues: { email: '', firstName: '', middleName: '', lastName: '', username: '' },
  })
  useEffect(() => {
    if (open) form.reset({ email: '', firstName: '', middleName: '', lastName: '', username: '' })
  }, [open, form])
  const e = form.formState.errors

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="space-y-4">
          <DialogHeader>
            <DialogTitle>Invite a Tenant Admin</DialogTitle>
            <DialogDescription>
              {tenantName}: the person receives an e-mail link, sets a password and becomes a Tenant Admin. The invitation is valid for 7
              days.
            </DialogDescription>
          </DialogHeader>
          <FormField id="invite-email" label="E-mail" error={e.email?.message}>
            {(a) => <Input {...a} type="email" autoComplete="off" {...form.register('email')} />}
          </FormField>
          <div className="grid gap-3 sm:grid-cols-3">
            <FormField id="invite-first" label="First name" error={e.firstName?.message}>
              {(a) => <Input {...a} {...form.register('firstName')} />}
            </FormField>
            <FormField id="invite-middle" label="Middle name" error={e.middleName?.message}>
              {(a) => <Input {...a} {...form.register('middleName')} />}
            </FormField>
            <FormField id="invite-last" label="Last name" error={e.lastName?.message}>
              {(a) => <Input {...a} {...form.register('lastName')} />}
            </FormField>
          </div>
          <FormField id="invite-username" label="Username" hint="Shown in the restaurant; lowercase." error={e.username?.message}>
            {(a) => <Input {...a} autoComplete="off" {...form.register('username')} />}
          </FormField>
          <FormError message={error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? 'Sending…' : 'Send invitation'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
