import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthValue } from '@/features/auth/useAuth'
import type * as MenuModule from '@/lib/supabase/menu'
import type * as InventoryModule from '@/lib/supabase/inventory'
import type * as RefModule from '@/lib/supabase/reference-data'
import type * as ImagesModule from '@/lib/supabase/menu-images'

const h = vi.hoisted(() => ({
  fetchMenuItems: vi.fn(),
  createMenuItem: vi.fn(),
  updateMenuItem: vi.fn(),
  setMenuItemActive: vi.fn(),
  setRecipe: vi.fn(),
  fetchRecipe: vi.fn(),
  subscribeToMenu: vi.fn(),
  fetchCategories: vi.fn(),
  fetchAllStations: vi.fn(),
  fetchIngredients: vi.fn(),
  uploadMenuImage: vi.fn(),
  removeMenuImage: vi.fn(),
  signedMenuImageUrl: vi.fn(),
}))
vi.mock('@/lib/supabase/client', () => ({ supabase: {} }))
vi.mock('@/lib/supabase/menu', async (orig) => ({
  ...(await orig<typeof MenuModule>()),
  fetchMenuItems: h.fetchMenuItems,
  createMenuItem: h.createMenuItem,
  updateMenuItem: h.updateMenuItem,
  setMenuItemActive: h.setMenuItemActive,
  setRecipe: h.setRecipe,
  fetchRecipe: h.fetchRecipe,
  subscribeToMenu: h.subscribeToMenu,
}))
vi.mock('@/lib/supabase/reference-data', async (orig) => ({
  ...(await orig<typeof RefModule>()),
  fetchCategories: h.fetchCategories,
  fetchAllStations: h.fetchAllStations,
}))
vi.mock('@/lib/supabase/inventory', async (orig) => ({
  ...(await orig<typeof InventoryModule>()),
  fetchIngredients: h.fetchIngredients,
}))
vi.mock('@/lib/supabase/menu-images', async (orig) => ({
  ...(await orig<typeof ImagesModule>()),
  uploadMenuImage: h.uploadMenuImage,
  removeMenuImage: h.removeMenuImage,
  signedMenuImageUrl: h.signedMenuImageUrl,
}))

const { MenuPage } = await import('./MenuPage')
const { RpcError } = await import('@/lib/supabase/rpc')

const RID = '99999999-9999-4999-8999-999999999999'
// Category / station names are runtime data: nothing in the code under test knows them.
const CAT_A = '11111111-1111-4111-8111-11111111111a'
const CAT_B = '11111111-1111-4111-8111-11111111111b'
const ST = '22222222-2222-4222-8222-222222222222'
const ING = '44444444-4444-4444-8444-444444444444'
const item = (id: string, name: string, category_id: string, extra: object = {}) => ({
  id,
  name,
  description: null,
  category_id,
  station_id: ST,
  price: 150,
  emoji: null,
  image_path: null,
  sort_order: 0,
  is_active: true,
  ...extra,
})
const ITEMS = [
  item('aaaaaaaa-0000-4000-8000-000000000001', 'Honey Cake', CAT_B),
  item('aaaaaaaa-0000-4000-8000-000000000002', 'Shiro', CAT_A, { price: 85.5 }),
  item('aaaaaaaa-0000-4000-8000-000000000003', 'Old Dish', CAT_A, { is_active: false }),
]

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
          <MenuPage />
        </MemoryRouter>
      </QueryClientProvider>
    </AuthContext.Provider>,
  )
}

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset()
  h.fetchMenuItems.mockResolvedValue(ITEMS)
  h.fetchCategories.mockResolvedValue([
    { id: CAT_B, name: 'Sweet Things', color: '#7c3aed', icon: 'cake-slice', sort_order: 2, is_active: true },
    { id: CAT_A, name: 'Hot Plates', color: null, icon: null, sort_order: 1, is_active: true },
  ])
  h.fetchAllStations.mockResolvedValue([
    { id: ST, name: 'Line One', color: '#0f766e', icon: 'soup', sort_order: 1, is_active: true },
  ])
  h.fetchIngredients.mockResolvedValue([
    {
      id: ING,
      name: 'Flour',
      station_id: ST,
      unit: 'kg',
      stock: 5,
      min_level: 1,
      cost_per_unit: 40,
      is_active: true,
    },
  ])
  h.fetchRecipe.mockResolvedValue([])
  h.subscribeToMenu.mockReturnValue(() => {})
  h.signedMenuImageUrl.mockResolvedValue(null)
})

describe('MenuPage', () => {
  it('realtime: ingredient and recipe changes invalidate the ingredient list used by the recipe editor', async () => {
    const spy = vi.spyOn(QueryClient.prototype, 'invalidateQueries')
    try {
      renderPage(['menu.view'])
      await waitFor(() => expect(h.subscribeToMenu).toHaveBeenCalledWith(RID, expect.any(Function)))
      const onChange = h.subscribeToMenu.mock.calls[0]![1] as (table: string) => void
      onChange('ingredients')
      expect(spy).toHaveBeenLastCalledWith({ queryKey: ['ingredients', RID] })
      spy.mockClear()
      onChange('recipe_lines')
      expect(spy).toHaveBeenCalledWith({ queryKey: ['recipe', RID] })
      expect(spy).toHaveBeenCalledWith({ queryKey: ['ingredients', RID] })
    } finally {
      spy.mockRestore()
    }
  })

  it('groups active items by category row in sort order, with filters generated from the rows (view only)', async () => {
    renderPage(['menu.view'])
    const sections = await screen.findAllByRole('region')
    expect(sections.map((s) => within(s).getByRole('heading', { level: 2 }).textContent)).toEqual([
      expect.stringContaining('Hot Plates'),
      expect.stringContaining('Sweet Things'),
    ])
    expect(screen.getByText('ETB 85.50')).toBeInTheDocument()
    expect(screen.queryByText('Old Dish')).toBeNull()
    expect(screen.queryByRole('button', { name: 'New item' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Edit/ })).toBeNull()
    expect(h.subscribeToMenu).toHaveBeenCalledWith(RID, expect.any(Function))

    const filters = screen.getByRole('group', { name: 'Filter by category' })
    await userEvent.click(within(filters).getByRole('button', { name: 'Sweet Things' }))
    expect(screen.queryByText('Shiro')).toBeNull()
    expect(screen.getByText('Honey Cake')).toBeInTheDocument()
    await userEvent.click(screen.getByLabelText('Show inactive items'))
    await userEvent.click(within(filters).getByRole('button', { name: 'All' }))
    expect(screen.getByText('Old Dish')).toBeInTheDocument()
  })

  it('creates an item with category / station ids from the rows', async () => {
    h.createMenuItem.mockResolvedValue(ITEMS[0])
    renderPage(['menu.view', 'menu.manage'])
    await userEvent.click(await screen.findByRole('button', { name: 'New item' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Fir Fir')
    await userEvent.type(within(dialog).getByLabelText('Price (ETB)'), '120.5')
    await userEvent.selectOptions(within(dialog).getByLabelText('Category'), 'Sweet Things')
    await userEvent.selectOptions(within(dialog).getByLabelText('Prepared at station'), 'Line One')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create item' }))
    await waitFor(() =>
      expect(h.createMenuItem).toHaveBeenCalledWith({
        name: 'Fir Fir',
        price: 120.5,
        category_id: CAT_B,
        station_id: ST,
        description: null,
        emoji: null,
        image_path: null,
        sort_order: 0,
      }),
    )
    expect(h.uploadMenuImage).not.toHaveBeenCalled()
  })

  it('shows field and server errors with safe copy', async () => {
    h.createMenuItem.mockRejectedValue(new RpcError('duplicate_name', 'name'))
    renderPage(['menu.view', 'menu.manage'])
    await userEvent.click(await screen.findByRole('button', { name: 'New item' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create item' }))
    expect(await within(dialog).findByText('Enter a name.')).toBeInTheDocument()
    expect(h.createMenuItem).not.toHaveBeenCalled()

    await userEvent.type(within(dialog).getByLabelText('Name'), 'Shiro')
    await userEvent.type(within(dialog).getByLabelText('Price (ETB)'), '10')
    await userEvent.selectOptions(within(dialog).getByLabelText('Category'), 'Hot Plates')
    await userEvent.selectOptions(within(dialog).getByLabelText('Prepared at station'), 'Line One')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create item' }))
    expect(
      await within(dialog).findByText('That name is already used. Choose another name.'),
    ).toBeInTheDocument()

    h.createMenuItem.mockRejectedValue(new RpcError('plan_limit_reached', 'menu_items'))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create item' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/limit of active menu items/)
  })

  it('explains the blocking dependency when a reactivation is refused', async () => {
    h.setMenuItemActive.mockRejectedValue(new RpcError('invalid_state', 'ingredient_inactive'))
    renderPage(['menu.view', 'menu.manage'])
    await userEvent.click(await screen.findByLabelText('Show inactive items'))
    await userEvent.click(screen.getByRole('button', { name: 'Reactivate Old Dish' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reactivate' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      /ingredient in this recipe is inactive/,
    )
    expect(h.setMenuItemActive).toHaveBeenCalledWith(ITEMS[2]?.id, true)
  })

  it('edits a recipe and saves it through fn_set_recipe', async () => {
    h.setRecipe.mockImplementation((id: string, lines: unknown) =>
      Promise.resolve({ menu_item_id: id, lines }),
    )
    renderPage(['menu.view', 'menu.manage'])
    await userEvent.click(await screen.findByRole('button', { name: 'Recipe for Shiro' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Add ingredient' }))
    await userEvent.selectOptions(within(dialog).getByLabelText('Ingredient 1'), 'Flour (kg)')
    await userEvent.type(within(dialog).getByLabelText('Quantity (kg)'), '0.25')
    expect(within(dialog).getByTestId('recipe-cost')).toHaveTextContent('ETB 10.00')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save recipe' }))
    await waitFor(() =>
      expect(h.setRecipe).toHaveBeenCalledWith(ITEMS[1]?.id, [{ ingredient_id: ING, qty_per_serving: 0.25 }]),
    )
  })

  describe('photo upload', () => {
    const IMG = `restaurants/${RID}/menu/new-photo.png`
    const OLD = `restaurants/${RID}/menu/old-photo.webp`
    const png = () =>
      new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])], 'tibs.png', { type: 'image/png' })

    it('shows thumbnails through signed URLs on the list', async () => {
      h.fetchMenuItems.mockResolvedValue([item(ITEMS[1]!.id, 'Shiro', CAT_A, { image_path: OLD })])
      h.signedMenuImageUrl.mockResolvedValue('https://storage.test/signed/old-photo.webp?token=t')
      renderPage(['menu.view'])
      const card = await screen.findByRole('article', { name: 'Shiro' })
      await waitFor(() =>
        expect(card.querySelector('img')).toHaveAttribute(
          'src',
          'https://storage.test/signed/old-photo.webp?token=t',
        ),
      )
      expect(h.signedMenuImageUrl).toHaveBeenCalledWith(OLD)
    })

    it('create: uploads the picked photo to the own tenant prefix and passes the path as image_path', async () => {
      h.uploadMenuImage.mockResolvedValue(IMG)
      h.createMenuItem.mockResolvedValue(ITEMS[0])
      renderPage(['menu.view', 'menu.manage'])
      await userEvent.click(await screen.findByRole('button', { name: 'New item' }))
      const dialog = await screen.findByRole('dialog')
      expect(within(dialog).getByRole('button', { name: 'Choose photo' })).toBeVisible()
      const file = png()
      await userEvent.upload(within(dialog).getByLabelText('Photo (optional)'), file)
      expect(within(dialog).getByText(/Selected: tibs.png/)).toBeInTheDocument()
      expect(within(dialog).getByRole('button', { name: 'Replace photo' })).toBeInTheDocument()
      await userEvent.type(within(dialog).getByLabelText('Name'), 'Tibs')
      await userEvent.type(within(dialog).getByLabelText('Price (ETB)'), '250')
      await userEvent.selectOptions(within(dialog).getByLabelText('Category'), 'Hot Plates')
      await userEvent.selectOptions(within(dialog).getByLabelText('Prepared at station'), 'Line One')
      await userEvent.click(within(dialog).getByRole('button', { name: 'Create item' }))
      await waitFor(() =>
        expect(h.createMenuItem).toHaveBeenCalledWith(expect.objectContaining({ image_path: IMG })),
      )
      expect(h.uploadMenuImage).toHaveBeenCalledWith(RID, file)
      expect(h.removeMenuImage).not.toHaveBeenCalled()
    })

    it('refuses a non-image or oversize file before upload', async () => {
      renderPage(['menu.view', 'menu.manage'])
      await userEvent.click(await screen.findByRole('button', { name: 'New item' }))
      const dialog = await screen.findByRole('dialog')
      const picker = within(dialog).getByLabelText('Photo (optional)')
      await userEvent.upload(picker, new File(['GIF89a'], 'a.gif', { type: 'image/gif' }), {
        applyAccept: false,
      })
      expect(await within(dialog).findByText('Choose a PNG, JPEG or WebP photo.')).toBeInTheDocument()
      const big = new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' })
      await userEvent.upload(picker, big)
      expect(await within(dialog).findByText('The photo is larger than 2 MB.')).toBeInTheDocument()
      expect(h.uploadMenuImage).not.toHaveBeenCalled()
    })

    it('edit: replace sends the new path and removes the old object; remove sends image_path null', async () => {
      h.fetchMenuItems.mockResolvedValue([item(ITEMS[1]!.id, 'Shiro', CAT_A, { image_path: OLD })])
      h.uploadMenuImage.mockResolvedValue(IMG)
      h.updateMenuItem.mockResolvedValue(ITEMS[1])
      renderPage(['menu.view', 'menu.manage'])
      await userEvent.click(await screen.findByRole('button', { name: 'Edit Shiro' }))
      let dialog = await screen.findByRole('dialog')
      await userEvent.upload(within(dialog).getByLabelText('Photo (optional)'), png())
      await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))
      await waitFor(() => expect(h.updateMenuItem).toHaveBeenCalledWith(ITEMS[1]!.id, { image_path: IMG }))
      expect(h.removeMenuImage).toHaveBeenCalledWith(OLD)

      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      await userEvent.click(screen.getByRole('button', { name: 'Edit Shiro' }))
      dialog = await screen.findByRole('dialog')
      await userEvent.click(within(dialog).getByRole('button', { name: 'Remove photo' }))
      expect(within(dialog).getByText(/will be removed on save/)).toBeInTheDocument()
      await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))
      await waitFor(() =>
        expect(h.updateMenuItem).toHaveBeenLastCalledWith(ITEMS[1]!.id, { image_path: null }),
      )
    })

    it('a failed save removes the just-uploaded orphan', async () => {
      h.uploadMenuImage.mockResolvedValue(IMG)
      h.createMenuItem.mockRejectedValue(new RpcError('invalid_input', 'image_path'))
      renderPage(['menu.view', 'menu.manage'])
      await userEvent.click(await screen.findByRole('button', { name: 'New item' }))
      const dialog = await screen.findByRole('dialog')
      await userEvent.upload(within(dialog).getByLabelText('Photo (optional)'), png())
      await userEvent.type(within(dialog).getByLabelText('Name'), 'Tibs')
      await userEvent.type(within(dialog).getByLabelText('Price (ETB)'), '250')
      await userEvent.selectOptions(within(dialog).getByLabelText('Category'), 'Hot Plates')
      await userEvent.selectOptions(within(dialog).getByLabelText('Prepared at station'), 'Line One')
      await userEvent.click(within(dialog).getByRole('button', { name: 'Create item' }))
      expect(await within(dialog).findByText(/image could not be attached/)).toBeInTheDocument()
      expect(h.removeMenuImage).toHaveBeenCalledWith(IMG)
    })
  })
})
