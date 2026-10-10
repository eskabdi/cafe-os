import { z } from 'zod'
import { supabase } from './client'
import { callRpc } from './rpc'
import { numericValue, rowColor, rowIcon, uuid } from './schemas'

// Tenant Portal administration wrappers (migration 0031 + the reused role / user RPCs, docs/api/portals.md). The tenant is
// ALWAYS derived from the caller's identity on the server (fn_tenant_status_guard): no wrapper here sends a restaurant_id.
// Permission, step-up / aal2 and escalation rules are decided by the database; the UI only mirrors them.

const ts = z.string()
const nts = z.string().nullable()

/** Query keys, scoped by the identity's own restaurant id (never the URL slug). */
export const tenantAdminKeys = {
  roles: (rid: string) => ['tenant-admin', rid, 'roles'] as const,
  users: (rid: string) => ['tenant-admin', rid, 'users'] as const,
  permissions: ['permissions-catalogue'] as const,
  profile: (rid: string) => ['tenant-admin', rid, 'profile'] as const,
  subscription: (rid: string) => ['tenant-admin', rid, 'subscription'] as const,
  invitations: (rid: string) => ['tenant-admin', rid, 'invitations'] as const,
  logoUrl: (rid: string, path: string) => ['tenant-admin', rid, 'logo-url', path] as const,
}

// ── roles ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
export const roleSchema = z.object({
  id: uuid,
  name: z.string(),
  description: nts.optional(),
  color: rowColor,
  icon: rowIcon,
  sort_order: numericValue.nullable().optional(),
  is_active: z.boolean(),
  is_system: z.boolean(),
  system_key: z.string().nullable(),
  active_users: numericValue,
  total_users: numericValue,
  permission_keys: z.array(z.string()),
  station_ids: z.array(uuid),
  created_at: ts.optional(),
  updated_at: ts.optional(),
})
export type TenantRole = z.infer<typeof roleSchema>

export interface RoleInput {
  name: string
  description: string | null
  color: string | null
  icon: string | null
  sort_order?: number
}

export async function listRoles(): Promise<TenantRole[]> {
  return z.array(roleSchema).parse(await callRpc('fn_list_roles'))
}

export async function createRole(r: RoleInput): Promise<TenantRole> {
  return roleSchema.parse(await callRpc('fn_create_role', { p_role: r }))
}

export async function updateRole(roleId: string, patch: Partial<RoleInput>): Promise<TenantRole> {
  return roleSchema.parse(await callRpc('fn_update_role', { p_role_id: roleId, p_patch: patch }))
}

export async function setRoleActive(roleId: string, active: boolean): Promise<TenantRole & { changed: boolean }> {
  return roleSchema
    .extend({ changed: z.boolean() })
    .parse(await callRpc('fn_set_role_active', { p_role_id: roleId, p_active: active }))
}

export async function deleteRole(roleId: string): Promise<void> {
  z.object({ role_id: uuid, deleted: z.literal(true) }).parse(await callRpc('fn_delete_role', { p_role_id: roleId }))
}

const matrixResultSchema = z.object({ role_id: uuid }).passthrough()

/** Replaces a role's permission keys (and station ids) in one audited command. */
export async function updateRolePermissions(roleId: string, permissionKeys: string[], stationIds: string[]): Promise<void> {
  matrixResultSchema.parse(
    await callRpc('fn_update_role_permissions', {
      p_role_id: roleId,
      p_permission_keys: permissionKeys,
      p_station_ids: stationIds,
    }),
  )
}

/** Station access only; the server keeps the role's permission keys. */
export async function setRoleStationAccess(roleId: string, stationIds: string[]): Promise<void> {
  matrixResultSchema.parse(await callRpc('fn_set_role_station_access', { p_role_id: roleId, p_station_ids: stationIds }))
}

// ── permissions catalogue ──────────────────────────────────────────────────────────────────────────────────────────────
const permissionSchema = z.object({
  key: z.string().regex(/^[a-z][a-z_]*\.[a-z][a-z_]*$/),
  module: z.string(),
  description: z.string(),
  sort_order: z.number().int(),
})
export type PermissionRow = z.infer<typeof permissionSchema>

/** The global permission catalogue (read-only to every signed-in user; RLS permissions_select). */
export async function fetchPermissions(): Promise<PermissionRow[]> {
  const { data, error } = await supabase
    .from('permissions')
    .select('key,module,description,sort_order')
    .order('sort_order', { ascending: true })
  if (error) throw new Error('permissions_unavailable')
  if (!Array.isArray(data)) return []
  return data.flatMap((row) => {
    const p = permissionSchema.safeParse(row)
    return p.success ? [p.data] : []
  })
}

// ── users ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
export const userSchema = z.object({
  id: uuid,
  first_name: z.string(),
  middle_name: nts.optional(),
  last_name: nts.optional(),
  short_name: nts.optional(),
  full_name: nts.optional(),
  username: z.string(),
  is_active: z.boolean(),
  auth_method: z.enum(['pin', 'password']),
  identity_rotation_pending: z.boolean().nullable().optional(),
  role: z.object({
    id: uuid,
    name: z.string(),
    color: rowColor,
    icon: rowIcon,
    system_key: z.string().nullable(),
    is_active: z.boolean(),
  }),
  email: nts.optional(),
  mfa_enrolled: z.boolean().nullable().optional(),
  pin: z
    .object({
      set: z.boolean(),
      length: z.number().nullable().optional(),
      locked: z.boolean(),
      locked_until: nts.optional(),
      failed_attempts: z.number().nullable().optional(),
      must_change: z.boolean().nullable().optional(),
      pending_approval: z.boolean().nullable().optional(),
      changed_at: nts.optional(),
    })
    .nullable()
    .optional(),
  created_at: ts,
  updated_at: ts.optional(),
})
export type TenantUser = z.infer<typeof userSchema>

export async function listUsers(): Promise<TenantUser[]> {
  return z.array(userSchema).parse(await callRpc('fn_list_users', { p_include_inactive: true }))
}

export interface UserNamePatch {
  first_name?: string
  middle_name?: string | null
  last_name?: string | null
}

export async function updateUser(profileId: string, patch: UserNamePatch): Promise<TenantUser> {
  return userSchema.parse(await callRpc('fn_update_user', { p_profile_id: profileId, p_patch: patch }))
}

export async function setUserActive(profileId: string, active: boolean): Promise<{ changed: boolean }> {
  return z
    .object({ profile_id: uuid, is_active: z.boolean(), changed: z.boolean() })
    .parse(await callRpc('fn_set_user_active', { p_profile_id: profileId, p_active: active }))
}

const roleChangeSchema = z
  .object({
    profile_id: uuid,
    role_id: uuid,
    changed: z.boolean(),
    requires_identity_rotation: z.boolean().nullable().optional(),
    pin_reset_required: z.boolean().nullable().optional(),
  })
  .passthrough()
export type RoleChange = z.infer<typeof roleChangeSchema>

export async function changeUserRole(profileId: string, roleId: string): Promise<RoleChange> {
  return roleChangeSchema.parse(await callRpc('fn_change_user_role', { p_profile_id: profileId, p_role_id: roleId }))
}

export async function resetPinLockout(profileId: string): Promise<void> {
  z.object({ profile_id: uuid, reset: z.boolean() }).parse(await callRpc('fn_reset_pin_lockout', { p_profile_id: profileId }))
}

// ── Tenant Admin invitations (own tenant) ─────────────────────────────────────────────────────────────────────────────
const tenantInvitationSchema = z.object({
  id: uuid,
  email: z.string(),
  first_name: z.string(),
  middle_name: nts.optional(),
  last_name: nts.optional(),
  username: z.string(),
  status: z.enum(['pending', 'accepted', 'revoked', 'expired']),
  state: z.enum(['pending', 'accepted', 'revoked', 'expired']),
  invited_by_type: z.enum(['platform_admin', 'tenant_admin']),
  expires_at: ts,
  send_count: numericValue,
  last_sent_at: nts,
  accepted_at: nts,
  revoked_at: nts,
  created_at: ts,
})
export type TenantInvitation = z.infer<typeof tenantInvitationSchema>

export async function listTenantAdminInvitations(): Promise<TenantInvitation[]> {
  return z.array(tenantInvitationSchema).parse(await callRpc('fn_list_tenant_admin_invitations'))
}

// ── restaurant profile, business settings, branding, subscription ───────────────────────────────────────────────────────
const brandingSchema = z
  .object({
    primary_color: z.string().nullable().optional(),
    accent_color: z.string().nullable().optional(),
    logo_path: z.string().nullable().optional(),
  })
  .nullable()
  .optional()

export const restaurantProfileSchema = z.object({
  id: uuid,
  name: z.string(),
  slug: z.string(),
  status: z.string(),
  phone: nts.optional(),
  address: nts.optional(),
  timezone: z.string(),
  tin: nts.optional(),
  vat_rate: numericValue,
  opening_float: numericValue,
  auto_consume_stock: z.boolean(),
  stock_stepup_threshold: numericValue.nullable().optional(),
  branding: brandingSchema,
  updated_at: ts.optional(),
})
export type RestaurantProfile = z.infer<typeof restaurantProfileSchema>

export async function getRestaurantProfile(): Promise<RestaurantProfile> {
  return restaurantProfileSchema.parse(await callRpc('fn_get_restaurant_profile'))
}

export interface ProfilePatch {
  name?: string
  phone?: string | null
  address?: string | null
  timezone?: string
}

export async function updateRestaurantProfile(patch: ProfilePatch): Promise<RestaurantProfile> {
  return restaurantProfileSchema.parse(await callRpc('fn_update_restaurant_profile', { p_patch: patch }))
}

export interface BusinessPatch {
  tin?: string | null
  vat_rate?: number
  opening_float?: number
  auto_consume_stock?: boolean
}

export async function updateBusinessSettings(patch: BusinessPatch): Promise<RestaurantProfile> {
  return restaurantProfileSchema.parse(await callRpc('fn_update_business_settings', { p_patch: patch }))
}

export async function updateBranding(primary: string, accent: string, logoPath: string | null): Promise<RestaurantProfile> {
  return restaurantProfileSchema.parse(
    await callRpc('fn_update_restaurant_branding', {
      p_primary_color: primary.toLowerCase(),
      p_accent_color: accent.toLowerCase(),
      p_logo_path: logoPath,
    }),
  )
}

const subscriptionUsageSchema = z.object({
  usage: z.record(z.string(), z.unknown()),
  limits: z.record(z.string(), z.unknown()),
  over_quota: z.array(z.string()),
  subscription: z
    .object({
      status: z.string(),
      trial_ends_at: nts,
      current_period_start: nts,
      current_period_end: nts,
      plan: z.object({
        id: uuid,
        name: z.string(),
        description: nts.optional(),
        price_etb_monthly: numericValue,
        features: z.record(z.string(), z.unknown()).nullable().optional(),
      }),
    })
    .nullable(),
})
export type SubscriptionUsage = z.infer<typeof subscriptionUsageSchema>

export async function getSubscriptionUsage(): Promise<SubscriptionUsage> {
  return subscriptionUsageSchema.parse(await callRpc('fn_get_subscription_usage'))
}

// ── invitee side (signed in from the e-mail link, no profile yet) ──────────────────────────────────────────────────────
const myInvitationSchema = z
  .object({
    invitation_id: uuid,
    restaurant: z.object({ name: z.string(), slug: z.string() }),
    email: z.string(),
    username: z.string(),
    expires_at: ts,
    expired: z.boolean(),
  })
  .nullable()
export type MyInvitation = NonNullable<z.infer<typeof myInvitationSchema>>

export async function getMyInvitation(): Promise<MyInvitation | null> {
  return myInvitationSchema.parse(await callRpc('fn_get_my_invitation'))
}

export async function acceptTenantAdminInvitation(): Promise<{ profile_id: string; restaurant_id: string; slug: string }> {
  return z
    .object({ profile_id: uuid, restaurant_id: uuid, slug: z.string() })
    .parse(await callRpc('fn_accept_tenant_admin_invitation'))
}
