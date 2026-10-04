import { z } from 'zod'

// Client-side shape checks for the Change PIN form (UX only). The pin-change Edge Function re-validates everything, including
// the weak-PIN policy and the role's length, which are deliberately not mirrored here.

export type PinChangeStatus = 'none' | 'required' | 'pending_approval'

/**
 * The account's PIN-change state as fn_get_session_context reported it (UX only; the database restricts the account).
 * Missing fields (platform-only identity, older server) mean 'none'; must_change_pin alone still means 'required'.
 */
export function pinChangeStatusOf(
  ctx: { pin_change_status?: PinChangeStatus; must_change_pin?: boolean } | null | undefined,
): PinChangeStatus {
  if (!ctx) return 'none'
  if (ctx.pin_change_status) return ctx.pin_change_status
  return ctx.must_change_pin ? 'required' : 'none'
}

export type PinChangeFormIssue = 'length' | 'same_pin' | 'mismatch'

export function pinChangeFormSchema(pinLength: number) {
  const pin = z.string().regex(new RegExp(`^[0-9]{${pinLength}}$`), 'length')
  return z
    .object({ current_pin: pin, new_pin: pin, confirm_pin: pin })
    .refine((v) => v.new_pin !== v.current_pin, { message: 'same_pin', path: ['new_pin'] })
    .refine((v) => v.confirm_pin === v.new_pin, { message: 'mismatch', path: ['confirm_pin'] })
}

export type PinChangeForm = z.infer<ReturnType<typeof pinChangeFormSchema>>

/** First issue of the form, or null when it may be sent. Never echoes a PIN. */
export function validatePinChangeForm(form: PinChangeForm, pinLength: number): PinChangeFormIssue | null {
  const parsed = pinChangeFormSchema(pinLength).safeParse(form)
  if (parsed.success) return null
  const message = parsed.error.issues[0]?.message
  return message === 'same_pin' || message === 'mismatch' ? message : 'length'
}
