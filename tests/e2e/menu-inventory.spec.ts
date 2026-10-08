import { expect, test, type Page, type Route } from '@playwright/test'

// Phase 3 menu + inventory against mocked Supabase Auth / REST / RPC / Storage (page.route); no real backend. The mock keeps
// a tiny stateful store so a write shows up in the next read. Category / station / ingredient names are runtime data only:
// no source code knows them. The mock records every RPC body so the test can assert what the client actually sends
// (intents + ids + idempotency keys, never a restaurant_id or a stock figure).
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
const exp = Math.floor(Date.now() / 1000) + 3600
const jwtFor = (aal: string) =>
  `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'u-1', aud: 'authenticated', role: 'authenticated', aal, exp })}.sig`
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': '*',
  'access-control-expose-headers': '*',
}
const RID = '99999999-9999-4999-8999-999999999999'
const CAT_HOT = '11111111-1111-4111-8111-11111111111a'
const CAT_SWEET = '11111111-1111-4111-8111-11111111111b'
const ST = '22222222-2222-4222-8222-222222222222'
const FLOUR = '44444444-4444-4444-8444-444444444441'
const BUTTER = '44444444-4444-4444-8444-444444444442'
// 1x1 PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

interface Store {
  items: Array<Record<string, unknown>>
  ingredients: Array<Record<string, unknown> & { id: string; stock: number; name: string; unit: string }>
  movements: Array<Record<string, unknown>>
  recipes: Record<string, unknown[]>
  rpc: Array<{ fn: string; body: Record<string, unknown> }>
  uploads: string[]
  receiveCalls: number
}

let seq = 0
const uuid = () => `66666666-6666-4666-8666-${String(++seq).padStart(12, '0')}`

async function setup(page: Page): Promise<Store> {
  const s: Store = {
    items: [
      {
        id: 'aaaaaaaa-0000-4000-8000-000000000001',
        name: 'Shiro',
        description: null,
        category_id: CAT_HOT,
        station_id: ST,
        price: 85.5,
        emoji: null,
        image_path: null,
        sort_order: 0,
        is_active: true,
      },
    ],
    ingredients: [
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
        id: BUTTER,
        name: 'Butter',
        station_id: ST,
        unit: 'kg',
        stock: 10,
        min_level: 1,
        cost_per_unit: 600,
        is_active: true,
      },
    ],
    movements: [],
    recipes: {},
    rpc: [],
    uploads: [],
    receiveCalls: 0,
  }
  const factors = [
    {
      id: 'f-1',
      friendly_name: 'Phone',
      factor_type: 'totp',
      status: 'verified',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
  ]
  const user = {
    id: 'u-1',
    aud: 'authenticated',
    role: 'authenticated',
    email: 'owner@example.com',
    app_metadata: {},
    user_metadata: {},
    created_at: '2026-01-01T00:00:00Z',
    factors,
  }
  const session = (aal: string) => ({
    access_token: jwtFor(aal),
    refresh_token: 'r',
    expires_at: exp,
    expires_in: 3600,
    token_type: 'bearer',
    user,
  })
  await page.addInitScript(
    ([sess]) => {
      localStorage.setItem('sb-127-auth-token', sess as string)
      window.__CAFEOS_INACTIVITY__ = { idleMs: 600_000, warnMs: 600_000 }
    },
    [JSON.stringify(session('aal1'))],
  )
  const json = (status: number, body: unknown) => ({
    status,
    headers: { ...CORS, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const preflight = (r: Route) =>
    r.request().method() === 'OPTIONS' && (void r.fulfill({ status: 204, headers: CORS }), true)
  const err = (code: string, details: string | null = null) =>
    json(400, { code: 'P0001', message: code, details, hint: null })
  const context = {
    user: { id: 'u-1', first_name: 'Owner', short_name: 'Owner', username: 'owner' },
    restaurant: { id: RID, name: 'Demo Cafe', slug: 'demo-cafe', status: 'active' },
    role: { id: 'role-1', name: 'Owner', system_key: 'tenant_admin', is_active: true },
    permissions: ['menu.view', 'menu.manage', 'inventory.view', 'inventory.adjust', 'inventory.receive'],
    station_ids: [],
    pin_change_status: 'none',
    pin_length: null,
  }

  await page.route('**/auth/v1/user', (r) => preflight(r) || r.fulfill(json(200, user)))
  await page.route('**/auth/v1/token*', (r) => preflight(r) || r.fulfill(json(200, session('aal2'))))
  await page.route(/\/auth\/v1\/factors/, (r) => {
    if (preflight(r)) return
    const action = new URL(r.request().url()).pathname.split('/').filter(Boolean)[4]
    if (action === 'challenge')
      return r.fulfill(json(200, { id: 'challenge-1', type: 'totp', expires_at: exp }))
    if (action === 'verify') return r.fulfill(json(200, session('aal2')))
    return r.fulfill(json(404, {}))
  })
  await page.route('**/rest/v1/user_notifications*', (r) => preflight(r) || r.fulfill(json(200, [])))
  await page.route(
    '**/rest/v1/categories*',
    (r) =>
      preflight(r) ||
      r.fulfill(
        json(200, [
          {
            id: CAT_SWEET,
            name: 'Sweet Things',
            description: null,
            color: '#7c3aed',
            icon: 'cake-slice',
            sort_order: 2,
            is_active: true,
          },
          {
            id: CAT_HOT,
            name: 'Hot Plates',
            description: null,
            color: null,
            icon: null,
            sort_order: 1,
            is_active: true,
          },
        ]),
      ),
  )
  await page.route(
    '**/rest/v1/stations*',
    (r) =>
      preflight(r) ||
      r.fulfill(
        json(200, [
          {
            id: ST,
            name: 'Line One',
            description: null,
            color: '#0f766e',
            icon: 'soup',
            sort_order: 1,
            is_active: true,
          },
        ]),
      ),
  )
  await page.route('**/rest/v1/menu_items*', (r) => preflight(r) || r.fulfill(json(200, s.items)))
  await page.route('**/rest/v1/ingredients*', (r) => preflight(r) || r.fulfill(json(200, s.ingredients)))
  await page.route('**/rest/v1/recipe_lines*', (r) => {
    if (preflight(r)) return
    const id = new URL(r.request().url()).searchParams.get('menu_item_id')?.replace(/^eq\./, '') ?? ''
    return r.fulfill(json(200, s.recipes[id] ?? []))
  })
  await page.route(
    '**/rest/v1/restaurants*',
    (r) => preflight(r) || r.fulfill(json(200, { stock_stepup_threshold: 5000 })),
  )

  // Storage: upload + signed URL + the signed image itself
  await page.route('**/storage/v1/object/sign/**', (r) => {
    if (preflight(r)) return
    const path = new URL(r.request().url()).pathname.replace('/storage/v1/object/sign/menu-images/', '')
    return r.fulfill(json(200, { signedURL: `/object/sign/menu-images/${path}?token=signed` }))
  })
  await page.route(/\/storage\/v1\/object\/menu-images\//, (r) => {
    if (preflight(r)) return
    const path = new URL(r.request().url()).pathname.replace('/storage/v1/object/menu-images/', '')
    s.uploads.push(path)
    return r.fulfill(json(200, { Key: `menu-images/${path}`, Id: 'obj-1' }))
  })
  await page.route(/\/storage\/v1\/object\/sign\/menu-images\/.*token=signed/, (r) =>
    r.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'image/png' }, body: PNG }),
  )

  const post = (
    ing: (typeof s.ingredients)[number],
    delta: number,
    reason: string,
    note: unknown,
    reverses: unknown = null,
  ) => {
    if (ing.stock + delta < 0) return null
    ing.stock = Math.round((ing.stock + delta) * 1000) / 1000
    const id = uuid()
    s.movements.unshift({
      id,
      ingredient_id: ing.id,
      ingredient_name: ing.name,
      unit: ing.unit,
      station_id: ST,
      qty_delta: delta,
      reason,
      note,
      order_id: null,
      reverses_movement_id: reverses,
      day_session_id: null,
      created_by: '77777777-7777-4777-8777-777777777777',
      created_by_name: 'Owner',
      created_at: new Date(Date.now() + s.movements.length * 1000).toISOString(),
    })
    return { movement_id: id, ingredient_id: ing.id, qty_delta: delta, reason, stock: ing.stock }
  }

  await page.route('**/rest/v1/rpc/*', (r) => {
    if (preflight(r)) return
    const fn = new URL(r.request().url()).pathname.split('/').pop() ?? ''
    const body = (r.request().postDataJSON() ?? {}) as Record<string, unknown>
    if (fn === 'fn_get_session_context') return r.fulfill(json(200, context))
    s.rpc.push({ fn, body })
    if (fn === 'fn_create_menu_item') {
      const row = {
        id: uuid(),
        name: body.p_name,
        description: body.p_description,
        category_id: body.p_category_id,
        station_id: body.p_station_id,
        price: body.p_price,
        emoji: body.p_emoji,
        image_path: body.p_image_path,
        sort_order: body.p_sort_order,
        is_active: true,
      }
      s.items.push(row)
      return r.fulfill(json(200, row))
    }
    if (fn === 'fn_update_menu_item') {
      const row = s.items.find((i) => i.id === body.p_menu_item_id)
      if (!row) return r.fulfill(err('not_found'))
      Object.assign(row, body.p_patch)
      return r.fulfill(json(200, row))
    }
    if (fn === 'fn_set_recipe') {
      s.recipes[String(body.p_menu_item_id)] = body.p_lines as unknown[]
      return r.fulfill(json(200, { menu_item_id: body.p_menu_item_id, lines: body.p_lines }))
    }
    if (fn === 'fn_set_ingredient_active') {
      const used = Object.values(s.recipes).some((lines) =>
        (lines as Array<{ ingredient_id: string }>).some((l) => l.ingredient_id === body.p_ingredient_id),
      )
      if (used && body.p_active === false)
        return r.fulfill(err('invalid_state', 'ingredient_in_active_recipe'))
      return r.fulfill(err('not_found'))
    }
    if (fn === 'fn_receive_stock') {
      s.receiveCalls++
      const ing = s.ingredients.find((i) => i.id === body.p_ingredient_id)!
      const qty = Number(body.p_qty)
      // the server's step-up rule: value >= threshold needs aal2; the mock asks on the first such call only
      if (qty * Number(ing.cost_per_unit) >= 5000 && !s.rpc.some((c) => c.fn === 'step-up-passed')) {
        s.rpc.push({ fn: 'step-up-passed', body: {} })
        return r.fulfill(err('mfa_required'))
      }
      return r.fulfill(json(200, post(ing, qty, 'received', body.p_note)))
    }
    if (fn === 'fn_adjust_stock') {
      const ing = s.ingredients.find((i) => i.id === body.p_ingredient_id)!
      const res = post(ing, Number(body.p_qty_delta), 'manual_adjustment', body.p_reason)
      return r.fulfill(res ? json(200, res) : err('insufficient_stock'))
    }
    if (fn === 'fn_reverse_stock_movement') {
      const m = s.movements.find((x) => x.id === body.p_movement_id)!
      const ing = s.ingredients.find((i) => i.id === m.ingredient_id)!
      return r.fulfill(json(200, post(ing, -Number(m.qty_delta), 'reversal', body.p_reason, m.id)))
    }
    if (fn === 'fn_list_stock_movements') {
      const id = body.p_ingredient_id
      return r.fulfill(
        json(
          200,
          s.movements.filter((m) => !id || m.ingredient_id === id),
        ),
      )
    }
    return r.fulfill(json(200, null))
  })
  return s
}

test('menu: grouped by category rows, create an item with a photo, thumbnail via signed URL, recipe', async ({
  page,
}) => {
  const s = await setup(page)
  await page.goto('/r/demo-cafe/menu')
  await expect(page.getByRole('heading', { level: 1, name: 'Menu' })).toBeVisible()
  await expect(page.getByRole('region', { name: /Hot Plates/ }).getByText('Shiro')).toBeVisible()
  await expect(page.getByText('ETB 85.50')).toBeVisible()

  await page.getByRole('button', { name: 'New item' }).click()
  const dialog = page.getByRole('dialog', { name: 'New menu item' })
  await dialog.getByLabel('Name').fill('Honey Cake')
  await dialog.getByLabel('Price (ETB)').fill('120.50')
  await dialog.getByLabel('Category').selectOption({ label: 'Sweet Things' })
  await dialog.getByLabel('Prepared at station').selectOption({ label: 'Line One' })
  await expect(dialog.getByRole('button', { name: 'Choose photo' })).toBeVisible()
  await dialog.locator('#menu-photo').setInputFiles({ name: 'cake.png', mimeType: 'image/png', buffer: PNG })
  await expect(dialog.getByRole('img', { name: 'Selected photo preview' })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Replace photo' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Create item' }).click()
  await expect(dialog).toBeHidden()

  expect(s.uploads).toHaveLength(1)
  expect(s.uploads[0]).toMatch(new RegExp(`^restaurants/${RID}/menu/[0-9a-f-]{36}\\.png$`))
  const create = s.rpc.find((c) => c.fn === 'fn_create_menu_item')!
  expect(create.body).toMatchObject({
    p_name: 'Honey Cake',
    p_price: 120.5,
    p_category_id: CAT_SWEET,
    p_station_id: ST,
    p_image_path: s.uploads[0],
  })
  expect(create.body).not.toHaveProperty('p_restaurant_id')

  const card = page.getByRole('article', { name: 'Honey Cake' })
  await expect(
    page.getByRole('region', { name: /Sweet Things/ }).getByRole('article', { name: 'Honey Cake' }),
  ).toBeVisible()
  await expect(card.locator('img')).toHaveAttribute(
    'src',
    /\/storage\/v1\/object\/sign\/menu-images\/restaurants\/.*token=signed/,
  )
  await expect(card.locator('img')).toHaveJSProperty('naturalWidth', 1)

  // edit: remove the photo sends image_path null
  await card.getByRole('button', { name: 'Edit Honey Cake' }).click()
  const edit = page.getByRole('dialog', { name: 'Edit menu item' })
  await edit.getByRole('button', { name: 'Remove photo' }).click()
  await edit.getByRole('button', { name: 'Save changes' }).click()
  await expect(edit).toBeHidden()
  expect(s.rpc.find((c) => c.fn === 'fn_update_menu_item')?.body).toMatchObject({
    p_patch: { image_path: null },
  })
  await expect(card.locator('img')).toHaveCount(0)

  // recipe
  await page.getByRole('button', { name: 'Recipe for Shiro' }).click()
  const recipe = page.getByRole('dialog', { name: 'Recipe: Shiro' })
  await recipe.getByRole('button', { name: 'Add ingredient' }).click()
  await recipe.getByLabel('Ingredient 1', { exact: true }).selectOption({ label: 'Flour (kg)' })
  await recipe.getByLabel('Quantity (kg)').fill('0.25')
  await expect(recipe.getByTestId('recipe-cost')).toHaveText(
    'Estimated ingredient cost per serving: ETB 10.00',
  )
  await recipe.getByRole('button', { name: 'Save recipe' }).click()
  await expect(recipe).toBeHidden()
  expect(s.rpc.find((c) => c.fn === 'fn_set_recipe')?.body).toEqual({
    p_menu_item_id: 'aaaaaaaa-0000-4000-8000-000000000001',
    p_lines: [{ ingredient_id: FLOUR, qty_per_serving: 0.25 }],
  })
})

test('inventory: low stock, receive with step-up (same key), adjust with reason, reverse, blocked deactivation', async ({
  page,
}) => {
  const s = await setup(page)
  s.recipes['aaaaaaaa-0000-4000-8000-000000000001'] = [{ ingredient_id: FLOUR, qty_per_serving: 0.25 }]
  await page.goto('/r/demo-cafe/inventory')
  await expect(page.getByRole('alert').filter({ hasText: 'low on stock' })).toContainText(
    'Flour: 1 kg (minimum 2 kg)',
  )

  // receive 10 kg butter = ETB 6,000 >= 5,000 threshold -> step-up prompt, then the SAME request again
  await page.getByRole('button', { name: 'Receive Butter' }).click()
  const recv = page.getByRole('dialog', { name: 'Receive Butter' })
  await recv.getByLabel('Quantity received (kg)').fill('10')
  await expect(recv.getByRole('note')).toContainText('authenticator')
  await recv.getByRole('button', { name: 'Receive stock' }).click()
  const stepUp = page.getByRole('dialog', { name: 'Verify it is you' })
  await stepUp.getByLabel('Authentication code').fill('123456')
  await stepUp.getByRole('button', { name: 'Verify' }).click()
  await expect.poll(() => s.rpc.filter((c) => c.fn === 'fn_receive_stock').length).toBe(2)
  await expect(stepUp).toBeHidden()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  const receives = s.rpc.filter((c) => c.fn === 'fn_receive_stock')
  expect(receives).toHaveLength(2)
  expect(receives[0]?.body.p_idempotency_key).toMatch(/^[0-9a-f-]{36}$/)
  expect(receives[1]?.body.p_idempotency_key).toBe(receives[0]?.body.p_idempotency_key)
  expect(receives[0]?.body).not.toHaveProperty('p_stock')
  await expect(page.getByRole('row', { name: /Butter/ }).getByTestId('ingredient-stock')).toHaveText('20 kg')

  // adjust needs a reason; going below zero is refused by the server
  await page.getByRole('button', { name: 'Adjust Flour' }).click()
  const adj = page.getByRole('dialog', { name: 'Adjust Flour' })
  await adj.getByLabel('Change (kg)').fill('-5')
  await adj.getByRole('button', { name: 'Adjust stock' }).click()
  await expect(adj.getByText('Enter a reason of at least 3 characters.')).toBeVisible()
  await adj.getByLabel('Reason (required)').fill('spoiled bag')
  await adj.getByRole('button', { name: 'Adjust stock' }).click()
  await expect(adj.getByText(/below zero/)).toBeVisible()
  await adj.getByLabel('Change (kg)').fill('-0.5')
  await adj.getByRole('button', { name: 'Adjust stock' }).click()
  await expect(adj).toBeHidden()
  await expect(page.getByRole('row', { name: /Flour/ }).getByTestId('ingredient-stock')).toHaveText('0.5 kg')

  // deactivation blocked by an active recipe: the dependency is explained
  await page.getByRole('button', { name: 'Deactivate Flour' }).click()
  const deact = page.getByRole('dialog', { name: 'Deactivate Flour?' })
  await deact.getByRole('button', { name: 'Deactivate' }).click()
  await expect(deact.getByRole('alert')).toContainText('recipe of an active menu item')
  await deact.getByRole('button', { name: 'Cancel' }).click()

  // movement log + reversal (compensating row, original untouched)
  await page.getByRole('tab', { name: 'Movement log' }).click()
  await expect(page.getByTestId('movement-row')).toHaveCount(2)
  await page.getByRole('button', { name: 'Reverse manual adjustment of Flour' }).click()
  const rev = page.getByRole('dialog', { name: 'Reverse movement' })
  await rev.getByLabel('Reason (required)').fill('counted wrong')
  await rev.getByRole('button', { name: 'Reverse movement' }).click()
  await expect(rev).toBeHidden()
  await expect(page.getByTestId('movement-row')).toHaveCount(3)
  await expect(page.getByTestId('movement-row').first()).toContainText('Reversal')
  await expect(page.getByTestId('movement-row').first()).toContainText('+0.5 kg')
  const reverse = s.rpc.find((c) => c.fn === 'fn_reverse_stock_movement')!
  expect(reverse.body).toMatchObject({
    p_reason: 'counted wrong',
    p_idempotency_key: expect.stringMatching(/^[0-9a-f-]{36}$/),
  })
})
