import { useState } from 'react'
import { toast } from 'sonner'
import { Card, PageHeader } from '@/components/portal/page-header'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { TrustedDevicesCard, useAuth, useStepUp } from '@/features/auth'
import { InvitationList, type InvitationRow } from '@/features/invitations/InvitationList'
import { InviteTenantAdminDialog, type InviteValues } from '@/features/invitations/InviteTenantAdminDialog'
import { EmptyState, ErrorState, PageSkeleton } from '@/features/shell/states'
import { fullName, isTenantAdminRole } from '@/lib/domain/portal'
import { portalErrorMessage } from '@/lib/supabase/portal-errors'
import type { TenantUser } from '@/lib/supabase/tenant-admin'
import { CreateStaffDialog, EditUserDialog, ResetPinDialog, type NewStaffValues } from './UserDialogs'
import {
  useInvitationCommand,
  useInviteCoAdmin,
  useRoles,
  useTenantInvitations,
  useUserCommand,
  useUsers,
} from './useTenantAdmin'

function pinStatus(u: TenantUser): string | null {
  if (u.auth_method !== 'pin' || !u.pin) return null
  if (u.pin.locked) return 'PIN locked'
  if (u.pin.pending_approval) return 'PIN change awaiting approval'
  if (u.pin.must_change) return 'must choose a new PIN'
  return null
}

/**
 * Tenant Portal > Users: staff list, add PIN staff, edit names and role, activate / deactivate, reset PIN (signs the person
 * out), unlock, a user's trusted devices, and Tenant Admin invitations (tenant admins only). users.view sees the list only.
 */
export function UsersPage() {
  const { can, context } = useAuth()
  const manage = can('users.manage')
  const isAdmin = isTenantAdminRole(context?.role)
  const users = useUsers()
  const roles = useRoles()
  const cmd = useUserCommand()
  const stepUp = useStepUp()
  const invitations = useTenantInvitations(isAdmin)
  const invite = useInviteCoAdmin()
  const invCmd = useInvitationCommand()
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<TenantUser | null>(null)
  const [resetting, setResetting] = useState<TenantUser | null>(null)
  const [toggling, setToggling] = useState<TenantUser | null>(null)
  const [devicesOf, setDevicesOf] = useState<TenantUser | null>(null)
  const [inviting, setInviting] = useState(false)
  const [revoking, setRevoking] = useState<InvitationRow | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (users.isPending) return <PageSkeleton label="Loading users" />
  if (users.isError) return <ErrorState title="Users could not be loaded" onRetry={() => void users.refetch()} />

  const fail = (e: unknown) => setError(portalErrorMessage(e))
  const run = (p: Promise<unknown>, done: string, close: () => void) =>
    p
      .then(() => {
        toast.success(done)
        setError(null)
        close()
      })
      .catch(fail)

  const create = (v: NewStaffValues) =>
    run(stepUp.run(() => cmd.mutateAsync({ kind: 'create', input: v })), 'Staff member added.', () => setCreating(false))

  const saveEdit = (v: { first: string; middle: string | null; last: string | null; roleId: string }) => {
    const u = editing
    if (!u) return
    const work = async () => {
      if (v.first !== u.first_name || v.middle !== (u.middle_name ?? null) || v.last !== (u.last_name ?? null)) {
        await cmd.mutateAsync({ kind: 'names', id: u.id, patch: { first_name: v.first, middle_name: v.middle, last_name: v.last } })
      }
      if (v.roleId !== u.role.id) await cmd.mutateAsync({ kind: 'role', id: u.id, roleId: v.roleId })
    }
    void run(stepUp.run(work), 'User saved.', () => setEditing(null))
  }

  const sendInvite = (v: InviteValues) =>
    run(
      stepUp.run(() =>
        invite.mutateAsync({ email: v.email, firstName: v.firstName, middleName: v.middleName, lastName: v.lastName, username: v.username }),
      ),
      'Invitation sent.',
      () => setInviting(false),
    )

  const list = users.data
  return (
    <div className="space-y-5 p-4 lg:p-6">
      <PageHeader
        title="Users"
        description="Staff sign in with a PIN; Tenant Admins with e-mail, password and an authenticator app."
        actions={
          manage && (
            <>
              {isAdmin && (
                <Button variant="outline" onClick={() => setInviting(true)}>
                  Invite a Tenant Admin
                </Button>
              )}
              <Button onClick={() => setCreating(true)} disabled={!roles.isSuccess}>
                Add staff member
              </Button>
            </>
          )
        }
      />
      {error && !creating && !editing && !resetting && !toggling && !inviting && !revoking && (
        <p role="alert" className="text-sm font-medium text-status-error">
          {error}
        </p>
      )}
      {list.length === 0 ? (
        <EmptyState title="No users yet">Add your first staff member.</EmptyState>
      ) : (
        <ul className="divide-y divide-line rounded-card border border-line bg-white" aria-label="Users">
          {list.map((u) => {
            const status = pinStatus(u)
            return (
              <li key={u.id} className="flex flex-wrap items-center gap-3 p-4">
                <span aria-hidden="true" className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: u.role.color ?? '#9ca3af' }} />
                <div className="min-w-0 flex-1">
                  <p className={u.is_active ? 'font-medium text-ink' : 'font-medium text-muted-foreground line-through'}>
                    {fullName(u)} <span className="text-sm font-normal text-muted-foreground">@{u.username}</span>
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {u.role.name}
                    {u.auth_method === 'password' ? ` · ${u.email ?? 'e-mail sign-in'}` : ' · PIN sign-in'}
                    {u.mfa_enrolled === false && ' · no authenticator'}
                    {status && <span className="text-status-warning"> · {status}</span>}
                    {!u.is_active && ' · inactive'}
                  </p>
                </div>
                {manage && (
                  <div className="flex flex-wrap gap-1">
                    <Button variant="ghost" onClick={() => setEditing(u)}>
                      Edit
                    </Button>
                    {u.auth_method === 'pin' && u.is_active && (
                      <Button variant="ghost" onClick={() => setResetting(u)}>
                        Reset PIN
                      </Button>
                    )}
                    {u.pin?.locked && (
                      <Button
                        variant="ghost"
                        onClick={() => void run(stepUp.run(() => cmd.mutateAsync({ kind: 'unlock', id: u.id })), 'PIN unlocked.', () => undefined)}
                      >
                        Unlock
                      </Button>
                    )}
                    {u.auth_method === 'password' && isAdmin && (
                      <Button variant="ghost" onClick={() => setDevicesOf(devicesOf?.id === u.id ? null : u)}>
                        Devices
                      </Button>
                    )}
                    {u.id !== context?.user?.id && (
                      <Button variant="outline" onClick={() => setToggling(u)}>
                        {u.is_active ? 'Deactivate' : 'Reactivate'}
                      </Button>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {devicesOf && <TrustedDevicesCard userId={devicesOf.id} title={`Trusted devices of ${fullName(devicesOf)}`} />}
      {isAdmin && invitations.isSuccess && (
        <Card title="Tenant Admin invitations">
          <InvitationList
            invitations={invitations.data.map((i) => ({ ...i, send_count: Number(i.send_count) }))}
            busyId={invCmd.isPending ? (invCmd.variables?.id ?? null) : null}
            onResend={(id) => void run(stepUp.run(() => invCmd.mutateAsync({ kind: 'resend', id })), 'Invitation sent again.', () => undefined)}
            onRevoke={setRevoking}
          />
        </Card>
      )}
      <CreateStaffDialog
        open={creating}
        roles={roles.data ?? []}
        busy={cmd.isPending}
        error={creating ? error : null}
        onSubmit={(v) => void create(v)}
        onClose={() => {
          setCreating(false)
          setError(null)
        }}
      />
      <EditUserDialog
        user={editing}
        roles={roles.data ?? []}
        busy={cmd.isPending}
        error={editing ? error : null}
        onSubmit={saveEdit}
        onClose={() => {
          setEditing(null)
          setError(null)
        }}
      />
      <ResetPinDialog
        user={resetting}
        busy={cmd.isPending}
        error={resetting ? error : null}
        onSubmit={(pin) => {
          const u = resetting
          if (u) void run(stepUp.run(() => cmd.mutateAsync({ kind: 'pin', id: u.id, pin })), 'PIN reset. The person was signed out.', () => setResetting(null))
        }}
        onClose={() => {
          setResetting(null)
          setError(null)
        }}
      />
      <ConfirmDialog
        open={toggling !== null}
        title={toggling?.is_active ? 'Deactivate this user?' : 'Reactivate this user?'}
        description={
          toggling?.is_active
            ? 'They are signed out and cannot sign in until reactivated. Their history stays.'
            : 'They can sign in again with their role’s rights (the plan’s staff limit applies).'
        }
        confirmLabel={toggling?.is_active ? 'Deactivate' : 'Reactivate'}
        busy={cmd.isPending}
        error={toggling ? error : null}
        onConfirm={() => {
          const u = toggling
          if (u) void run(stepUp.run(() => cmd.mutateAsync({ kind: 'active', id: u.id, active: !u.is_active })), u.is_active ? 'User deactivated.' : 'User reactivated.', () => setToggling(null))
        }}
        onCancel={() => {
          setToggling(null)
          setError(null)
        }}
      />
      <InviteTenantAdminDialog
        open={inviting}
        tenantName={context?.restaurant?.name ?? ''}
        busy={invite.isPending}
        error={inviting ? error : null}
        onSubmit={(v) => void sendInvite(v)}
        onClose={() => {
          setInviting(false)
          setError(null)
        }}
      />
      <ConfirmDialog
        open={revoking !== null}
        title="Revoke this invitation?"
        description={`The link sent to ${revoking?.email ?? ''} stops working.`}
        confirmLabel="Revoke"
        busy={invCmd.isPending}
        error={revoking ? error : null}
        onConfirm={() => {
          const r = revoking
          if (r) void run(stepUp.run(() => invCmd.mutateAsync({ kind: 'revoke', id: r.id })), 'Invitation revoked.', () => setRevoking(null))
        }}
        onCancel={() => {
          setRevoking(null)
          setError(null)
        }}
      />
      {stepUp.dialog}
    </div>
  )
}
