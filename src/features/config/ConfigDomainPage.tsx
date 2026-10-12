import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Tag } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
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
import { NativeSelect } from '@/components/ui/select'
import { useAuth } from '@/features/auth'
import { EmptyState, ErrorState, PageSkeleton } from '@/features/shell/states'
import { ICON_SLUGS, iconForSlug } from '@/features/terminal/tile-icons'
import {
  DOMAIN_SPECS,
  blockingUsage,
  configKey,
  createConfigRow,
  deleteConfigRow,
  describeUsage,
  describeUsageRecord,
  fetchConfigRows,
  fetchConfigUsage,
  updateConfigRow,
  type ConfigDomain,
  type ConfigInput,
  type ConfigRow,
} from '@/lib/supabase/config'
import { errorCode } from '@/lib/supabase/menu-inventory-errors'

const HEX = /^#[0-9a-fA-F]{6}$/

/** Fixed, safe copy for a refused write; the blocking dependency comes from the server's counted detail only. */
function message(err: unknown, singular: string): string {
  const { code, detail } = errorCode(err)
  if (code === 'duplicate_name') return `Another ${singular} already has this name.`
  if (code === 'in_use')
    return `This ${singular} is still used by ${describeUsage(detail)}. Deactivate it instead, or move those first.`
  if (code === 'permission_denied') return 'You do not have permission to change these settings.'
  if (code === 'tenant_suspended' || code === 'tenant_read_only')
    return 'This restaurant account cannot change settings right now.'
  if (code === 'not_found') return `This ${singular} no longer exists. Refresh the list.`
  return 'The change could not be saved. Try again.'
}

/**
 * One generic settings screen for every dynamic domain (Phase 10): rows come from the tenant's own table, presentation (colour,
 * icon) lives on the row, and nothing here knows any row by name. New rows are usable at once (nav, POS, cashier, KDS read them
 * from the database), with no redeploy. Deactivation and deletion are guarded by the database, which names the blocking
 * dependency; the route is gated by the same permission code the server checks.
 */
export function ConfigDomainPage({ domain }: { domain: ConfigDomain }) {
  const spec = DOMAIN_SPECS[domain]
  const { context } = useAuth()
  const rid = context?.restaurant?.id ?? ''
  const qc = useQueryClient()
  const rows = useQuery({
    queryKey: configKey(rid, domain),
    queryFn: () => fetchConfigRows(domain),
    enabled: Boolean(rid),
  })
  const parents = useQuery({
    queryKey: configKey(rid, spec.parent?.domain ?? domain),
    queryFn: () => fetchConfigRows(spec.parent?.domain ?? domain),
    enabled: Boolean(rid && spec.parent),
  })
  const [editing, setEditing] = useState<ConfigRow | 'new' | null>(null)
  const [deleting, setDeleting] = useState<ConfigRow | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const usage = useQuery({
    queryKey: ['config-usage', rid, domain, deleting?.id ?? ''],
    queryFn: () => fetchConfigUsage(domain, deleting?.id ?? ''),
    enabled: Boolean(rid && deleting),
    staleTime: 0,
    gcTime: 0,
  })
  // every screen that renders these rows refreshes (nav stations, POS categories, cashier methods, ...)
  const invalidate = () => void qc.invalidateQueries()

  const toggle = useMutation({
    mutationFn: (r: ConfigRow) => updateConfigRow(domain, r.id, { is_active: !r.is_active }),
    onSuccess: (_d, r) => {
      toast.success(r.is_active ? `${r.name} deactivated` : `${r.name} activated`)
      invalidate()
    },
    onError: (e) => toast.error(message(e, spec.singular)),
  })
  const remove = useMutation({
    mutationFn: (r: ConfigRow) => deleteConfigRow(domain, r.id),
    onSuccess: (_d, r) => {
      setDeleting(null)
      toast.success(`${r.name} deleted`)
      invalidate()
    },
    onError: (e) => setDeleteError(message(e, spec.singular)),
  })

  if (rows.isPending && rid) return <PageSkeleton label={`Loading ${spec.title.toLowerCase()}`} />
  if (rows.isError || !rows.data)
    return <ErrorState title={`${spec.title} could not be loaded`} onRetry={() => void rows.refetch()} />

  const parentName = (id: string | undefined) => parents.data?.find((p) => p.id === id)?.name
  const blockers = usage.data ? blockingUsage(usage.data) : []

  return (
    <div className="space-y-4 p-4 lg:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-ink">{spec.title}</h1>
        <Button onClick={() => setEditing('new')}>Add {spec.singular}</Button>
      </div>
      {rows.data.length === 0 ? (
        <EmptyState title={`No ${spec.title.toLowerCase()} yet`}>
          <p>Add the first one.</p>
        </EmptyState>
      ) : (
        <ul
          aria-label={`All ${spec.title.toLowerCase()}`}
          className="divide-y divide-line rounded-card border border-line bg-white"
        >
          {rows.data.map((r) => {
            const Icon = iconForSlug(r.icon, Tag)
            return (
              <li key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3" data-testid="config-row">
                {spec.presentation && (
                  <span
                    aria-hidden="true"
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-line"
                    style={r.color ? { borderColor: r.color, color: r.color } : undefined}
                  >
                    <Icon className="h-4 w-4" />
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block font-medium text-ink">{r.name}</span>
                  <span className="block text-xs text-muted-foreground">
                    {[
                      r.is_active ? 'Active' : 'Inactive',
                      spec.parent ? parentName(r.table_area_id) : null,
                      r.capacity ? `${r.capacity} seats` : null,
                      r.affects_cash_drawer ? 'cash drawer' : null,
                      r.requires_reference ? 'needs a reference' : null,
                      r.description,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  aria-label={`Edit ${r.name}`}
                  onClick={() => setEditing(r)}
                >
                  Edit
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  aria-label={`${r.is_active ? 'Deactivate' : 'Activate'} ${r.name}`}
                  disabled={toggle.isPending}
                  onClick={() => toggle.mutate(r)}
                >
                  {r.is_active ? 'Deactivate' : 'Activate'}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  aria-label={`Delete ${r.name}`}
                  onClick={() => {
                    setDeleteError(null)
                    setDeleting(r)
                  }}
                >
                  Delete
                </Button>
              </li>
            )
          })}
        </ul>
      )}
      {editing && (
        <EditDialog
          domain={domain}
          row={editing === 'new' ? null : editing}
          parents={(parents.data ?? []).filter(
            (p) => p.is_active || (editing !== 'new' && p.id === editing.table_area_id),
          )}
          nextSort={(rows.data.at(-1)?.sort_order ?? 0) + 10}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            invalidate()
          }}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        title={`Delete ${deleting?.name ?? ''}?`}
        description={
          usage.isPending
            ? 'Checking what uses it...'
            : usage.isError
              ? 'What uses it could not be checked. Close this and try again.'
              : blockers.length > 0 && usage.data
                ? `It cannot be deleted: it is used by ${describeUsageRecord(usage.data)}. Deactivate it instead; history keeps its name.`
                : `Nothing refers to this ${spec.singular}. Deleting it cannot be undone.`
        }
        confirmLabel="Delete"
        busy={remove.isPending}
        confirmDisabled={usage.isPending || usage.isError || blockers.length > 0}
        error={deleteError}
        onConfirm={() => deleting && remove.mutate(deleting)}
        onCancel={() => setDeleting(null)}
      />
    </div>
  )
}

function EditDialog({
  domain,
  row,
  parents,
  nextSort,
  onClose,
  onSaved,
}: {
  domain: ConfigDomain
  row: ConfigRow | null
  parents: ConfigRow[]
  nextSort: number
  onClose: () => void
  onSaved: () => void
}) {
  const spec = DOMAIN_SPECS[domain]
  const { context } = useAuth()
  const rid = context?.restaurant?.id ?? ''
  const [name, setName] = useState(row?.name ?? '')
  const [description, setDescription] = useState(row?.description ?? '')
  const [color, setColor] = useState(row?.color ?? '')
  const [icon, setIcon] = useState(row?.icon ?? '')
  const [sort, setSort] = useState(String(row?.sort_order ?? nextSort))
  const [parentId, setParentId] = useState(row?.table_area_id ?? parents[0]?.id ?? '')
  const [capacity, setCapacity] = useState(String(row?.capacity ?? 4))
  const [flags, setFlags] = useState({
    affects_cash_drawer: row?.affects_cash_drawer ?? false,
    requires_reference: row?.requires_reference ?? false,
  })
  const [error, setError] = useState<string | null>(null)
  const maxName = domain === 'tables' ? 30 : 60
  const colorOk = color === '' || HEX.test(color)
  const sortValue = /^-?\d{1,6}$/.test(sort.trim()) ? Number(sort.trim()) : null
  const capacityValue =
    /^\d{1,3}$/.test(capacity.trim()) && Number(capacity) >= 1 && Number(capacity) <= 100
      ? Number(capacity)
      : null
  const valid =
    name.trim().length > 0 &&
    colorOk &&
    sortValue !== null &&
    (!spec.parent || (parentId !== '' && capacityValue !== null))

  const save = useMutation({
    mutationFn: () => {
      const input: ConfigInput = {
        name: name.trim(),
        description: description.trim() || null,
        color: color || null,
        icon: icon || null,
        sort_order: sortValue ?? 0,
        ...(spec.flags.length ? flags : {}),
        ...(spec.parent ? { table_area_id: parentId, capacity: capacityValue ?? 1 } : {}),
      }
      return row ? updateConfigRow(domain, row.id, input) : createConfigRow(domain, rid, input)
    },
    onSuccess: () => {
      toast.success(row ? 'Saved' : `${name.trim()} added`)
      onSaved()
    },
    onError: (e) => setError(message(e, spec.singular)),
  })

  return (
    <Dialog open onOpenChange={(o) => !o && !save.isPending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{row ? `Edit ${row.name}` : `Add ${spec.singular}`}</DialogTitle>
          <DialogDescription>
            Changes apply at once on every screen; nothing needs a redeploy.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (valid) save.mutate()
          }}
        >
          <FormField id="cfg-name" label="Name">
            {(a11y) => (
              <Input {...a11y} value={name} maxLength={maxName} onChange={(e) => setName(e.target.value)} />
            )}
          </FormField>
          {spec.parent && (
            <div className="grid grid-cols-2 gap-3">
              <FormField
                id="cfg-parent"
                label={spec.parent.label}
                error={parents.length === 0 ? 'Add an active area first.' : undefined}
              >
                {(a11y) => (
                  <NativeSelect {...a11y} value={parentId} onChange={(e) => setParentId(e.target.value)}>
                    {parents.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </FormField>
              <FormField
                id="cfg-capacity"
                label="Seats"
                error={capacityValue === null ? 'From 1 to 100.' : undefined}
              >
                {(a11y) => (
                  <Input
                    {...a11y}
                    inputMode="numeric"
                    value={capacity}
                    maxLength={3}
                    onChange={(e) => setCapacity(e.target.value)}
                  />
                )}
              </FormField>
            </div>
          )}
          {spec.presentation && (
            <>
              <FormField id="cfg-desc" label="Description (optional)">
                {(a11y) => (
                  <Input
                    {...a11y}
                    value={description}
                    maxLength={300}
                    onChange={(e) => setDescription(e.target.value)}
                  />
                )}
              </FormField>
              <div className="grid grid-cols-2 gap-3">
                <FormField
                  id="cfg-color"
                  label="Colour (optional)"
                  error={colorOk ? undefined : 'Use #rrggbb, e.g. #ea580c.'}
                >
                  {(a11y) => (
                    <div className="flex gap-2">
                      <Input
                        {...a11y}
                        value={color}
                        maxLength={7}
                        placeholder="#ea580c"
                        onChange={(e) => setColor(e.target.value.trim())}
                      />
                      <input
                        type="color"
                        aria-label="Pick a colour"
                        className="h-10 w-12 shrink-0 rounded-md border border-line"
                        value={HEX.test(color) ? color : '#94a3b8'}
                        onChange={(e) => setColor(e.target.value)}
                      />
                    </div>
                  )}
                </FormField>
                <FormField id="cfg-icon" label="Icon (optional)">
                  {(a11y) => (
                    <NativeSelect {...a11y} value={icon} onChange={(e) => setIcon(e.target.value)}>
                      <option value="">None</option>
                      {ICON_SLUGS.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </NativeSelect>
                  )}
                </FormField>
              </div>
            </>
          )}
          <FormField id="cfg-sort" label="Order" error={sortValue === null ? 'A whole number.' : undefined}>
            {(a11y) => (
              <Input
                {...a11y}
                inputMode="numeric"
                value={sort}
                maxLength={7}
                onChange={(e) => setSort(e.target.value)}
              />
            )}
          </FormField>
          {spec.flags.map((f) => (
            <label key={f.key} className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={flags[f.key]}
                onChange={(e) => setFlags((x) => ({ ...x, [f.key]: e.target.checked }))}
              />
              <span>
                <span className="font-medium text-ink">{f.label}</span>
                <span className="block text-xs text-muted-foreground">{f.hint}</span>
              </span>
            </label>
          ))}
          <FormError message={error} />
          <DialogFooter>
            <Button type="button" variant="outline" disabled={save.isPending} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || save.isPending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
