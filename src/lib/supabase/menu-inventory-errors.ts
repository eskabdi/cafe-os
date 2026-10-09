import { RpcError } from './rpc'

// Maps the structured P0001 errors of the Phase-3 RPCs (migration 0029, rpc-conventions.md) to fixed, safe user copy.
// Only the machine code and a bare-identifier detail ever reach this file (RpcError drops anything else), so no SQL text,
// foreign ids or server strings can be rendered. Copy is chosen by code/detail, never by echoing server text.

/** Codes raised on the client side of a flow (Storage upload, step-up cancel), mapped like server codes. */
export type ClientErrorCode = 'image_upload_failed' | 'image_invalid' | 'step_up_cancelled'

export class ClientActionError extends Error {
  readonly code: ClientErrorCode
  constructor(code: ClientErrorCode) {
    super(code)
    this.name = 'ClientActionError'
    this.code = code
  }
}

const FIELD_TEXT: Readonly<Record<string, string>> = {
  name: 'Enter a name of 1 to 120 characters.',
  price: 'Enter a price of 0 or more with at most 2 decimals.',
  description: 'The description can be at most 500 characters.',
  emoji: 'The emoji can be at most 16 characters.',
  sort_order: 'The sort order must be a whole number.',
  category_id: 'Choose an active category.',
  image_path: 'The image could not be attached. Upload it again.',
  lines: 'The recipe is not valid (at most 50 lines).',
  qty_per_serving: 'Each recipe quantity must be above 0 with at most 3 decimals.',
  duplicate_ingredient: 'Each ingredient can appear only once in a recipe.',
  ingredient_id: 'An ingredient is no longer available. Refresh and choose again.',
  unit: 'Choose a unit.',
  min_level: 'The minimum level must be 0 or more with at most 3 decimals.',
  cost_per_unit: 'The cost must be 0 or more with at most 2 decimals.',
  initial_stock: 'The initial stock must be 0 or more with at most 3 decimals.',
  qty: 'Enter a quantity above 0 with at most 3 decimals (and within the stock limit).',
  qty_delta: 'Enter a non-zero change with at most 3 decimals.',
  reason: 'Enter a reason of 3 to 300 characters.',
  note: 'The note can be at most 300 characters.',
  stock_stepup_threshold: 'The threshold must be between ETB 100 and ETB 1,000,000 with at most 2 decimals.',
  movement_id: 'Choose a movement to reverse.',
}

const STATE_TEXT: Readonly<Record<string, string>> = {
  unit_locked:
    'The unit cannot change: this ingredient already has stock movements or is used in a recipe. Create a new ingredient instead.',
  ingredient_inactive:
    'An ingredient in this recipe is inactive. Reactivate it or remove it from the recipe first.',
  ingredient_in_active_recipe:
    'This ingredient is used in the recipe of an active menu item. Remove it from those recipes or deactivate those items first.',
  already_reversed: 'This movement has already been reversed.',
  not_reversible: 'Consumption and reversal rows cannot be reversed here.',
  unique_conflict: 'This change conflicts with an existing record. Refresh and try again.',
}

/** Code and detail of any thrown value (RpcError, ClientActionError), else undefined. */
export function errorCode(err: unknown): { code?: string; detail?: string } {
  if (err instanceof RpcError) return { code: err.code, detail: err.detail }
  if (err instanceof ClientActionError) return { code: err.code }
  return {}
}

export function isStepUpRequired(err: unknown): boolean {
  const code = errorCode(err).code
  return code === 'mfa_required' || code === 'step_up_required'
}

/** The form field an invalid_input refers to (detail), if it is a known field. */
export function errorField(err: unknown): string | undefined {
  const { code, detail } = errorCode(err)
  if (code !== 'invalid_input' || !detail) return undefined
  return Object.prototype.hasOwnProperty.call(FIELD_TEXT, detail) ? detail : undefined
}

/** Safe, fixed copy for a failed menu / inventory action. */
export function menuInventoryErrorMessage(err: unknown): string {
  const { code, detail } = errorCode(err)
  switch (code) {
    case 'not_authenticated':
      return 'Your session has ended. Sign in again.'
    case 'permission_denied':
      return 'You do not have permission to do this. Ask your administrator if you need access.'
    case 'tenant_suspended':
    case 'tenant_read_only':
      return 'This restaurant account cannot make changes right now.'
    case 'mfa_required':
      return 'This action needs verification with your authenticator app.'
    case 'step_up_cancelled':
      return 'Verification was cancelled, so nothing was changed.'
    case 'day_closed':
      return 'The business day is closed. Stock can only change while a day is open.'
    case 'insufficient_stock':
      return 'Not enough stock: this would take the quantity on hand below zero.'
    case 'plan_limit_reached':
      return detail === 'menu_items'
        ? 'Your plan’s limit of active menu items is reached. Deactivate an item or upgrade the plan.'
        : 'Your plan’s limit is reached.'
    case 'duplicate_name':
      return 'That name is already used. Choose another name.'
    case 'invalid_station':
      return 'Choose an active station.'
    case 'not_found':
      return 'This record no longer exists or is not available. Refresh and try again.'
    case 'idempotency_conflict':
      return 'This request was already submitted with different values. Close this form and check the movement log.'
    case 'invalid_state':
      return (detail && Object.prototype.hasOwnProperty.call(STATE_TEXT, detail) && STATE_TEXT[detail]) ||
        'This change is not possible in the current state. Refresh and try again.'
    case 'invalid_input':
      return (detail && Object.prototype.hasOwnProperty.call(FIELD_TEXT, detail) && FIELD_TEXT[detail]) ||
        'Some values are not allowed. Check the form and try again.'
    case 'image_invalid':
      return 'Choose a PNG, JPEG or WebP image of at most 2 MB.'
    case 'image_upload_failed':
      return 'The image could not be uploaded. Try again or save without an image.'
    default:
      return 'Something went wrong. Please try again.'
  }
}

/**
 * Copy for a failed ingredient CREATE. fn_create_ingredient has no idempotency key, so a retry after a lost response can hit
 * duplicate_name for the row the first attempt already created: point the user at the list before they pick a new name.
 */
export function createIngredientErrorMessage(err: unknown): string {
  return errorCode(err).code === 'duplicate_name'
    ? 'That name is already used. If you just retried, check the ingredient list first: it may already have been created.'
    : menuInventoryErrorMessage(err)
}
