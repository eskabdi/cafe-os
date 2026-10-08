import type { RouteObject } from 'react-router-dom'
import { ComingSoonPage } from './ComingSoonPage'
import { MODULE_NAV, type ModuleNavItem } from './nav-config'
import { RequireNavPermission } from './RouteGuards'

/**
 * Guarded placeholder routes for every catalogue module that has no page yet, generated from MODULE_NAV so the route
 * permission is always the same code as the nav entry (and as the server check). Implemented modules declare their own
 * route and wrap it in RequireNavPermission.
 */
export function placeholderModuleRoutes(modules: readonly ModuleNavItem[] = MODULE_NAV): RouteObject[] {
  return modules
    .filter((m) => !m.implemented)
    .map((m) => ({
      element: <RequireNavPermission permission={m.permission} />,
      children: [{ path: m.segment, element: <ComingSoonPage module={m} /> }],
    }))
}
