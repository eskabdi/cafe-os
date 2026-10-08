import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthValue } from '@/features/auth/useAuth'
import type * as InventoryModule from '@/lib/supabase/inventory'
import type * as RefModule from '@/lib/supabase/reference-data'

const h = vi.hoisted(() => ({
  fetchIngredients: vi.fn(),
  createIngredient: vi.fn(),
  updateIngredient: vi.fn(),
  setIngredientActive: vi.fn(),
  receiveStock: vi.fn(),
  adjustStock: vi.fn(),
  reverseStockMovement: vi.fn(),
  listStockMovements: vi.fn(),
  fetchStockStepupThreshold: vi.fn(),
  setStockStepupThreshold: vi.fn(),
  subscribeToInventory: vi.fn(),
  fetchAllStations: vi.fn(),
  listFactors: vi.fn(),
  challengeAndVerify: vi.fn(),
}))
vi.mock('@/lib/supabase/client', () => ({
  supabase: { auth: { mfa: { listFactors: h.listFactors, challengeAndVerify: h.challengeAndVerify } } },
}))
vi.mock('@/lib/supabase/inventory', async (orig) => ({
  ...(await orig<typeof InventoryModule>()),
  fetchIngredients: h.fetchIngredients,
  createIngredient: h.createIngredient,
  updateIngredient: h.updateIngredient,
  setIngredientActive: h.setIngredientActive,
  receiveStock: h.receiveStock,
  adjustStock: h.adjustStock,
  reverseStockMovement: h.reverseStockMovement,
  listStockMovements: h.listStockMovements,
  fetchStockStepupThreshold: h.fetchStockStepupThreshold,
  setStockStepupThreshold: h.setStockStepupThreshold,
  subscribeToInventory: h.subscribeToInventory,
}))
vi.mock('@/lib/supabase/reference-data', async (orig) => ({
  ...(await orig<typeof RefModule>()),
  fetchAllStations: h.fetchAllStations,
}))

const { InventoryPage } = await import('./InventoryPage')
const { MOVEMENTS_PAGE_SIZE } = await import('./useInventory')
const { RpcError } = await import('@/lib/supabase/rpc')

const RID = '99999999-9999-4999-8999-999999999999'
const ST = '22222222-2222-4222-8222-222222222222'
const FLOUR = '44444444-4444-4444-8444-444444444441'
const OIL = '44444444-4444-4444-8444-444444444442'
const INGREDIENTS = [
  {
    id: FLOUR,
    name: 'Flour',
    station_id: ST,
    unit: 'kg',
    stock: 1,
    min_level: 2,
    cost_per_unit: 40,
    is_active: true,
  },
  {
    id: OIL,
    name: 'Oil',
    station_id: ST,
    unit: 'L',
    stock: 20,
    min_level: 2,
    cost_per_unit: 300,
    is_active: true,
  },
]
const mov = (n: number, extra: object = {}) => ({
  id: `55555555-5555-4555-8555-${String(n).padStart(12, '0')}`,
  ingredient_id: FLOUR,
  ingredient_name: 'Flour',
  unit: 'kg',
  station_id: ST,
  qty_delta: 2,
  reason: 'received',
  note: null,
  order_id: null,
  reverses_movement_id: null,
  day_session_id: null,
  created_by: null,
  created_by_name: 'Abebe Kebede',
  created_at: `2026-10-08T10:${String(59 - (n % 60)).padStart(2, '0')}:00Z`,
  ...extra,
})

function renderPage(perms: string[]) {
  const value: AuthValue = {
    status: 'authenticated',
    session: null,
    context: {
      user: { id: 'u', first_name: 'A', username: 'a' },
      restaurant: { id: RID, name: 'Demo', slug: 'demo-cafe', status: 'active' },
      permissions: perms,
      station_ids: [],
    },
    contextStatus: 'ready',
    can: (p) => perms.includes(p),
    signOut: vi.fn(),
    refreshContext: vi.fn(),
  }
  render(
    <AuthContext.Provider value={value}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <InventoryPage />
        </MemoryRouter>
      </QueryClientProvider>
    </AuthContext.Provider>,
  )
}

const ALL = ['inventory.view', 'inventory.adjust', 'inventory.receive']

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset()
  h.fetchIngredients.mockResolvedValue(INGREDIENTS)
  h.fetchAllStations.mockResolvedValue([
    { id: ST, name: 'Line One', color: '#0f766e', icon: null, sort_order: 1, is_active: true },
  ])
  h.fetchStockStepupThreshold.mockResolvedValue(5000)
  h.listStockMovements.mockResolvedValue([])
  h.subscribeToInventory.mockReturnValue(() => {})
  h.listFactors.mockResolvedValue({ data: { totp: [{ id: 'f-1' }] }, error: null })
  h.challengeAndVerify.mockResolvedValue({ error: null })
})

describe('InventoryPage', () => {
  it('lists ingredients with a low-stock alert; view-only users get no stock actions', async () => {
    renderPage(['inventory.view'])
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('1 ingredient is low on stock')
    expect(alert).toHaveTextContent('Flour: 1 kg (minimum 2 kg)')
    const rows = screen.getAllByTestId('ingredient-row')
    expect(rows).toHaveLength(2)
    expect(within(rows[0]!).getByText('Low stock')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Receive/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Adjust/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'New ingredient' })).toBeNull()
    expect(h.subscribeToInventory).toHaveBeenCalledWith(RID, expect.any(Function))
  })

  it('receives stock with one idempotency key, reused for the step-up retry', async () => {
    h.receiveStock.mockRejectedValueOnce(new RpcError('mfa_required')).mockResolvedValueOnce({
      movement_id: mov(1).id,
      ingredient_id: OIL,
      qty_delta: 20,
      reason: 'received',
      stock: 40,
    })
    renderPage(ALL)
    await userEvent.click(await screen.findByRole('button', { name: 'Receive Oil' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.type(within(dialog).getByLabelText('Quantity received (L)'), '20')
    expect(within(dialog).getByRole('note')).toHaveTextContent(/authenticator/)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Receive stock' }))
    const code = await screen.findByLabelText('Authentication code')
    await waitFor(() => expect(code).toBeEnabled())
    await userEvent.type(code, '123456')
    await userEvent.click(screen.getByRole('button', { name: 'Verify' }))
    await waitFor(() => expect(h.receiveStock).toHaveBeenCalledTimes(2))
    const [first] = h.receiveStock.mock.calls[0] as [{ idempotencyKey: string }]
    const [second] = h.receiveStock.mock.calls[1] as [{ idempotencyKey: string }]
    expect(first).toMatchObject({ ingredientId: OIL, qty: 20, note: null })
    expect(first.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/)
    expect(second.idempotencyKey).toBe(first.idempotencyKey)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    // a new intent gets a new key
    h.receiveStock.mockResolvedValueOnce({
      movement_id: mov(2).id,
      ingredient_id: OIL,
      qty_delta: 1,
      reason: 'received',
      stock: 41,
    })
    await userEvent.click(screen.getByRole('button', { name: 'Receive Oil' }))
    const again = await screen.findByRole('dialog')
    await userEvent.type(within(again).getByLabelText('Quantity received (L)'), '1')
    await userEvent.click(within(again).getByRole('button', { name: 'Receive stock' }))
    await waitFor(() => expect(h.receiveStock).toHaveBeenCalledTimes(3))
    const [third] = h.receiveStock.mock.calls[2] as [{ idempotencyKey: string }]
    expect(third.idempotencyKey).not.toBe(first.idempotencyKey)
  })

  it('adjustment requires a reason and maps insufficient_stock / day_closed', async () => {
    h.adjustStock
      .mockRejectedValueOnce(new RpcError('insufficient_stock'))
      .mockRejectedValueOnce(new RpcError('day_closed'))
    renderPage(ALL)
    await userEvent.click(await screen.findByRole('button', { name: 'Adjust Flour' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.type(within(dialog).getByLabelText('Change (kg)'), '-5')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Adjust stock' }))
    expect(await within(dialog).findByText('Enter a reason of at least 3 characters.')).toBeInTheDocument()
    expect(h.adjustStock).not.toHaveBeenCalled()
    await userEvent.type(within(dialog).getByLabelText('Reason (required)'), 'spoiled bag')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Adjust stock' }))
    expect(await within(dialog).findByText(/below zero/)).toBeInTheDocument()
    expect(h.adjustStock).toHaveBeenCalledWith(
      expect.objectContaining({ ingredientId: FLOUR, qtyDelta: -5, reason: 'spoiled bag' }),
    )
    await userEvent.click(within(dialog).getByRole('button', { name: 'Adjust stock' }))
    expect(await within(dialog).findByText(/business day is closed/)).toBeInTheDocument()
  })

  it('explains why a deactivation is refused', async () => {
    h.setIngredientActive.mockRejectedValue(new RpcError('invalid_state', 'ingredient_in_active_recipe'))
    renderPage(ALL)
    await userEvent.click(await screen.findByRole('button', { name: 'Deactivate Flour' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Deactivate' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/recipe of an active menu item/)
  })

  it('movement log pages with the keyset cursor of the last row and reverses a movement', async () => {
    const page1 = Array.from({ length: MOVEMENTS_PAGE_SIZE }, (_, i) => mov(i + 1))
    const last = page1[page1.length - 1]!
    h.listStockMovements
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce([mov(99, { reason: 'consumed', qty_delta: -1 })])
    h.reverseStockMovement.mockResolvedValue({
      movement_id: mov(100).id,
      ingredient_id: FLOUR,
      qty_delta: -2,
      reason: 'reversal',
      stock: 0,
    })
    renderPage(ALL)
    await userEvent.click(await screen.findByRole('tab', { name: 'Movement log' }))
    await waitFor(() => expect(screen.getAllByTestId('movement-row')).toHaveLength(MOVEMENTS_PAGE_SIZE))
    expect(h.listStockMovements).toHaveBeenLastCalledWith({
      ingredientId: null,
      limit: MOVEMENTS_PAGE_SIZE,
      cursor: null,
    })
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }))
    await waitFor(() => expect(screen.getAllByTestId('movement-row')).toHaveLength(MOVEMENTS_PAGE_SIZE + 1))
    expect(h.listStockMovements).toHaveBeenLastCalledWith({
      ingredientId: null,
      limit: MOVEMENTS_PAGE_SIZE,
      cursor: { before: last.created_at, beforeId: last.id },
    })
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull()
    // consumption rows are not reversible here
    const consumed = screen.getAllByTestId('movement-row').at(-1)!
    expect(within(consumed).queryByRole('button', { name: /Reverse/ })).toBeNull()

    await userEvent.click(screen.getAllByRole('button', { name: 'Reverse received of Flour' })[0]!)
    const dialog = await screen.findByRole('dialog')
    await userEvent.type(within(dialog).getByLabelText('Reason (required)'), 'entered twice')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reverse movement' }))
    await waitFor(() =>
      expect(h.reverseStockMovement).toHaveBeenCalledWith(
        expect.objectContaining({
          movementId: page1[0]!.id,
          reason: 'entered twice',
          idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
        }),
      ),
    )
  })

  it('History opens the movement log filtered to the ingredient', async () => {
    renderPage(['inventory.view'])
    await userEvent.click(await screen.findByRole('button', { name: 'History of Oil' }))
    await waitFor(() =>
      expect(h.listStockMovements).toHaveBeenLastCalledWith({
        ingredientId: OIL,
        limit: MOVEMENTS_PAGE_SIZE,
        cursor: null,
      }),
    )
    expect(screen.getByLabelText('Ingredient')).toHaveValue(OIL)
  })

  it('settings.manage can change the step-up threshold (aal2 prompt on mfa_required)', async () => {
    h.setStockStepupThreshold.mockRejectedValueOnce(new RpcError('mfa_required')).mockResolvedValueOnce(2500)
    renderPage(['inventory.view', 'settings.manage'])
    const input = await screen.findByLabelText('Threshold (ETB)')
    await waitFor(() => expect(input).toHaveValue('5000'))
    await userEvent.clear(input)
    await userEvent.type(input, '2500')
    await userEvent.click(screen.getByRole('button', { name: 'Save threshold' }))
    const code = await screen.findByLabelText('Authentication code')
    await waitFor(() => expect(code).toBeEnabled())
    await userEvent.type(code, '123456')
    await userEvent.click(screen.getByRole('button', { name: 'Verify' }))
    await waitFor(() => expect(h.setStockStepupThreshold).toHaveBeenCalledTimes(2))
    expect(h.setStockStepupThreshold).toHaveBeenLastCalledWith(2500)
  })
})
