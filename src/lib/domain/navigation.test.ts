import { describe, expect, it } from 'vitest'
import {
  accountLinkIds,
  canOpenStation,
  groupModules,
  isUuid,
  visibleModules,
  visibleStations,
  type ModuleNavSpec,
  type StationNavRow,
} from './navigation'

const can = (perms: string[]) => (p: string) => perms.includes(p)

const MODULES: ModuleNavSpec[] = [
  { id: 'a', label: 'A', segment: 'a', permission: 'p.a', group: 'operations' },
  { id: 'b', label: 'B', segment: 'b', permission: 'p.b', group: 'management' },
  { id: 'c', label: 'C', segment: 'c', permission: 'p.c', group: 'operations' },
  { id: 'd', label: 'D', segment: 'd', permission: 'p.d', group: 'settings' },
]

describe('visibleModules / groupModules', () => {
  it('keeps only modules whose permission is held, in catalogue order', () => {
    expect(visibleModules(MODULES, can(['p.c', 'p.a'])).map((m) => m.id)).toEqual(['a', 'c'])
    expect(visibleModules(MODULES, can([]))).toEqual([])
  })

  it('groups in first-appearance order and drops empty groups', () => {
    const groups = groupModules(visibleModules(MODULES, can(['p.a', 'p.b', 'p.c'])))
    expect(groups.map((g) => g.group)).toEqual(['operations', 'management'])
    expect(groups[0]?.items.map((m) => m.id)).toEqual(['a', 'c'])
  })
})

describe('accountLinkIds (Phase 1 visibility rules)', () => {
  it('required: only Change PIN, even with permissions', () => {
    expect(
      accountLinkIds({ status: 'required', can: can(['users.manage']), supabaseAuthSession: true }),
    ).toEqual(['change-pin'])
  })
  it('pending approval: nothing', () => {
    expect(
      accountLinkIds({ status: 'pending_approval', can: can(['users.manage']), supabaseAuthSession: true }),
    ).toEqual([])
  })
  it('none: permission-gated links plus Security for Supabase Auth sessions only', () => {
    expect(
      accountLinkIds({
        status: 'none',
        can: can(['users.manage', 'settings.session_timers']),
        supabaseAuthSession: true,
      }),
    ).toEqual(['pin-approvals', 'session-timers', 'security'])
    expect(accountLinkIds({ status: 'none', can: can([]), supabaseAuthSession: false })).toEqual([])
  })
})

const S1 = '11111111-1111-4111-8111-111111111111'
const S2 = '22222222-2222-4222-8222-222222222222'
const S3 = '33333333-3333-4333-8333-333333333333'
const station = (id: string, name: string, extra: Partial<StationNavRow> = {}): StationNavRow => ({
  id,
  name,
  is_active: true,
  ...extra,
})

describe('visibleStations', () => {
  const rows = [
    station(S1, 'Zeta', { sort_order: 2 }),
    station(S2, 'Alpha', { sort_order: 2 }),
    station(S3, 'Omega', { sort_order: 1 }),
  ]

  it('shows only stations in the access list, sorted by sort_order then name', () => {
    const out = visibleStations(rows, { stationIds: [S1, S2, S3], can: can(['orders.view']) })
    expect(out.map((s) => s.name)).toEqual(['Omega', 'Alpha', 'Zeta'])
    expect(visibleStations(rows, { stationIds: [S2], can: can(['orders.view']) }).map((s) => s.id)).toEqual([
      S2,
    ])
  })

  it('hides everything without the board permission (orders.view)', () => {
    expect(visibleStations(rows, { stationIds: [S1, S2, S3], can: can([]) })).toEqual([])
  })

  it('drops inactive rows and malformed ids even when listed', () => {
    const out = visibleStations([station(S1, 'A', { is_active: false }), station('not-a-uuid', 'B')], {
      stationIds: [S1, 'not-a-uuid'],
      can: can(['orders.view']),
    })
    expect(out).toEqual([])
  })

  it('works for a station created at runtime (no code knows its name)', () => {
    const NEW = '44444444-4444-4444-8444-444444444444'
    const out = visibleStations([station(NEW, 'Grill')], { stationIds: [NEW], can: can(['orders.view']) })
    expect(out.map((s) => s.id)).toEqual([NEW])
  })
})

describe('canOpenStation / isUuid', () => {
  it('needs a uuid, the board permission and access', () => {
    const access = { stationIds: [S1], can: can(['orders.view']) }
    expect(canOpenStation(S1, access)).toBe(true)
    expect(canOpenStation(S2, access)).toBe(false)
    expect(canOpenStation(undefined, access)).toBe(false)
    expect(canOpenStation(S1, { stationIds: [S1], can: can([]) })).toBe(false)
    expect(isUuid('x')).toBe(false)
  })
})
