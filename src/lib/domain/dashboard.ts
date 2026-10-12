// Which dashboard a signed-in tenant user sees (docs/note.md task 2). Decided ONLY by permissions and station access, never by a
// role or station name (both are dynamic tenant domains):
//   * reports.view OR orders.view_all  -> the main (floor) dashboard, unchanged (tenant_admin, cashier-like roles, managers)
//   * otherwise, with orders.create     -> the personal waiter section (own orders, sales, average, served / cancelled)
//   * otherwise, with station access    -> the personal station section (own stations' queue, in progress, ready, prep time)
//     (both sections when both apply)
//   * neither                           -> the main dashboard
// This is UX only: fn_my_dashboard returns the caller's own figures whatever the variant, and fn_dashboard scopes its counts by
// order visibility, so a mis-chosen variant can never show foreign data.

export type DashboardVariant =
  { kind: 'main' } | { kind: 'personal'; ownOrders: boolean; ownStations: boolean }

export function dashboardVariant(
  can: (permission: string) => boolean,
  stationIds: readonly string[],
): DashboardVariant {
  if (can('reports.view') || can('orders.view_all')) return { kind: 'main' }
  const ownOrders = can('orders.create')
  const ownStations = stationIds.length > 0
  return ownOrders || ownStations ? { kind: 'personal', ownOrders, ownStations } : { kind: 'main' }
}
