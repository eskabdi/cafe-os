import { describe, expect, it, vi } from 'vitest'

vi.mock('./client', () => ({ supabase: {} }))

const { RpcError } = await import('./rpc')
const { ClientActionError, createIngredientErrorMessage, errorField, isStepUpRequired, menuInventoryErrorMessage } =
  await import('./menu-inventory-errors')

const GENERIC = 'Something went wrong. Please try again.'

describe('createIngredientErrorMessage', () => {
  it('adds a retry hint to duplicate_name and otherwise matches the shared copy', () => {
    expect(createIngredientErrorMessage(new RpcError('duplicate_name'))).toMatch(
      /already used.*If you just retried, check the ingredient list first/,
    )
    expect(menuInventoryErrorMessage(new RpcError('duplicate_name'))).not.toMatch(/retried/)
    expect(createIngredientErrorMessage(new RpcError('day_closed'))).toBe(
      menuInventoryErrorMessage(new RpcError('day_closed')),
    )
  })
})

describe('menuInventoryErrorMessage', () => {
  it.each([
    ['permission_denied', undefined, /do not have permission/],
    ['day_closed', undefined, /business day is closed/],
    ['insufficient_stock', undefined, /below zero/],
    ['mfa_required', undefined, /authenticator app/],
    ['plan_limit_reached', 'menu_items', /limit of active menu items/],
    ['duplicate_name', 'name', /already used/],
    ['invalid_station', undefined, /active station/],
    ['not_found', undefined, /no longer exists/],
    ['idempotency_conflict', undefined, /already submitted/],
    ['tenant_read_only', undefined, /cannot make changes/],
    ['tenant_suspended', undefined, /cannot make changes/],
    ['invalid_state', 'unit_locked', /unit cannot change/],
    ['invalid_state', 'ingredient_in_active_recipe', /recipe of an active menu item/],
    ['invalid_state', 'ingredient_inactive', /ingredient in this recipe is inactive/],
    ['invalid_state', 'already_reversed', /already been reversed/],
    ['invalid_state', 'not_reversible', /cannot be reversed/],
    ['invalid_input', 'reason', /reason of 3 to 300/],
    ['invalid_input', 'price', /at most 2 decimals/],
    ['invalid_input', 'qty_per_serving', /recipe quantity/],
  ])('%s / %s', (code, detail, expected) => {
    expect(menuInventoryErrorMessage(new RpcError(code, detail))).toMatch(expected)
  })

  it('falls back to safe generic copy for unknown codes, unknown details and non-RPC errors', () => {
    expect(menuInventoryErrorMessage(new RpcError('rpc_failed'))).toBe(GENERIC)
    expect(menuInventoryErrorMessage(new RpcError('invalid_state', 'something_new'))).toMatch(/not possible in the current state/)
    expect(menuInventoryErrorMessage(new RpcError('invalid_input', 'constructor'))).toMatch(/Check the form/)
    expect(menuInventoryErrorMessage(new TypeError('Failed to fetch'))).toBe(GENERIC)
    expect(menuInventoryErrorMessage('boom')).toBe(GENERIC)
  })

  it('maps client-side codes', () => {
    expect(menuInventoryErrorMessage(new ClientActionError('step_up_cancelled'))).toMatch(/nothing was changed/)
    expect(menuInventoryErrorMessage(new ClientActionError('image_invalid'))).toMatch(/PNG, JPEG or WebP/)
    expect(menuInventoryErrorMessage(new ClientActionError('image_upload_failed'))).toMatch(/could not be uploaded/)
  })

  it('never echoes server text', () => {
    const msg = menuInventoryErrorMessage(new RpcError('invalid_input', 'name'))
    expect(msg).not.toContain('invalid_input')
  })
})

describe('helpers', () => {
  it('detects step-up and known invalid_input fields', () => {
    expect(isStepUpRequired(new RpcError('mfa_required'))).toBe(true)
    expect(isStepUpRequired(new RpcError('permission_denied'))).toBe(false)
    expect(errorField(new RpcError('invalid_input', 'qty'))).toBe('qty')
    expect(errorField(new RpcError('invalid_input', 'patch'))).toBeUndefined()
    expect(errorField(new RpcError('invalid_state', 'qty'))).toBeUndefined()
  })
})
