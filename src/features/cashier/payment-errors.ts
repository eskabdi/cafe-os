import { errorCode } from '@/lib/supabase/menu-inventory-errors'

/** Safe fixed copy for a refused payment command (fn_confirm_payment / fn_reverse_payment / fn_get_receipt). */
export function paymentErrorMessage(err: unknown): string {
  const { code, detail } = errorCode(err)
  switch (code) {
    case 'day_closed':
      return detail === 'payment business day is closed'
        ? 'This payment belongs to a closed business day and can no longer be reversed here.'
        : detail === 'order business day is closed'
          ? 'This order belongs to a closed business day and can no longer be paid here.'
          : 'There is no open business day. Ask a manager to open the day, then take the payment.'
    case 'order_not_payable':
      return detail === 'paid'
        ? 'This order is already paid. Refresh the list.'
        : detail === 'cancelled'
          ? 'This order was cancelled; there is nothing to pay.'
          : detail === 'installment'
            ? 'This order is on an installment voucher. Collect it from Installments.'
            : 'This order has nothing to pay.'
    case 'insufficient_tendered':
      return 'The amount received is less than the total.'
    case 'idempotency_conflict':
      return 'An earlier attempt for this payment may already have gone through. Check the payment history before trying again.'
    case 'invalid_input':
      return detail === 'reference'
        ? 'This payment method needs a reference (at most 120 characters).'
        : detail === 'tendered'
          ? 'The amount received is not valid for this payment method.'
          : detail === 'payment_method_id'
            ? 'This payment method is no longer available. Choose another one.'
            : detail === 'reason'
              ? 'Give a reason of 3 to 300 characters.'
              : 'Some values are not allowed. Check and try again.'
    case 'invalid_state':
      return detail === 'already_reversed'
        ? 'This payment has already been reversed.'
        : detail === 'not_an_order_payment'
          ? 'Only an order payment can be reversed here.'
          : detail === 'order_not_paid'
            ? 'This order is not marked as paid, so the payment cannot be reversed here.'
            : 'The payment is being processed. Wait a moment and try again.'
    case 'permission_denied':
      return 'You do not have permission to do this.'
    case 'mfa_required':
    case 'step_up_required':
      return 'This action needs verification with your authenticator app.'
    case 'step_up_cancelled':
      return 'Verification was cancelled, so nothing was changed.'
    case 'tenant_suspended':
    case 'tenant_read_only':
      return 'This restaurant account cannot take payments right now.'
    case 'not_found':
      return 'This order or payment no longer exists. Refresh the list.'
    case 'not_authenticated':
      return 'Your session has ended. Sign in again.'
    case 'network':
    case 'rpc_failed':
      return 'We could not confirm whether this went through. Press Try again: it will not be recorded twice.'
    default:
      return 'We could not confirm whether this went through. Press Try again: it will not be recorded twice.'
  }
}

/** Answers that prove nothing was recorded. Anything else is ambiguous: the same key must be resent before anything changes. */
export const DEFINITIVE_PAYMENT_ERRORS = new Set([
  'day_closed',
  'order_not_payable',
  'insufficient_tendered',
  'idempotency_conflict',
  'invalid_input',
  'invalid_state',
  'permission_denied',
  'tenant_suspended',
  'tenant_read_only',
  'not_found',
  'not_authenticated',
  'mfa_required',
  'step_up_required',
  'step_up_cancelled',
])
