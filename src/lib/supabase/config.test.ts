import { beforeEach, describe, expect, it, vi } from 'vitest'
import { blockingUsage, configError, deleteConfigRow, describeUsage, fetchConfigUsage, updateConfigRow } from './config'

const h = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }))
vi.mock('./client', () => ({ supabase: { rpc: h.rpc, from: h.from } }))

beforeEach(() => {
  h.rpc.mockReset()
  h.from.mockReset()
})

describe('configuration domains client', () => {
  it('maps guard refusals to in_use with the counted detail, and drops unsafe details', () => {
    expect(configError({ code: 'P0001', message: 'in_use', details: 'menu_items:3,ingredients:2' })).toMatchObject({
      code: 'in_use',
      detail: 'menu_items:3,ingredients:2',
    })
    expect(configError({ code: 'P0001', message: 'in_use', details: 'Key (id)=(x) is still referenced' })).toMatchObject({
      code: 'in_use',
      detail: undefined,
    })
    expect(configError({ code: '23505', message: 'duplicate key value violates unique constraint "x"' }).code).toBe('duplicate_name')
    expect(configError({ code: 'XX000', message: 'Something with SQL text' }).code).toBe('config_failed')
  })

  it('describes the blocking dependency in plain words; unknown keys are skipped', () => {
    expect(describeUsage('menu_items:3,ingredients:2')).toBe('3 menu items, 2 ingredients')
    expect(describeUsage('last_active_method')).toMatch(/only active payment method/)
    expect(describeUsage('secret_table:9')).toBe('other records')
    expect(blockingUsage({ menu_items: 2, active_menu_items: 2, payments: 0 })).toEqual([['menu_items', 2]])
  })

  it('delete and usage send only the closed-list domain and the row id', async () => {
    h.rpc.mockResolvedValue({ data: { deleted: true }, error: null })
    await deleteConfigRow('payment_methods', '11111111-1111-4111-8111-111111111111')
    expect(h.rpc).toHaveBeenLastCalledWith('fn_delete_config_row', {
      p_domain: 'payment_methods',
      p_id: '11111111-1111-4111-8111-111111111111',
    })
    h.rpc.mockResolvedValue({ data: { tables: 1, active_tables: 1 }, error: null })
    await expect(fetchConfigUsage('table_areas', '11111111-1111-4111-8111-111111111111')).resolves.toEqual({ tables: 1, active_tables: 1 })
    h.rpc.mockResolvedValue({ data: null, error: { message: 'in_use', details: 'ingredients:1,menu_items:1' } })
    await expect(deleteConfigRow('stations', '11111111-1111-4111-8111-111111111111')).rejects.toMatchObject({
      code: 'in_use',
      detail: 'ingredients:1,menu_items:1',
    })
  })

  it('an update RLS hid (zero rows) is a refusal; tables write label, never presentation columns', async () => {
    const eq = vi.fn().mockResolvedValue({ error: null, count: 0 })
    const update = vi.fn(() => ({ eq }))
    h.from.mockReturnValue({ update })
    await expect(updateConfigRow('tables', 'id-1', { name: 'T9', color: '#ffffff', capacity: 6 })).rejects.toMatchObject({
      code: 'permission_denied',
    })
    expect(h.from).toHaveBeenLastCalledWith('tables')
    expect(update).toHaveBeenLastCalledWith({ label: 'T9', capacity: 6 }, { count: 'exact' })
  })
})
