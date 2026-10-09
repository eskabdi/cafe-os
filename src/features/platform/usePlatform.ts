import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  inviteTenantAdmin,
  resendTenantAdminInvitation,
  revokeTenantAdminInvitation,
  type InviteTenantAdminInput,
} from '@/lib/supabase/edge-functions'
import {
  cancelTenant,
  changeTenantPlan,
  createInvoice,
  createPlan,
  createTenant,
  getSystemHealth,
  getTenant,
  listAdmins,
  listAuditLog,
  listBackupRuns,
  listInvoices,
  listPlans,
  listTenants,
  nextCursor,
  platformKeys,
  reactivateTenant,
  restoreTenant,
  setAdminActive,
  setBillingStatus,
  setInvoiceStatus,
  setPlanActive,
  suspendTenant,
  updatePlan,
  type AuditFilter,
  type BillingStatus,
  type CreateTenantInput,
  type InvoiceFilter,
  type InvoiceStatus,
  type PlanInput,
  type PlatformBillingChannel,
  type TenantListFilter,
} from '@/lib/supabase/platform'

// TanStack Query hooks for the Platform Admin Portal. Platform data has no Realtime channel (platform tables are not in the
// publication); freshness comes from invalidation after every mutation and refetch on focus. No polling.

export const PAGE_SIZE = 25
export const LOG_PAGE_SIZE = 50

export function useTenantList(f: TenantListFilter) {
  return useQuery({ queryKey: platformKeys.tenants(f), queryFn: () => listTenants(f), placeholderData: keepPreviousData })
}

export function useTenant(id: string) {
  return useQuery({ queryKey: platformKeys.tenant(id), queryFn: () => getTenant(id), enabled: Boolean(id) })
}

export function usePlans() {
  return useQuery({ queryKey: platformKeys.plans, queryFn: listPlans })
}

export function useSystemHealth() {
  return useQuery({ queryKey: platformKeys.health, queryFn: getSystemHealth })
}

export function useAdmins() {
  return useQuery({ queryKey: platformKeys.admins, queryFn: listAdmins })
}

export function useInvoices(f: InvoiceFilter) {
  return useInfiniteQuery({
    queryKey: platformKeys.invoices(f),
    queryFn: ({ pageParam }) => listInvoices(f, pageParam, LOG_PAGE_SIZE),
    initialPageParam: null as null | { before: string; beforeId: string },
    getNextPageParam: (last) => nextCursor(last, LOG_PAGE_SIZE, (r) => r.created_at),
  })
}

export function useBackupRuns() {
  return useInfiniteQuery({
    queryKey: platformKeys.backups,
    queryFn: ({ pageParam }) => listBackupRuns(pageParam, LOG_PAGE_SIZE),
    initialPageParam: null as null | { before: string; beforeId: string },
    getNextPageParam: (last) => nextCursor(last, LOG_PAGE_SIZE, (r) => r.started_at),
  })
}

export function useAuditLog(f: AuditFilter) {
  return useInfiniteQuery({
    queryKey: platformKeys.audit(f),
    queryFn: ({ pageParam }) => listAuditLog(f, pageParam, LOG_PAGE_SIZE),
    initialPageParam: null as null | { before: string; beforeId: string },
    getNextPageParam: (last) => nextCursor(last, LOG_PAGE_SIZE, (r) => r.created_at),
  })
}

/** Invalidates everything that may show the tenant (list, detail, overview health counters, audit). */
function useInvalidateTenant() {
  const qc = useQueryClient()
  return (id?: string) => {
    void qc.invalidateQueries({ queryKey: ['platform', 'tenants'] })
    if (id) void qc.invalidateQueries({ queryKey: platformKeys.tenant(id) })
    void qc.invalidateQueries({ queryKey: platformKeys.health })
    void qc.invalidateQueries({ queryKey: ['platform', 'audit'] })
  }
}

export function useCreateTenant() {
  const inv = useInvalidateTenant()
  return useMutation({ mutationFn: (i: CreateTenantInput) => createTenant(i), onSuccess: (r) => inv(r.restaurant_id) })
}

export type TenantAction =
  | { kind: 'suspend' | 'reactivate'; reason: string }
  | { kind: 'billing'; status: BillingStatus; reason: string }
  | { kind: 'plan'; planId: string; reason: string }
  | { kind: 'cancel' | 'restore'; reason: string; confirmSlug: string }

export function useTenantAction(restaurantId: string) {
  const inv = useInvalidateTenant()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (a: TenantAction): Promise<{ changed: boolean; over_quota?: string[] }> => {
      switch (a.kind) {
        case 'suspend':
          return suspendTenant(restaurantId, a.reason)
        case 'reactivate':
          return reactivateTenant(restaurantId, a.reason)
        case 'billing':
          return setBillingStatus(restaurantId, a.status, a.reason)
        case 'plan':
          return changeTenantPlan(restaurantId, a.planId, a.reason)
        case 'cancel':
          return cancelTenant(restaurantId, a.reason, a.confirmSlug)
        case 'restore':
          return restoreTenant(restaurantId, a.reason, a.confirmSlug)
      }
    },
    onSuccess: (_r, a) => {
      inv(restaurantId)
      if (a.kind === 'plan') void qc.invalidateQueries({ queryKey: platformKeys.plans })
    },
  })
}

export function useInviteTenantAdmin(restaurantId: string) {
  const inv = useInvalidateTenant()
  return useMutation({
    mutationFn: (i: Omit<InviteTenantAdminInput, 'restaurantId'>) => inviteTenantAdmin({ ...i, restaurantId }),
    onSuccess: () => inv(restaurantId),
  })
}

export function useInvitationCommand(restaurantId: string) {
  const inv = useInvalidateTenant()
  return useMutation({
    mutationFn: (a: { kind: 'resend' | 'revoke'; invitationId: string }) =>
      a.kind === 'resend' ? resendTenantAdminInvitation(a.invitationId) : revokeTenantAdminInvitation(a.invitationId),
    onSuccess: () => inv(restaurantId),
  })
}

function useInvalidatePlans() {
  const qc = useQueryClient()
  return () => {
    void qc.invalidateQueries({ queryKey: platformKeys.plans })
    void qc.invalidateQueries({ queryKey: ['platform', 'audit'] })
  }
}

export function useSavePlan() {
  const inv = useInvalidatePlans()
  return useMutation({
    mutationFn: (a: { id: string | null; plan: PlanInput }) => (a.id ? updatePlan(a.id, a.plan) : createPlan(a.plan)),
    onSuccess: inv,
  })
}

export function useSetPlanActive() {
  const inv = useInvalidatePlans()
  return useMutation({ mutationFn: (a: { id: string; active: boolean }) => setPlanActive(a.id, a.active), onSuccess: inv })
}

function useInvalidateInvoices() {
  const qc = useQueryClient()
  return () => {
    void qc.invalidateQueries({ queryKey: ['platform', 'invoices'] })
    void qc.invalidateQueries({ queryKey: ['platform', 'tenant'] })
    void qc.invalidateQueries({ queryKey: ['platform', 'audit'] })
  }
}

export function useCreateInvoice() {
  const inv = useInvalidateInvoices()
  return useMutation({ mutationFn: createInvoice, onSuccess: inv })
}

export function useSetInvoiceStatus() {
  const inv = useInvalidateInvoices()
  return useMutation({
    mutationFn: (a: {
      id: string
      status: Exclude<InvoiceStatus, 'pending'>
      method: PlatformBillingChannel | null
      reference: string | null
    }) => setInvoiceStatus(a.id, a.status, a.method, a.reference),
    onSuccess: inv,
  })
}

export function useSetAdminActive() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (a: { id: string; active: boolean; reason: string }) => setAdminActive(a.id, a.active, a.reason),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: platformKeys.admins })
      void qc.invalidateQueries({ queryKey: ['platform', 'audit'] })
    },
  })
}
