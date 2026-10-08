import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearKioskToken, getKioskToken, setKioskToken } from './kiosk-token'

const TOKEN = 'ab'.repeat(32)

afterEach(() => {
  vi.restoreAllMocks()
  clearKioskToken('acme')
  clearKioskToken('other-cafe')
})

describe('kiosk token storage', () => {
  it('round-trips a valid token per slug', () => {
    expect(setKioskToken('acme', TOKEN)).toBe(true)
    expect(getKioskToken('acme')).toBe(TOKEN)
    expect(getKioskToken('other-cafe')).toBeNull()
    clearKioskToken('acme')
    expect(getKioskToken('acme')).toBeNull()
  })

  it('refuses malformed tokens and invalid or reserved slugs', () => {
    expect(setKioskToken('acme', 'short')).toBe(false)
    expect(setKioskToken('www', TOKEN)).toBe(false)
    expect(setKioskToken('A B', TOKEN)).toBe(false)
    expect(getKioskToken('www')).toBeNull()
  })

  it('ignores a corrupted stored value', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockReturnValue('not-a-token')
    expect(getKioskToken('acme')).toBeNull()
  })

  it('never throws when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(getKioskToken('acme')).toBeNull()
    expect(setKioskToken('acme', TOKEN)).toBe(false)
    expect(() => clearKioskToken('acme')).not.toThrow()
  })
})
