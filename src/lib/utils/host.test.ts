import { describe, expect, it } from 'vitest'
import * as shared from '../../../supabase/functions/_shared/host'
import { RESERVED_SUBDOMAINS, isValidSlug, parseHost, tenantSlugFromHost } from './host'

describe('tenantSlugFromHost (SPA mirror)', () => {
  it('resolves a tenant subdomain, with or without port', () => {
    expect(tenantSlugFromHost('central-cafe.cafeos.et')).toBe('central-cafe')
    expect(tenantSlugFromHost('acme.localhost:5173')).toBe('acme')
    expect(tenantSlugFromHost('ACME.Localhost:5173')).toBe('acme')
  })

  it.each([
    'cafeos.et',
    'localhost:5173',
    'platform.cafeos.et',
    'www.cafeos.et',
    'a.b.cafeos.et',
    'x.cafeos.et.evil.com',
    '127.0.0.1:5173',
    'a--b.cafeos.et',
    'ab.cafeos.et',
    '',
  ])('returns null for %s', (host) => {
    expect(tenantSlugFromHost(host)).toBeNull()
  })

  it('returns null for missing input', () => {
    expect(tenantSlugFromHost(null)).toBeNull()
    expect(tenantSlugFromHost(undefined)).toBeNull()
  })

  it('refuses every reserved subdomain', () => {
    for (const label of RESERVED_SUBDOMAINS) {
      expect(tenantSlugFromHost(`${label}.cafeos.et`)).toBeNull()
      expect(isValidSlug(label)).toBe(false)
    }
  })
})

describe('parity with the Edge Function implementation', () => {
  it('has the same reserved list', () => {
    expect([...RESERVED_SUBDOMAINS]).toEqual([...shared.RESERVED_SUBDOMAINS])
  })

  it('classifies a corpus of hosts identically', () => {
    const corpus = [
      'acme.cafeos.et',
      'acme.localhost:5173',
      'cafeos.et',
      'localhost',
      'platform.cafeos.et',
      'status.cafeos.et',
      'a.b.cafeos.et',
      'x.cafeos.et.evil.com',
      '10.0.0.1',
      '[::1]:5173',
      'https://acme.cafeos.et',
      'acme.cafeos.et.',
      '-a.cafeos.et',
      'a--b.cafeos.et',
      'UPPER.cafeos.et',
      'example.com',
    ]
    for (const h of corpus) expect(parseHost(h)).toEqual(shared.parseHost(h))
  })
})
