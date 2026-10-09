import { roleInUseCount } from '@/lib/domain/portal'
import { errorCode } from './menu-inventory-errors'

// Fixed, safe copy for every error code of the Phase 3B portal RPCs (migrations 0030 / 0031) and Edge Functions
// (tenant-admin-invite, staff-create, staff-pin-reset). Only a machine code and a bare-identifier detail (or a counted
// detail like `active_users:3`) ever reach this file (RpcError drops anything else); nothing the server says is echoed.

const FIELD_TEXT: Readonly<Record<string, string>> = {
  name: 'Enter a name (at most 120 characters).',
  slug: 'Use 3 to 40 lowercase letters, digits or single hyphens.',
  trial_days: 'Trial days must be a whole number from 0 to 90.',
  reason: 'Enter a reason of 3 to 500 characters.',
  status: 'Choose a valid status.',
  search: 'The search text can be at most 100 characters.',
  limit: 'The page size is out of range.',
  offset: 'The page is out of range.',
  confirm_slug: 'Type the tenant’s slug exactly to confirm.',
  restaurant_id: 'Choose a tenant.',
  price_etb_monthly: 'Enter a monthly price from 0 to 10,000,000 ETB with at most 2 decimals.',
  description: 'The description is too long.',
  max_staff: 'Staff limit must be a positive whole number or empty (unlimited).',
  max_menu_items: 'Menu item limit must be a positive whole number or empty (unlimited).',
  max_stations: 'Station limit must be a positive whole number or empty (unlimited).',
  max_kiosks: 'Terminal limit must be a positive whole number or empty (unlimited).',
  max_orders_per_month: 'Monthly order limit must be a positive whole number or empty (unlimited).',
  max_storage_bytes: 'Storage limit must be a positive size up to 1 TiB or empty (unlimited).',
  features: 'Features must be simple keys (a-z, 0-9, _) with yes/no, number or short text values.',
  sort_order: 'The sort order must be a whole number.',
  patch: 'Some values are not allowed. Check the form and try again.',
  amount: 'Enter an amount from 0 to 10,000,000 ETB with at most 2 decimals.',
  period: 'The billing period is not valid (end on or after start, at most 400 days).',
  reference: 'The reference can be at most 120 characters.',
  method: 'Choose the payment channel for a paid invoice.',
  before: 'Paging position is invalid. Reload the list.',
  action_prefix: 'The action filter may contain only a-z, dot and underscore.',
  active: 'Choose active or inactive.',
  email: 'Enter a valid e-mail address.',
  first_name: 'Enter a first name of 1 to 60 characters.',
  middle_name: 'The middle name can be at most 60 characters.',
  last_name: 'The last name can be at most 60 characters.',
  username: 'Use 2 to 32 lowercase letters, digits, dot, underscore or hyphen, starting with a letter or digit.',
  color: 'Use a colour in the form #rrggbb.',
  icon: 'Choose an icon from the list.',
  role_id: 'Choose a role.',
  profile_id: 'Choose a user.',
  station_ids: 'Too many stations selected.',
  phone: 'Enter a phone number of digits, spaces, brackets or hyphens (optional leading +).',
  address: 'The address can be at most 300 characters.',
  timezone: 'Choose a valid time zone.',
  tin: 'The TIN may contain only letters, digits, / and - (at most 40).',
  vat_rate: 'VAT must be from 0 to 100 with at most 2 decimals.',
  opening_float: 'The opening float must be 0 or more with at most 2 decimals.',
  auto_consume_stock: 'Choose yes or no.',
  primary_color: 'Use a primary colour in the form #rrggbb.',
  accent_color: 'Use an accent colour in the form #rrggbb.',
  logo_path: 'The logo could not be attached. Upload it again.',
}

const STATE_TEXT: Readonly<Record<string, string>> = {
  cancelled: 'This tenant is cancelled. Cancellation is final; nothing can change it any more.',
  suspended: 'This tenant is suspended. Reactivate it first.',
  past_due: 'This tenant is past due.',
  trialing: 'This tenant is in its trial.',
  active: 'This tenant is active.',
  invoice_exists: 'A live invoice for this tenant and period already exists. Void it first or choose another period.',
  self: 'You cannot deactivate your own account.',
  already_attached: 'This invitation is already linked to an account.',
  already_confirmed: 'The invitee already confirmed the e-mail. Ask them to sign in and accept the invitation.',
  accepted: 'This invitation was already accepted.',
  revoked: 'This invitation was revoked.',
  pending: 'This invitation is still pending.',
  paid: 'This invoice is paid; paid invoices are final.',
  void: 'This invoice is void; void invoices are final.',
  overdue: 'This invoice is already overdue.',
  inactive: 'This account is inactive. Reactivate it first.',
  expired: 'This invitation has expired. Send a new one.',
  retention_expired:
    'This tenant was cancelled more than 1 year ago. Its data is past the retention period and may already be purged, so it cannot be restored.',
}

/** Display names of the quota metrics (fn_tenant_usage / over_quota metric names). */
export const METRIC_TEXT: Readonly<Record<string, string>> = {
  staff: 'staff',
  menu_items: 'menu items',
  stations: 'stations',
  kiosks: 'terminals',
  storage: 'file storage',
  orders: 'orders per month',
}

export function limitMetrics(detail: string | undefined): string[] {
  return (detail ?? '')
    .split(',')
    .filter((m) => Object.prototype.hasOwnProperty.call(METRIC_TEXT, m))
    .map((m) => METRIC_TEXT[m] ?? m)
}

function planLimitMessage(detail: string | undefined): string {
  const metrics = limitMetrics(detail)
  if (metrics.length === 0) return 'The plan’s limit is reached.'
  return `The plan’s limit is reached for: ${metrics.join(', ')}. Nothing was changed.`
}

/** Plan change copy: a downgrade below current usage is refused (owner decision 2026-10-08) and names the exceeded limits. */
export function planChangeErrorMessage(err: unknown): string {
  const { code, detail } = errorCode(err)
  if (code === 'plan_limit_reached') {
    const metrics = limitMetrics(detail)
    return metrics.length > 0
      ? `The chosen plan is below the tenant’s current usage for: ${metrics.join(', ')}. Nothing was changed; the tenant must reduce usage first, or pick a larger plan.`
      : 'The chosen plan is below the tenant’s current usage. Nothing was changed.'
  }
  return portalErrorMessage(err)
}

function roleInUseMessage(detail: string | undefined): string {
  const c = roleInUseCount(detail)
  if (c?.kind === 'active_users') {
    return `This role cannot be deactivated: ${c.count === 1 ? '1 active user holds' : `${c.count} active users hold`} it. Move ${c.count === 1 ? 'that user' : 'those users'} to another role first.`
  }
  if (c?.kind === 'users') {
    return `This role cannot be deleted: ${c.count === 1 ? '1 user has' : `${c.count} users have`} held it, and their history keeps the link. Deactivate it instead.`
  }
  return 'This role is still in use. Move its users to another role first, or deactivate it instead of deleting.'
}

/** Safe, fixed copy for a failed portal action (both portals). */
export function portalErrorMessage(err: unknown): string {
  const { code, detail } = errorCode(err)
  switch (code) {
    case 'not_authenticated':
    case 'unauthorized':
      return 'Your session has ended. Sign in again.'
    case 'permission_denied':
    case 'forbidden':
      return 'You do not have permission to do this.'
    case 'mfa_required':
      return 'This action needs verification with your authenticator app.'
    case 'step_up_cancelled':
      return 'Verification was cancelled, so nothing was changed.'
    case 'tenant_suspended':
      return 'This restaurant account is suspended or cancelled, so it cannot change right now.'
    case 'tenant_read_only':
      return 'This restaurant account is read-only (billing past due). Changes are paused until billing is settled.'
    case 'not_found':
      return 'This record no longer exists or is not available. Refresh and try again.'
    case 'invalid_slug':
      return 'That slug is not allowed. Use 3 to 40 lowercase letters, digits or single hyphens (some words are reserved).'
    case 'slug_taken':
      return 'That slug is already used by another tenant. Choose another.'
    case 'invalid_plan':
      return 'Choose an active plan.'
    case 'invalid_timezone':
      return 'Choose a valid time zone.'
    case 'duplicate_name':
      return 'That name is already used. Choose another name.'
    case 'role_in_use':
      return roleInUseMessage(detail)
    case 'system_role_protected':
      return 'The Tenant Admin role is a system role. It cannot be renamed, changed, deactivated or deleted.'
    case 'permission_escalation':
      return 'You cannot grant or manage rights you do not hold yourself.'
    case 'invalid_permission':
      return 'A permission is no longer in the catalogue. Reload the page and try again.'
    case 'invalid_station':
      return 'A station is no longer available. Reload the page and try again.'
    case 'last_tenant_admin':
      return 'This is the last active Tenant Admin. Invite or assign another Tenant Admin first.'
    case 'last_platform_super_admin':
      return 'This is the last active Super Admin. Another Super Admin must exist first.'
    case 'invalid_role':
      return 'Choose an active role. Inactive roles cannot be assigned.'
    case 'admin_requires_email_identity':
      return 'A PIN staff account cannot become a Tenant Admin. Invite the person as a Tenant Admin by e-mail instead.'
    case 'staff_limit_reached':
      return 'The plan’s staff limit is reached (active users plus pending invitations). Deactivate someone or upgrade the plan.'
    case 'plan_limit_reached':
      return planLimitMessage(detail)
    case 'email_in_use':
      return 'That e-mail already has an account or a pending invitation. Use another address.'
    case 'username_taken':
      return 'That username is already used in this restaurant. Choose another.'
    case 'invite_rate_limited':
      return 'The invitation was sent very recently or too often. Wait a minute and try again (at most 5 sends).'
    case 'try_later':
    case 'rate_limited':
      return 'Too many requests. Wait a moment and try again.'
    case 'invitation_expired':
      return 'This invitation has expired. Ask your administrator to send a new one.'
    case 'owner_email_unconfirmed':
      return 'The e-mail address is not confirmed yet. Open the link in the invitation e-mail first.'
    case 'owner_email_mismatch':
      return 'You are signed in with a different e-mail address than the one invited.'
    case 'owner_already_assigned':
      return 'This account already belongs to a restaurant or to the platform, so it cannot accept this invitation.'
    case 'invalid_auth_user':
      return 'The invitation could not be linked to an account. Revoke it and invite again.'
    case 'pin_not_allowed':
      return 'This account cannot have a PIN (Tenant Admins sign in with e-mail and password), or it is inactive.'
    case 'weak_pin':
      return 'That PIN is too easy to guess (repeated or sequential digits). Choose another.'
    case 'invalid_pin_length':
      return 'The PIN has the wrong number of digits for this role.'
    case 'invalid_request':
      return 'Some values are not allowed. Check the form and try again.'
    case 'logo_invalid':
      return 'Choose a PNG, JPEG or WebP image of at most 1 MiB.'
    case 'logo_upload_failed':
      return 'The logo could not be uploaded. Try again.'
    case 'network':
      return 'The server could not be reached. Check the connection and try again.'
    case 'invalid_state':
      return (detail && Object.prototype.hasOwnProperty.call(STATE_TEXT, detail) && STATE_TEXT[detail]) ||
        'This change is not possible in the current state. Refresh and try again.'
    case 'invalid_input':
      return (detail && Object.prototype.hasOwnProperty.call(FIELD_TEXT, detail) && FIELD_TEXT[detail]) ||
        'Some values are not allowed. Check the form and try again.'
    default:
      return 'Something went wrong. Please try again.'
  }
}
