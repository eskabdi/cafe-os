import { describe, expect, it } from 'vitest'
import { pinChangeStatusOf, validatePinChangeForm } from './pin-change'

describe('pinChangeStatusOf', () => {
  it('uses the server status, falls back to must_change_pin, defaults to none', () => {
    expect(pinChangeStatusOf(null)).toBe('none')
    expect(pinChangeStatusOf({})).toBe('none')
    expect(pinChangeStatusOf({ must_change_pin: true })).toBe('required')
    expect(pinChangeStatusOf({ pin_change_status: 'pending_approval', must_change_pin: false })).toBe(
      'pending_approval',
    )
    expect(pinChangeStatusOf({ pin_change_status: 'required' })).toBe('required')
    expect(pinChangeStatusOf({ pin_change_status: 'none' })).toBe('none')
  })
})

describe('validatePinChangeForm', () => {
  it('accepts a valid change of the fixed length', () => {
    expect(validatePinChangeForm({ current_pin: '4829', new_pin: '7391', confirm_pin: '7391' }, 4)).toBeNull()
    expect(
      validatePinChangeForm({ current_pin: '482910', new_pin: '739154', confirm_pin: '739154' }, 6),
    ).toBeNull()
  })

  it('reports length, same PIN and mismatch', () => {
    expect(validatePinChangeForm({ current_pin: '482', new_pin: '7391', confirm_pin: '7391' }, 4)).toBe(
      'length',
    )
    expect(validatePinChangeForm({ current_pin: '4829', new_pin: '7391', confirm_pin: '7391' }, 6)).toBe(
      'length',
    )
    expect(validatePinChangeForm({ current_pin: '48a9', new_pin: '7391', confirm_pin: '7391' }, 4)).toBe(
      'length',
    )
    expect(validatePinChangeForm({ current_pin: '4829', new_pin: '4829', confirm_pin: '4829' }, 4)).toBe(
      'same_pin',
    )
    expect(validatePinChangeForm({ current_pin: '4829', new_pin: '7391', confirm_pin: '7392' }, 4)).toBe(
      'mismatch',
    )
  })
})
