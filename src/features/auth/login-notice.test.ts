import { describe, expect, it } from 'vitest'
import { LOGIN_NOTICES, loginNoticeFromState } from './login-notice'

describe('loginNoticeFromState', () => {
  it('maps a known key to its fixed text', () => {
    expect(loginNoticeFromState({ notice: 'password_changed' })).toBe(LOGIN_NOTICES.password_changed)
  })
  it('ignores unknown keys, prototype keys and non-objects', () => {
    expect(loginNoticeFromState({ notice: '<b>hi</b>' })).toBeNull()
    expect(loginNoticeFromState({ notice: 'toString' })).toBeNull()
    expect(loginNoticeFromState({ notice: 1 })).toBeNull()
    expect(loginNoticeFromState(null)).toBeNull()
    expect(loginNoticeFromState('password_changed')).toBeNull()
  })
})
