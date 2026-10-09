import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/features/auth'
import {
  createStaff,
  inviteTenantAdmin,
  resendTenantAdminInvitation,
  resetStaffPin,
  revokeTenantAdminInvitation,
  type CreateStaffInput,
  type InviteTenantAdminInput,
} from '@/lib/supabase/edge-functions'
import { allStationsKey, fetchAllStations } from '@/lib/supabase/reference-data'
import {
  changeUserRole,
  createRole,
  deleteRole,
  fetchPermissions,
  getRestaurantProfile,
  getSubscriptionUsage,
  listRoles,
  listTenantAdminInvitations,
  listUsers,
  resetPinLockout,
  setRoleActive,
  setUserActive,
  tenantAdminKeys,
  updateBranding,
  updateBusinessSettings,
  updateRestaurantProfile,
  updateRole,
  updateRolePermissions,
  updateUser,
  type BusinessPatch,
  type ProfilePatch,
  type RoleInput,
  type UserNamePatch,
} from '@/lib/supabase/tenant-admin'

// TanStack Query hooks for the Tenant Portal administration. Keys are scoped by the identity's OWN restaurant id (session
// context), never the URL slug; every mutation invalidates what it changes, and the session context (permissions, theme) when
// the change can affect the signed-in user.

function useRid(): string {
  const { context } = useAuth()
  return context?.restaurant?.id ?? ''
}

export function useRestaurantProfile() {
  const rid = useRid()
  return useQuery({ queryKey: tenantAdminKeys.profile(rid), queryFn: getRestaurantProfile, enabled: Boolean(rid) })
}

export function useSubscriptionUsage() {
  const rid = useRid()
  return useQuery({ queryKey: tenantAdminKeys.subscription(rid), queryFn: getSubscriptionUsage, enabled: Boolean(rid) })
}

export function useRoles() {
  const rid = useRid()
  return useQuery({ queryKey: tenantAdminKeys.roles(rid), queryFn: listRoles, enabled: Boolean(rid) })
}

export function usePermissionsCatalogue() {
  return useQuery({ queryKey: tenantAdminKeys.permissions, queryFn: fetchPermissions, staleTime: 5 * 60_000 })
}

export function useAllStations() {
  const rid = useRid()
  return useQuery({ queryKey: allStationsKey(rid), queryFn: fetchAllStations, enabled: Boolean(rid) })
}

export function useUsers() {
  const rid = useRid()
  return useQuery({ queryKey: tenantAdminKeys.users(rid), queryFn: listUsers, enabled: Boolean(rid) })
}

export function useTenantInvitations(enabled: boolean) {
  const rid = useRid()
  return useQuery({ queryKey: tenantAdminKeys.invitations(rid), queryFn: listTenantAdminInvitations, enabled: Boolean(rid) && enabled })
}

function useInvalidate() {
  const qc = useQueryClient()
  const rid = useRid()
  const { refreshContext } = useAuth()
  return (what: Array<'profile' | 'roles' | 'users' | 'invitations' | 'subscription' | 'context'>) => {
    for (const w of what) {
      if (w === 'context') refreshContext()
      else void qc.invalidateQueries({ queryKey: ['tenant-admin', rid, w] })
    }
  }
}

export function useSaveProfile() {
  const inv = useInvalidate()
  return useMutation({ mutationFn: (p: ProfilePatch) => updateRestaurantProfile(p), onSuccess: () => inv(['profile', 'context']) })
}

export function useSaveBusiness() {
  const inv = useInvalidate()
  return useMutation({ mutationFn: (p: BusinessPatch) => updateBusinessSettings(p), onSuccess: () => inv(['profile']) })
}

export function useSaveBranding() {
  const inv = useInvalidate()
  return useMutation({
    mutationFn: (b: { primary: string; accent: string; logoPath: string | null }) => updateBranding(b.primary, b.accent, b.logoPath),
    onSuccess: () => inv(['profile', 'context']),
  })
}

export type RoleCommand =
  | { kind: 'create'; role: RoleInput }
  | { kind: 'update'; id: string; patch: Partial<RoleInput> }
  | { kind: 'active'; id: string; active: boolean }
  | { kind: 'delete'; id: string }
  | { kind: 'matrix'; id: string; keys: string[]; stationIds: string[] }

export function useRoleCommand() {
  const inv = useInvalidate()
  return useMutation({
    mutationFn: async (c: RoleCommand): Promise<unknown> => {
      switch (c.kind) {
        case 'create':
          return createRole(c.role)
        case 'update':
          return updateRole(c.id, c.patch)
        case 'active':
          return setRoleActive(c.id, c.active)
        case 'delete':
          return deleteRole(c.id)
        case 'matrix':
          return updateRolePermissions(c.id, c.keys, c.stationIds)
      }
    },
    onSuccess: () => inv(['roles', 'users', 'context']),
  })
}

export type UserCommand =
  | { kind: 'create'; input: CreateStaffInput }
  | { kind: 'names'; id: string; patch: UserNamePatch }
  | { kind: 'active'; id: string; active: boolean }
  | { kind: 'role'; id: string; roleId: string }
  | { kind: 'pin'; id: string; pin: string }
  | { kind: 'unlock'; id: string }

export function useUserCommand() {
  const inv = useInvalidate()
  return useMutation({
    mutationFn: async (c: UserCommand): Promise<unknown> => {
      switch (c.kind) {
        case 'create':
          return createStaff(c.input)
        case 'names':
          return updateUser(c.id, c.patch)
        case 'active':
          return setUserActive(c.id, c.active)
        case 'role':
          return changeUserRole(c.id, c.roleId)
        case 'pin':
          return resetStaffPin(c.id, c.pin)
        case 'unlock':
          return resetPinLockout(c.id)
      }
    },
    onSuccess: () => inv(['users', 'roles', 'subscription']),
  })
}

export function useInviteCoAdmin() {
  const inv = useInvalidate()
  return useMutation({
    mutationFn: (i: Omit<InviteTenantAdminInput, 'restaurantId'>) => inviteTenantAdmin(i),
    onSuccess: () => inv(['invitations', 'subscription']),
  })
}

export function useInvitationCommand() {
  const inv = useInvalidate()
  return useMutation({
    mutationFn: (a: { kind: 'resend' | 'revoke'; id: string }) =>
      a.kind === 'resend' ? resendTenantAdminInvitation(a.id) : revokeTenantAdminInvitation(a.id),
    onSuccess: () => inv(['invitations', 'subscription']),
  })
}
