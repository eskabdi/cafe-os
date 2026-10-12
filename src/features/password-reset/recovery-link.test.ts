import { afterEach, describe, expect, it } from 'vitest'
import { parseRecoveryLink, takeRecoveryLink } from './recovery-link'

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1LTEifQ.c2ln'
const ok = `#access_token=${JWT}&expires_in=3600&refresh_token=abc123_-&token_type=bearer&type=recovery`

describe('parseRecoveryLink', () => {
  it('accepts a well-formed recovery fragment', () => {
    expect(parseRecoveryLink(ok, '')).toEqual({ kind: 'session', accessToken: JWT, refreshToken: 'abc123_-' })
  })

  it('accepts only the recovery link type', () => {
    for (const type of ['signup', 'invite', 'magiclink', 'email_change', '']) {
      expect(parseRecoveryLink(ok.replace('type=recovery', `type=${type}`), '').kind).toBe('invalid')
    }
    expect(parseRecoveryLink(ok.replace('&type=recovery', ''), '').kind).toBe('invalid')
  })

  it('refuses malformed or missing tokens', () => {
    expect(parseRecoveryLink(ok.replace(JWT, 'not-a-jwt'), '').kind).toBe('invalid')
    expect(parseRecoveryLink(ok.replace('abc123_-', '<script>'), '').kind).toBe('invalid')
    expect(parseRecoveryLink('#type=recovery', '').kind).toBe('invalid')
    expect(parseRecoveryLink(ok.replace(JWT, `${'a'.repeat(9000)}.b.c`), '').kind).toBe('invalid')
  })

  it('reports expired / used links (error in the fragment or the query)', () => {
    expect(parseRecoveryLink('#error=access_denied&error_code=otp_expired&error_description=x', '').kind).toBe('expired')
    expect(parseRecoveryLink('', '?error=access_denied&error_code=otp_expired').kind).toBe('expired')
  })

  it('reports no link when the URL carries nothing', () => {
    expect(parseRecoveryLink('', '').kind).toBe('none')
    expect(parseRecoveryLink('#', '?foo=bar').kind).toBe('none')
  })
})

describe('takeRecoveryLink', () => {
  afterEach(() => window.history.replaceState(null, '', '/'))

  it('removes the tokens from the address bar', () => {
    window.history.replaceState(null, '', `/reset-password${ok}`)
    expect(takeRecoveryLink().kind).toBe('session')
    expect(window.location.hash).toBe('')
    expect(window.location.pathname).toBe('/reset-password')
  })
})
