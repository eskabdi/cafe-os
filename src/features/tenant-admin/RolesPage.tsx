import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Lock } from 'lucide-react'
import { toast } from 'sonner'
import { Card, PageHeader } from '@/components/portal/page-header'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { FormError, FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { useAuth, useStepUp } from '@/features/auth'
import { EmptyState, ErrorState, PageSkeleton } from '@/features/shell/states'
import {
  ICON_SLUG_RE,
  STRICT_HEX_RE,
  canEditRoleColumn,
  diffKeys,
  groupPermissions,
  isSystemRole,
  isTenantAdminRole,
  normalizeKeys,
  sameKeySet,
} from '@/lib/domain/portal'
import { portalErrorMessage } from '@/lib/supabase/portal-errors'
import type { RoleInput, TenantRole } from '@/lib/supabase/tenant-admin'
import { useAllStations, usePermissionsCatalogue, useRoleCommand, useRoles } from './useTenantAdmin'

function RoleDialog({
  role,
  open,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  role: TenantRole | null
  open: boolean
  busy: boolean
  error: string | null
  onSubmit: (r: RoleInput) => void
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [color, setColor] = useState('')
  const [icon, setIcon] = useState('')
  const [local, setLocal] = useState<string | null>(null)
  useEffect(() => {
    if (!open) return
    setName(role?.name ?? '')
    setDescription(role?.description ?? '')
    setColor(role?.color ?? '')
    setIcon(role?.icon ?? '')
    setLocal(null)
  }, [open, role])
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const n = name.trim()
    if (n.length < 2 || n.length > 40) return setLocal('Enter a name of 2 to 40 characters.')
    if (color.trim() && !STRICT_HEX_RE.test(color.trim())) return setLocal('The colour uses the form #rrggbb.')
    if (icon.trim() && !ICON_SLUG_RE.test(icon.trim())) return setLocal('The icon is a short lowercase name such as "utensils".')
    onSubmit({ name: n, description: description.trim() || null, color: color.trim().toLowerCase() || null, icon: icon.trim() || null })
  }
  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{role ? 'Edit role' : 'New role'}</DialogTitle>
          <DialogDescription>Rights are set in the permission matrix below.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <FormField id="ro-name" label="Name">
            {(a) => <Input {...a} value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />}
          </FormField>
          <FormField id="ro-desc" label="Description">
            {(a) => <Input {...a} value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} />}
          </FormField>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField id="ro-color" label="Colour" hint="#rrggbb, optional">
              {(a) => <Input {...a} value={color} maxLength={7} onChange={(e) => setColor(e.target.value)} />}
            </FormField>
            <FormField id="ro-icon" label="Icon" hint="optional">
              {(a) => <Input {...a} value={icon} maxLength={40} onChange={(e) => setIcon(e.target.value)} />}
            </FormField>
          </div>
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

function MatrixEditor({ role, onSaved }: { role: TenantRole; onSaved: () => void }) {
  const { can, context } = useAuth()
  const perms = usePermissionsCatalogue()
  const stations = useAllStations()
  const cmd = useRoleCommand()
  const stepUp = useStepUp()
  const [keys, setKeys] = useState<string[]>(role.permission_keys)
  const [stationIds, setStationIds] = useState<string[]>(role.station_ids)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setKeys(role.permission_keys)
    setStationIds(role.station_ids)
    setError(null)
  }, [role])
  const edit = canEditRoleColumn(role, { roleId: context?.role?.id, isTenantAdmin: isTenantAdminRole(context?.role), can })
  const groups = useMemo(() => groupPermissions(perms.data ?? []), [perms.data])
  const dirty = !sameKeySet(keys, role.permission_keys) || !sameKeySet(stationIds, role.station_ids)
  const toggle = (list: string[], set: (v: string[]) => void, k: string) => set(list.includes(k) ? list.filter((x) => x !== k) : [...list, k])
  const save = () => {
    setError(null)
    stepUp
      .run(() => cmd.mutateAsync({ kind: 'matrix', id: role.id, keys: normalizeKeys(keys), stationIds: normalizeKeys(stationIds) }))
      .then(() => {
        const d = diffKeys(role.permission_keys, keys)
        toast.success(`Saved: ${d.added.length} right(s) added, ${d.removed.length} removed.`)
        onSaved()
      })
      .catch((e: unknown) => setError(portalErrorMessage(e)))
  }
  const lockText =
    edit.reason === 'system'
      ? 'The Tenant Admin role always has every right and cannot be changed.'
      : edit.reason === 'own_role'
        ? 'You cannot change the rights of your own role.'
        : edit.reason === 'covers'
          ? 'This role holds rights you do not hold yourself, so only a Tenant Admin can change it.'
          : null
  if (perms.isPending || stations.isPending) return <p role="status" className="text-sm text-muted-foreground">Loading the matrix…</p>
  if (perms.isError || stations.isError) return <p role="alert" className="text-sm text-status-error">The permission catalogue could not be loaded.</p>
  return (
    <Card title={`Rights of ${role.name}`}>
      {lockText && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Lock aria-hidden="true" className="h-4 w-4" /> {lockText}
        </p>
      )}
      <p className="text-sm text-muted-foreground">
        Saving the matrix is a very sensitive action: it asks a fresh code from your authenticator app (at most once every 12 hours).
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        {groups.map((g) => (
          <fieldset key={g.module} className="space-y-1 rounded-md border border-line p-3">
            <legend className="px-1 text-sm font-semibold capitalize text-ink">{g.module.replace(/_/g, ' ')}</legend>
            {g.items.map((p) => (
              <label key={p.key} className="flex min-h-[44px] items-center gap-3 text-sm text-ink">
                <input
                  type="checkbox"
                  className="h-5 w-5 accent-primary"
                  disabled={!edit.editable}
                  checked={isSystemRole(role) || keys.includes(p.key)}
                  onChange={() => toggle(keys, setKeys, p.key)}
                />
                <span>
                  {p.description} <span className="font-mono text-xs text-muted-foreground">{p.key}</span>
                </span>
              </label>
            ))}
          </fieldset>
        ))}
        <fieldset className="space-y-1 rounded-md border border-line p-3">
          <legend className="px-1 text-sm font-semibold text-ink">Station access</legend>
          {(stations.data ?? []).length === 0 && <p className="text-sm text-muted-foreground">No stations yet.</p>}
          {(stations.data ?? []).map((s) => (
            <label key={s.id} className="flex min-h-[44px] items-center gap-3 text-sm text-ink">
              <input
                type="checkbox"
                className="h-5 w-5 accent-primary"
                disabled={!edit.editable}
                checked={isSystemRole(role) || stationIds.includes(s.id)}
                onChange={() => toggle(stationIds, setStationIds, s.id)}
              />
              {s.name}
              {!s.is_active && <span className="text-xs text-muted-foreground">(inactive)</span>}
            </label>
          ))}
        </fieldset>
      </div>
      <FormError message={error} />
      {edit.editable && (
        <div className="flex gap-2">
          <Button onClick={save} disabled={!dirty || cmd.isPending}>
            {cmd.isPending ? 'Saving…' : 'Save rights'}
          </Button>
          <Button
            variant="outline"
            disabled={!dirty || cmd.isPending}
            onClick={() => {
              setKeys(role.permission_keys)
              setStationIds(role.station_ids)
            }}
          >
            Discard changes
          </Button>
        </div>
      )}
      {stepUp.dialog}
    </Card>
  )
}

/** Tenant Portal > Roles: roles (create, edit, deactivate, delete) and the permission matrix with station access. */
export function RolesPage() {
  const roles = useRoles()
  const cmd = useRoleCommand()
  const stepUp = useStepUp()
  const [selected, setSelected] = useState<string | null>(null)
  const [dialog, setDialog] = useState<TenantRole | 'new' | null>(null)
  const [confirm, setConfirm] = useState<{ role: TenantRole; kind: 'deactivate' | 'reactivate' | 'delete' } | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (roles.isPending) return <PageSkeleton label="Loading roles" />
  if (roles.isError) return <ErrorState title="Roles could not be loaded" onRetry={() => void roles.refetch()} />
  const list = roles.data
  const current = list.find((r) => r.id === selected) ?? null
  const done = (msg: string, close: () => void) => () => {
    toast.success(msg)
    setError(null)
    close()
  }
  const submitRole = (r: RoleInput) => {
    const d = dialog
    stepUp
      .run(() => (d === 'new' ? cmd.mutateAsync({ kind: 'create', role: r }) : cmd.mutateAsync({ kind: 'update', id: (d as TenantRole).id, patch: r })))
      .then(done(d === 'new' ? 'Role created.' : 'Role saved.', () => setDialog(null)))
      .catch((e: unknown) => setError(portalErrorMessage(e)))
  }
  const runConfirm = () => {
    const c = confirm
    if (!c) return
    stepUp
      .run(() =>
        c.kind === 'delete'
          ? cmd.mutateAsync({ kind: 'delete', id: c.role.id })
          : cmd.mutateAsync({ kind: 'active', id: c.role.id, active: c.kind === 'reactivate' }),
      )
      .then(
        done(c.kind === 'delete' ? 'Role deleted.' : c.kind === 'deactivate' ? 'Role deactivated.' : 'Role reactivated.', () => {
          setConfirm(null)
          if (c.kind === 'delete') setSelected(null)
        }),
      )
      .catch((e: unknown) => setError(portalErrorMessage(e)))
  }
  return (
    <div className="space-y-5 p-4 lg:p-6">
      <PageHeader title="Roles" description="Roles group rights. The database enforces every right; this page only edits them." actions={<Button onClick={() => setDialog('new')}>New role</Button>} />
      {list.length === 0 ? (
        <EmptyState title="No roles">Create the first role.</EmptyState>
      ) : (
        <ul className="divide-y divide-line rounded-card border border-line bg-white" aria-label="Roles">
          {list.map((r) => {
            const system = isSystemRole(r)
            return (
              <li key={r.id} className={`flex flex-wrap items-center gap-3 p-4 ${selected === r.id ? 'bg-primary/5' : ''}`}>
                <span aria-hidden="true" className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: r.color ?? '#9ca3af' }} />
                <div className="min-w-0 flex-1">
                  <p className={r.is_active ? 'font-medium text-ink' : 'font-medium text-muted-foreground'}>
                    {r.name} {system && <Lock aria-label="system role" className="inline h-4 w-4 text-muted-foreground" />}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {Number(r.active_users)} active user(s) · {r.permission_keys.length} right(s){!r.is_active && ' · inactive'}
                  </p>
                </div>
                <Button variant="ghost" onClick={() => setSelected(selected === r.id ? null : r.id)} aria-pressed={selected === r.id}>
                  Rights
                </Button>
                {!system && (
                  <>
                    <Button variant="ghost" onClick={() => setDialog(r)}>
                      Edit
                    </Button>
                    <Button variant="outline" onClick={() => setConfirm({ role: r, kind: r.is_active ? 'deactivate' : 'reactivate' })}>
                      {r.is_active ? 'Deactivate' : 'Reactivate'}
                    </Button>
                    {Number(r.total_users) === 0 && (
                      <Button variant="ghost" onClick={() => setConfirm({ role: r, kind: 'delete' })}>
                        Delete
                      </Button>
                    )}
                  </>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {current && <MatrixEditor role={current} onSaved={() => void roles.refetch()} />}
      <RoleDialog
        role={dialog === 'new' ? null : dialog}
        open={dialog !== null}
        busy={cmd.isPending}
        error={dialog ? error : null}
        onSubmit={submitRole}
        onClose={() => {
          setDialog(null)
          setError(null)
        }}
      />
      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.kind === 'delete' ? 'Delete this role?' : confirm?.kind === 'deactivate' ? 'Deactivate this role?' : 'Reactivate this role?'}
        description={
          confirm?.kind === 'delete'
            ? 'Only a role nobody ever held can be deleted. Otherwise deactivate it.'
            : confirm?.kind === 'deactivate'
              ? 'It can no longer be assigned. Users still holding it must be moved first.'
              : 'It can be assigned again.'
        }
        confirmLabel={confirm?.kind === 'delete' ? 'Delete' : confirm?.kind === 'deactivate' ? 'Deactivate' : 'Reactivate'}
        busy={cmd.isPending}
        error={confirm ? error : null}
        onConfirm={runConfirm}
        onCancel={() => {
          setConfirm(null)
          setError(null)
        }}
      />
      {stepUp.dialog}
    </div>
  )
}
