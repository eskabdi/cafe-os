import { describe, expect, it } from 'vitest'
import {
  authenticatorNameSchema,
  formatSetupKey,
  qrImageSrc,
  totpCodeSchema,
  usesSupabaseAuthSignIn,
} from './authenticator'

describe('usesSupabaseAuthSignIn', () => {
  it('is false without a session', () => {
    expect(usesSupabaseAuthSignIn(null)).toBe(false)
  })
  it('is true for an email + password identity', () => {
    expect(usesSupabaseAuthSignIn({ user: { email: 'owner@example.com', app_metadata: {} } })).toBe(true)
  })
  it('is false for a PIN account (staff marker or synthetic email)', () => {
    expect(usesSupabaseAuthSignIn({ user: { email: 'a@b.com', app_metadata: { staff: true } } })).toBe(false)
    expect(
      usesSupabaseAuthSignIn({ user: { email: 'abebe@demo.staff.cafeos.invalid', app_metadata: {} } }),
    ).toBe(false)
    expect(usesSupabaseAuthSignIn({ user: { email: 'ABEBE@DEMO.STAFF.CAFEOS.INVALID' } })).toBe(false)
  })
})

describe('code and name schemas', () => {
  it('accepts exactly six ASCII digits', () => {
    expect(totpCodeSchema.safeParse('123456').success).toBe(true)
    for (const bad of ['12345', '1234567', '12345a', '١٢٣٤٥٦', ' 12345', '']) {
      expect(totpCodeSchema.safeParse(bad).success).toBe(false)
    }
  })
  it('trims names and rejects empty, long and control-character names', () => {
    expect(authenticatorNameSchema.parse('  Phone ')).toBe('Phone')
    expect(authenticatorNameSchema.safeParse('   ').success).toBe(false)
    expect(authenticatorNameSchema.safeParse('x'.repeat(41)).success).toBe(false)
    expect(authenticatorNameSchema.safeParse('a‮b').success).toBe(false)
    expect(authenticatorNameSchema.safeParse('a\nb').success).toBe(false)
  })
})

describe('qrImageSrc', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100%"><path d="M0 0h1v1z"/></svg>'
  it('wraps raw svg markup in an encoded data URL', () => {
    const src = qrImageSrc(svg)
    expect(src?.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true)
    expect(src).not.toContain('<')
    expect(decodeURIComponent(src!.split(',').slice(1).join(','))).toBe(svg)
  })
  it('accepts an already prefixed data URL (raw or encoded payload)', () => {
    expect(qrImageSrc(`data:image/svg+xml;utf-8,${svg}`)).toBe(qrImageSrc(svg))
    expect(qrImageSrc(`data:image/svg+xml;utf-8,${encodeURIComponent(svg)}`)).toBe(qrImageSrc(svg))
  })
  it('refuses anything that is not an svg document', () => {
    expect(qrImageSrc('javascript:alert(1)')).toBeNull()
    expect(qrImageSrc('data:text/html,<script>alert(1)</script>')).toBeNull()
    expect(qrImageSrc('https://evil.example/qr.svg')).toBeNull()
    expect(qrImageSrc('')).toBeNull()
    expect(qrImageSrc(undefined)).toBeNull()
    expect(qrImageSrc(`<svg>${'x'.repeat(21_000)}</svg>`)).toBeNull()
  })
})

describe('formatSetupKey', () => {
  it('groups in fours', () => {
    expect(formatSetupKey('ABCDEFGHIJ')).toBe('ABCD EFGH IJ')
  })
})
