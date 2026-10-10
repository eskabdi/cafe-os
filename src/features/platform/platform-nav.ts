import {
  Activity,
  Building2,
  DatabaseBackup,
  FileText,
  Gauge,
  Layers,
  PlusCircle,
  ScrollText,
  ShieldCheck,
  KeyRound,
  type LucideIcon,
} from 'lucide-react'

export interface PlatformNavItem {
  id: string
  label: string
  /** Absolute path under /platform. */
  path: string
  icon: LucideIcon
  /** Exact match only (index-like entries). */
  end?: boolean
}

/**
 * THE Platform Admin Portal navigation (§34A). Only platform features: tenants, provisioning, plans, invoices, health,
 * backups, platform audit, Super Admin accounts. It never contains a tenant operational module (POS, stations, cashier, menu,
 * inventory, day close, ...), and the tenant navigation (shell/nav-config.ts) never contains any of these.
 */
export const PLATFORM_NAV: readonly PlatformNavItem[] = [
  { id: 'overview', label: 'Overview', path: '/platform', icon: Gauge, end: true },
  { id: 'tenants', label: 'Tenants', path: '/platform/tenants', icon: Building2, end: true },
  { id: 'create-tenant', label: 'Create tenant', path: '/platform/tenants/new', icon: PlusCircle, end: true },
  { id: 'plans', label: 'Plans', path: '/platform/plans', icon: Layers },
  { id: 'invoices', label: 'Invoices', path: '/platform/invoices', icon: FileText },
  { id: 'health', label: 'System health', path: '/platform/health', icon: Activity },
  { id: 'backups', label: 'Backups', path: '/platform/backups', icon: DatabaseBackup },
  { id: 'audit', label: 'Audit log', path: '/platform/audit', icon: ScrollText },
  { id: 'admins', label: 'Super Admins', path: '/platform/admins', icon: ShieldCheck },
  { id: 'security', label: 'Security', path: '/platform/security', icon: KeyRound },
]

export const platformTenantPath = (id: string) => `/platform/tenants/${id}`
