import {
  CalendarCheck,
  ChefHat,
  CreditCard,
  LayoutDashboard,
  MonitorSmartphone,
  ReceiptText,
  Settings,
  ShieldCheck,
  ShoppingCart,
  Store,
  Users,
  Warehouse,
  Wallet,
  type LucideIcon,
} from 'lucide-react'
import type { ModuleNavSpec } from '@/lib/domain/navigation'

export interface ModuleNavItem extends ModuleNavSpec {
  icon: LucideIcon
  /** One-line description for the "coming soon" placeholder (and the home overview). */
  summary: string
  /** Already implemented elsewhere (has its own route); otherwise a placeholder page is generated. */
  implemented?: boolean
}

/**
 * THE single navigation catalogue. Each entry is keyed by the permission code the server enforces for that module
 * (permissions catalogue, migration 0003 / 0022). Modules without a permission in the catalogue are not listed. The sidebar,
 * the mobile drawer, the home overview and the guarded routes are all generated from this list. can() is UX only.
 */
export const MODULE_NAV: readonly ModuleNavItem[] = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    segment: 'dashboard',
    permission: 'dashboard.view',
    group: 'operations',
    icon: LayoutDashboard,
    summary: 'Live sales and activity for the open business day.',
  },
  {
    id: 'pos',
    label: 'POS',
    segment: 'pos',
    permission: 'orders.create',
    group: 'operations',
    icon: ShoppingCart,
    summary: 'Take orders at the table or counter.',
    implemented: true,
  },
  {
    id: 'cashier',
    label: 'Cashier',
    segment: 'cashier',
    permission: 'payments.create',
    group: 'operations',
    icon: Wallet,
    summary: 'Confirm payments and issue receipts.',
    implemented: true,
  },
  {
    id: 'installments',
    label: 'Installments',
    segment: 'installments',
    permission: 'vouchers.view',
    group: 'operations',
    icon: ReceiptText,
    summary: 'Installment vouchers and collections.',
  },
  {
    id: 'menu',
    label: 'Menu',
    segment: 'menu',
    permission: 'menu.view',
    group: 'management',
    icon: Store,
    summary: 'Menu items, categories and recipes.',
    implemented: true,
  },
  {
    id: 'inventory',
    label: 'Inventory',
    segment: 'inventory',
    permission: 'inventory.view',
    group: 'management',
    icon: Warehouse,
    summary: 'Ingredients, stock levels and movements.',
    implemented: true,
  },
  {
    id: 'day-close',
    label: 'Day close',
    segment: 'day-close',
    permission: 'day_close.execute',
    group: 'management',
    icon: CalendarCheck,
    summary: 'Close the business day and review the summary.',
  },
  {
    id: 'settings',
    label: 'Restaurant',
    segment: 'settings/restaurant',
    permission: 'settings.manage',
    group: 'settings',
    icon: Settings,
    summary: 'Restaurant details, business settings and branding.',
    implemented: true,
  },
  {
    id: 'users',
    label: 'Users',
    segment: 'settings/users',
    permission: 'users.view',
    group: 'settings',
    icon: Users,
    summary: 'Staff, PIN resets and Tenant Admin invitations.',
    implemented: true,
  },
  {
    id: 'roles',
    label: 'Roles & rights',
    segment: 'settings/roles',
    permission: 'roles.manage',
    group: 'settings',
    icon: ShieldCheck,
    summary: 'Roles, the permission matrix and station access.',
    implemented: true,
  },
  {
    id: 'subscription',
    label: 'Subscription',
    segment: 'settings/subscription',
    permission: 'settings.manage',
    group: 'settings',
    icon: CreditCard,
    summary: 'Your plan and usage against its limits.',
    implemented: true,
  },
  {
    id: 'terminals',
    label: 'Terminals',
    segment: 'settings/terminals',
    permission: 'kiosks.manage',
    group: 'settings',
    icon: MonitorSmartphone,
    summary: 'Register and revoke shared floor terminals.',
    implemented: true,
  },
]

export const GROUP_LABELS: Readonly<Record<ModuleNavSpec['group'], string>> = {
  operations: 'Operations',
  management: 'Management',
  settings: 'Settings',
}

/** Icon used for a station row without a (known) icon slug. */
export const DEFAULT_STATION_ICON: LucideIcon = ChefHat
