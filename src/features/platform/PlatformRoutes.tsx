import { Route, Routes } from 'react-router-dom'
import { RequirePlatformAdmin } from '@/features/auth'
import { NotFoundState } from '@/features/shell/states'
import { PlatformMfaGate } from './PlatformMfaGate'
import { PlatformShell } from './PlatformShell'
import { AdminsPage } from './pages/AdminsPage'
import { AuditLogPage } from './pages/AuditLogPage'
import { BackupsPage } from './pages/BackupsPage'
import { CreateTenantPage } from './pages/CreateTenantPage'
import { HealthPage } from './pages/HealthPage'
import { InvoicesPage } from './pages/InvoicesPage'
import { OverviewPage } from './pages/OverviewPage'
import { PlansPage } from './pages/PlansPage'
import { PlatformSecurityPage } from './pages/SecurityPage'
import { TenantDetailPage } from './pages/TenantDetailPage'
import { TenantsPage } from './pages/TenantsPage'

/**
 * The Platform Admin Portal (§34A), mounted at /platform/* behind RequireAuth + RequirePlatformAdmin. Its own shell and its
 * own routes: platform features only, never a tenant screen. The MFA gate opens it after a TOTP code or on a trusted device.
 * UX only: every platform RPC re-checks the Super Admin and the MFA state (fn_platform_guard).
 */
export default function PlatformRoutes() {
  return (
    <RequirePlatformAdmin mfaGate={<PlatformMfaGate />}>
      <Routes>
        <Route element={<PlatformShell />}>
          <Route index element={<OverviewPage />} />
          <Route path="tenants" element={<TenantsPage />} />
          <Route path="tenants/new" element={<CreateTenantPage />} />
          <Route path="tenants/:tenantId" element={<TenantDetailPage />} />
          <Route path="plans" element={<PlansPage />} />
          <Route path="invoices" element={<InvoicesPage />} />
          <Route path="health" element={<HealthPage />} />
          <Route path="backups" element={<BackupsPage />} />
          <Route path="audit" element={<AuditLogPage />} />
          <Route path="admins" element={<AdminsPage />} />
          <Route path="security" element={<PlatformSecurityPage />} />
          <Route path="*" element={<NotFoundState homePath="/platform" />} />
        </Route>
      </Routes>
    </RequirePlatformAdmin>
  )
}
