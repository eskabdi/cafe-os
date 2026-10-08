import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  result: { data: [] as unknown, error: null as null | { message: string } },
  calls: [] as Array<[string, ...unknown[]]>,
  ons: [] as Array<{ table: string; filter: string; cb: () => void }>,
  removeChannel: vi.fn(),
}))

vi.mock('./client', () => {
  const query: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'order'])
    query[m] = (...args: unknown[]) => {
      h.calls.push([m, ...args])
      return query
    }
  query.then = (resolve: (v: unknown) => unknown) => Promise.resolve(h.result).then(resolve)
  const channel = {
    on: (_t: string, f: { table: string; filter: string }, cb: () => void) => {
      h.ons.push({ table: f.table, filter: f.filter, cb })
      return channel
    },
    subscribe: () => channel,
  }
  return {
    supabase: {
      from: (table: string) => {
        h.calls.push(['from', table])
        return query
      },
      channel: () => channel,
      removeChannel: h.removeChannel,
    },
  }
})

import { fetchActiveStations, subscribeToStations } from './stations'

const ID = '11111111-1111-4111-8111-111111111111'
const RID = '22222222-2222-4222-8222-222222222222'
const ROLE = '33333333-3333-4333-8333-333333333333'

beforeEach(() => {
  h.calls = []
  h.ons = []
  h.result = { data: [], error: null }
})

describe('fetchActiveStations', () => {
  it('reads active stations through RLS without sending a restaurant_id', async () => {
    h.result.data = [{ id: ID, name: 'Any', color: '#123abc', icon: 'chef-hat', sort_order: 1, is_active: true }]
    const rows = await fetchActiveStations()
    expect(rows).toHaveLength(1)
    expect(h.calls).toContainEqual(['from', 'stations'])
    expect(h.calls).toContainEqual(['eq', 'is_active', true])
    expect(h.calls.some(([, col]) => col === 'restaurant_id')).toBe(false)
  })

  it('drops malformed rows and neutralises unsafe presentation values', async () => {
    h.result.data = [
      { id: 'nope', name: 'x', is_active: true },
      { id: ID, name: 'Ok', color: 'red;background:url(x)', icon: '<svg>', is_active: true },
      { id: ID, name: 'Off', is_active: false },
    ]
    const rows = await fetchActiveStations()
    expect(rows).toEqual([expect.objectContaining({ id: ID, name: 'Ok', color: null, icon: null })])
  })

  it('throws a safe code on error (no server text)', async () => {
    h.result = { data: null, error: { message: 'relation "x" violates ... SQL detail' } }
    await expect(fetchActiveStations()).rejects.toThrow('stations_unavailable')
  })
})

describe('subscribeToStations', () => {
  it('listens to the tenant stations and the role station access, and unsubscribes', () => {
    const onStationsChange = vi.fn()
    const onAccessChange = vi.fn()
    const off = subscribeToStations(RID, ROLE, { onStationsChange, onAccessChange })
    expect(h.ons.map((o) => [o.table, o.filter])).toEqual([
      ['stations', `restaurant_id=eq.${RID}`],
      ['role_station_access', `role_id=eq.${ROLE}`],
    ])
    h.ons[0]?.cb()
    h.ons[1]?.cb()
    expect(onStationsChange).toHaveBeenCalledOnce()
    expect(onAccessChange).toHaveBeenCalledOnce()
    off()
    expect(h.removeChannel).toHaveBeenCalled()
  })

  it('refuses non-uuid ids (no filter injection)', () => {
    subscribeToStations('x,role_id=neq.0', ROLE, { onStationsChange: vi.fn(), onAccessChange: vi.fn() })
    expect(h.ons).toEqual([])
  })
})
