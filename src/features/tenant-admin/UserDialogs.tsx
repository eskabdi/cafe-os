import { useEffect, useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { FormError, FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/select'
import { USERNAME_RE } from '@/lib/domain/portal'
import type { TenantRole, TenantUser } from '@/lib/supabase/tenant-admin'

const NAME_MAX = 60
const PIN_RE = /^(\d{4}|\d{6})$/

const clean = (v: string) => v.trim()
const orNull = (v: string) => (v.trim() ? v.trim() : null)

/** Roles a new or moved user may get: active, non-system (a Tenant Admin is invited by e-mail, never given a PIN role). */
export function assignableRoles(roles: readonly TenantRole[]): TenantRole[] {
  return roles.filter((r) => r.is_active && !r.is_system && !r.system_key)
}

function NameFields({
  prefix,
  first,
  middle,
  last,
  set,
}: {
  prefix: string
  first: string
  middle: string
  last: string
  set: (k: 'first' | 'middle' | 'last', v: string) => void
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <FormField id={`${prefix}-first`} label="First name">
        {(a) => <Input {...a} value={first} maxLength={NAME_MAX} onChange={(e) => set('first', e.target.value)} />}
      </FormField>
      <FormField id={`${prefix}-middle`} label="Middle name" hint="Father’s name">
        {(a) => <Input {...a} value={middle} maxLength={NAME_MAX} onChange={(e) => set('middle', e.target.value)} />}
      </FormField>
      <FormField id={`${prefix}-last`} label="Last name" hint="Grandfather’s name">
        {(a) => <Input {...a} value={last} maxLength={NAME_MAX} onChange={(e) => set('last', e.target.value)} />}
      </FormField>
    </div>
  )
}

export interface NewStaffValues {
  firstName: string
  middleName: string | null
  lastName: string | null
  username: string
  roleId: string
  pin: string
}

/** Create a PIN staff member (staff-create). The PIN is checked again by the server (length by role, weak PINs refused). */
export function CreateStaffDialog({
  open,
  roles,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  open: boolean
  roles: readonly TenantRole[]
  busy: boolean
  error: string | null
  onSubmit: (v: NewStaffValues) => void
  onClose: () => void
}) {
  const options = assignableRoles(roles)
  const [names, setNames] = useState({ first: '', middle: '', last: '' })
  const [username, setUsername] = useState('')
  const [roleId, setRoleId] = useState('')
  const [pin, setPin] = useState('')
  const [local, setLocal] = useState<string | null>(null)
  useEffect(() => {
    if (open) {
      setNames({ first: '', middle: '', last: '' })
      setUsername('')
      setRoleId(options[0]?.id ?? '')
      setPin('')
      setLocal(null)
    }
    // reset only when the dialog opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  const submit = (e: FormEvent) => {
    e.preventDefault()
    setLocal(null)
    if (!clean(names.first)) return setLocal('Enter a first name.')
    if (!USERNAME_RE.test(username.trim().toLowerCase())) return setLocal('Use 2 to 32 lowercase letters, digits, dot, underscore or hyphen for the username.')
    if (!roleId) return setLocal('Choose a role.')
    if (!PIN_RE.test(pin)) return setLocal('The PIN has 4 digits (6 for the cashier role).')
    onSubmit({
      firstName: clean(names.first),
      middleName: orNull(names.middle),
      lastName: orNull(names.last),
      username: username.trim().toLowerCase(),
      roleId,
      pin,
    })
  }
  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add staff member</DialogTitle>
          <DialogDescription>Staff sign in with a PIN. Give the person their PIN in private; they can change it later.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <NameFields prefix="ns" {...names} set={(k, v) => setNames((n) => ({ ...n, [k]: v }))} />
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField id="ns-username" label="Username">
              {(a) => <Input {...a} value={username} maxLength={32} autoComplete="off" onChange={(e) => setUsername(e.target.value)} />}
            </FormField>
            <FormField id="ns-role" label="Role">
              {(a) => (
                <NativeSelect {...a} value={roleId} onChange={(e) => setRoleId(e.target.value)}>
                  {options.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </FormField>
          </div>
          <FormField id="ns-pin" label="PIN" hint="4 digits (6 for the cashier role). Avoid 1234 or 1111.">
            {(a) => (
              <Input
                {...a}
                type="password"
                inputMode="numeric"
                autoComplete="new-password"
                maxLength={6}
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/[^0-9]/g, ''))}
              />
            )}
          </FormField>
          <FormError message={local ?? error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || options.length === 0}>
              {busy ? 'Adding…' : 'Add staff member'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Edit names, move to another role. Unchanged fields are not sent. */
export function EditUserDialog({
  user,
  roles,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  user: TenantUser | null
  roles: readonly TenantRole[]
  busy: boolean
  error: string | null
  onSubmit: (v: { first: string; middle: string | null; last: string | null; roleId: string }) => void
  onClose: () => void
}) {
  const [names, setNames] = useState({ first: '', middle: '', last: '' })
  const [roleId, setRoleId] = useState('')
  const [local, setLocal] = useState<string | null>(null)
  useEffect(() => {
    if (user) {
      setNames({ first: user.first_name, middle: user.middle_name ?? '', last: user.last_name ?? '' })
      setRoleId(user.role.id)
      setLocal(null)
    }
  }, [user])
  const options = user?.role.system_key ? [] : assignableRoles(roles)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!clean(names.first)) return setLocal('Enter a first name.')
    onSubmit({ first: clean(names.first), middle: orNull(names.middle), last: orNull(names.last), roleId })
  }
  return (
    <Dialog open={user !== null} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit user</DialogTitle>
          <DialogDescription>Names follow the Ethiopian order: first, middle (father), last (grandfather).</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <NameFields prefix="eu" {...names} set={(k, v) => setNames((n) => ({ ...n, [k]: v }))} />
          {user && !user.role.system_key && (
            <FormField id="eu-role" label="Role">
              {(a) => (
                <NativeSelect {...a} value={roleId} onChange={(e) => setRoleId(e.target.value)}>
                  {!options.some((r) => r.id === user.role.id) && <option value={user.role.id}>{user.role.name}</option>}
                  {options.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </FormField>
          )}
          <FormError message={local ?? error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Admin PIN reset (staff-pin-reset): the person is signed out and must choose their own PIN at the next sign-in. */
export function ResetPinDialog({
  user,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  user: TenantUser | null
  busy: boolean
  error: string | null
  onSubmit: (pin: string) => void
  onClose: () => void
}) {
  const [pin, setPin] = useState('')
  const [local, setLocal] = useState<string | null>(null)
  useEffect(() => {
    setPin('')
    setLocal(null)
  }, [user])
  const len = user?.pin?.length === 6 ? 6 : 4
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!new RegExp(`^\\d{${len}}$`).test(pin)) return setLocal(`Enter a temporary PIN of ${len} digits.`)
    onSubmit(pin)
  }
  return (
    <Dialog open={user !== null} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reset PIN</DialogTitle>
          <DialogDescription>
            {user?.short_name ?? user?.first_name} is signed out everywhere and must choose a new PIN after signing in with this
            temporary one.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <FormField id="rp-pin" label={`Temporary PIN (${len} digits)`}>
            {(a) => (
              <Input
                {...a}
                type="password"
                inputMode="numeric"
                autoComplete="new-password"
                maxLength={len}
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/[^0-9]/g, ''))}
              />
            )}
          </FormField>
          <FormError message={local ?? error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? 'Resetting…' : 'Reset PIN and sign out'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
