import { errorCode } from '@/lib/supabase/menu-inventory-errors'

/** Safe fixed copy for a refused order command (fn_submit_order / fn_cancel_order / fn_serve_order). */
export function orderErrorMessage(err: unknown): string {
  const { code, detail } = errorCode(err)
  switch (code) {
    case 'day_closed':
      return 'There is no open business day. Ask a manager to open the day, then send the order again.'
    case 'insufficient_stock':
      return 'Not enough stock for one of the items. Remove it or ask the kitchen; nothing was ordered.'
    case 'item_unavailable':
      return 'An item is no longer available. Refresh the menu and remove it from the order.'
    case 'idempotency_conflict':
      return 'An earlier send of this order may already have gone through. Check today’s orders before sending again.'
    case 'invalid_state':
      return detail === 'table_unavailable'
        ? 'That table is not available. Choose another table.'
        : 'The order is being processed. Wait a moment and try again.'
    case 'order_not_cancellable':
      return detail === 'payment_recorded'
        ? 'This order has a payment and cannot be cancelled here.'
        : 'Preparation has started, so the order cannot be cancelled here.'
    case 'invalid_state_transition':
      return 'This order cannot change that way any more. Refresh and try again.'
    case 'invalid_input':
      return detail === 'qty'
        ? 'Quantities are whole numbers from 1 to 99.'
        : detail === 'note'
          ? 'A line note is too long (at most 200 characters).'
          : detail === 'customer_note'
            ? 'The order note is too long (at most 300 characters).'
            : detail === 'items'
              ? 'Add between 1 and 50 lines to the order.'
              : 'Some values are not allowed. Check the order and try again.'
    case 'permission_denied':
      return 'You do not have permission to do this.'
    case 'tenant_suspended':
    case 'tenant_read_only':
      return 'This restaurant account cannot take orders right now.'
    case 'not_found':
      return 'This order no longer exists. Refresh the list.'
    case 'network':
    case 'rpc_failed':
      return 'The server could not be reached. The order was NOT confirmed; send it again (it will not be duplicated).'
    default:
      return 'Something went wrong. Send the order again; it will not be duplicated.'
  }
}
