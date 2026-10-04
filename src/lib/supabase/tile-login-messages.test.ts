import { describe, expect, it } from 'vitest'
import { PIN_LOGIN_MESSAGES } from './pin-login-errors'
import { TILE_LOGIN_MESSAGES } from './tile-login-messages'

describe('TILE_LOGIN_MESSAGES', () => {
  it('has no username wording, role or PIN-length hints and never reuses the username copy', () => {
    for (const [reason, text] of Object.entries(TILE_LOGIN_MESSAGES)) {
      expect(text).not.toMatch(/username|cashier|[0-9]-digit|digits|locked|lockout/i)
      void reason
    }
    expect(TILE_LOGIN_MESSAGES.invalid_credentials).not.toBe(PIN_LOGIN_MESSAGES.invalid_credentials)
    expect(TILE_LOGIN_MESSAGES.invalid_request).not.toBe(PIN_LOGIN_MESSAGES.invalid_request)
  })

  it('keeps one generic message for invalid credentials', () => {
    expect(TILE_LOGIN_MESSAGES.invalid_credentials).not.toMatch(/wrong|incorrect|unknown|no such|inactive/i)
  })
})
