import { describe, expect, it } from 'vitest'
import { dashboardVariant } from './dashboard'

const can = (perms: string[]) => (p: string) => perms.includes(p)
const ST = ['5b2f8a3e-1c4d-4e6f-8a9b-0c1d2e3f4a5b']

describe('dashboardVariant (permission / station access, never a name)', () => {
  it('reports.view or orders.view_all keeps the main dashboard', () => {
    expect(dashboardVariant(can(['dashboard.view', 'reports.view', 'orders.create']), ST)).toEqual({
      kind: 'main',
    })
    expect(dashboardVariant(can(['dashboard.view', 'orders.view_all', 'orders.create']), [])).toEqual({
      kind: 'main',
    })
  })
  it('orders.create without the floor-wide permissions gets the own-orders section', () => {
    expect(dashboardVariant(can(['dashboard.view', 'orders.create']), [])).toEqual({
      kind: 'personal',
      ownOrders: true,
      ownStations: false,
    })
  })
  it('station access gets the station section; both apply together', () => {
    expect(dashboardVariant(can(['dashboard.view', 'orders.view']), ST)).toEqual({
      kind: 'personal',
      ownOrders: false,
      ownStations: true,
    })
    expect(dashboardVariant(can(['dashboard.view', 'orders.create']), ST)).toEqual({
      kind: 'personal',
      ownOrders: true,
      ownStations: true,
    })
  })
  it('neither: the main dashboard', () => {
    expect(dashboardVariant(can(['dashboard.view']), [])).toEqual({ kind: 'main' })
  })
})
