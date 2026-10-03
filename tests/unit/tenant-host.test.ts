import { describe, expect, it } from 'vitest'
import {
  RESERVED_SUBDOMAINS,
  isReservedSubdomain,
  isValidSlug,
  normalizeHost,
  originSlugMatches,
  parseHost,
  tenantSlugFromHost,
} from '../../supabase/functions/_shared/host'
import { corsHeaders, parseAllowedOrigins, resolveAllowedOrigin } from '../../supabase/functions/_shared/cors'

describe('reserved subdomains', () => {
  it('contains the user-specified list plus the legacy DB list (the SQL test pins the same 14)', () => {
    expect([...RESERVED_SUBDOMAINS].sort()).toEqual([
      'admin',
      'api',
      'app',
      'assets',
      'auth',
      'cdn',
      'login',
      'mail',
      'platform',
      'r',
      'static',
      'status',
      'support',
      'www',
    ])
    for (const l of [
      'www',
      'app',
      'api',
      'admin',
      'platform',
      'auth',
      'static',
      'cdn',
      'mail',
      'support',
      'status',
    ]) {
      expect(isReservedSubdomain(l)).toBe(true)
      expect(isValidSlug(l)).toBe(false)
    }
  })
})

describe('isValidSlug (same as restaurants_slug_format)', () => {
  it.each(['central-cafe', 'abc', 'a1b', 'x'.repeat(40), 'cafe-2'])('accepts %s', (s) =>
    expect(isValidSlug(s)).toBe(true),
  )
  it.each(['ab', 'x'.repeat(41), '-abc', 'abc-', 'a--b', 'ABC', 'a_b', 'a.b', '', 'ab c', 'www'])(
    'rejects %s',
    (s) => expect(isValidSlug(s)).toBe(false),
  )
})

describe('parseHost / tenantSlugFromHost', () => {
  it('resolves <slug>.cafeos.et and <slug>.localhost (with port, case, trailing dot)', () => {
    expect(tenantSlugFromHost('central-cafe.cafeos.et')).toBe('central-cafe')
    expect(tenantSlugFromHost('Central-Cafe.CAFEOS.ET:443')).toBe('central-cafe')
    expect(tenantSlugFromHost('central-cafe.cafeos.et.')).toBe('central-cafe')
    expect(tenantSlugFromHost('acme.localhost:5173')).toBe('acme')
    expect(tenantSlugFromHost('https://central-cafe.cafeos.et/path?x=1')).toBe('central-cafe')
  })
  it('the platform host is its own kind, reserved labels never resolve', () => {
    expect(parseHost('platform.cafeos.et')).toEqual({ kind: 'platform' })
    expect(parseHost('platform.localhost:5173')).toEqual({ kind: 'platform' })
    for (const l of ['www', 'app', 'api', 'admin', 'auth', 'static', 'cdn', 'mail', 'support', 'status']) {
      expect(parseHost(`${l}.cafeos.et`)).toEqual({ kind: 'reserved', label: l })
      expect(tenantSlugFromHost(`${l}.cafeos.et`)).toBeNull()
    }
  })
  it('the apex is bare; everything else is unknown', () => {
    expect(parseHost('cafeos.et')).toEqual({ kind: 'bare' })
    expect(parseHost('localhost:5173')).toEqual({ kind: 'bare' })
    for (const h of [
      'evil.com',
      'central-cafe.cafeos.et.evil.com',
      'a.b.cafeos.et',
      'notcafeos.et',
      'central-cafe.cafeos.com',
      '127.0.0.1',
      '[::1]',
      'a--b.cafeos.et',
      '-x.cafeos.et',
      'ab.cafeos.et',
      '',
      null,
      undefined,
    ]) {
      expect(parseHost(h as string)).toEqual({ kind: 'unknown' })
    }
  })
  it('honours custom base domains', () => {
    expect(tenantSlugFromHost('acme.staging.example.com', ['staging.example.com'])).toBe('acme')
    expect(tenantSlugFromHost('acme.cafeos.et', ['staging.example.com'])).toBeNull()
  })
  it('normalizeHost strips port / dot / scheme and refuses junk', () => {
    expect(normalizeHost('A.B:80')).toBe('a.b')
    expect(normalizeHost('x'.repeat(300))).toBeNull()
    expect(normalizeHost('http://%%%')).toBeNull()
  })
})

describe('originSlugMatches', () => {
  it('only constrains tenant-host origins', () => {
    expect(originSlugMatches('https://central-cafe.cafeos.et', 'central-cafe')).toBe(true)
    expect(originSlugMatches('https://central-cafe.cafeos.et', 'second-cafe')).toBe(false)
    expect(originSlugMatches('http://localhost:5173', 'second-cafe')).toBe(true)
    expect(originSlugMatches('https://platform.cafeos.et', 'second-cafe')).toBe(true)
    expect(originSlugMatches(null, 'second-cafe')).toBe(true)
  })
})

describe('CORS tenant-subdomain wildcard', () => {
  const allowed = parseAllowedOrigins(
    'https://*.cafeos.et,https://platform.cafeos.et,http://localhost:5173,*',
  )
  it('keeps the bare * ignored and normalizes the one wildcard form', () => {
    expect(allowed).toEqual(['https://*.cafeos.et', 'https://platform.cafeos.et', 'http://localhost:5173'])
  })
  it('matches exactly one valid, non-reserved tenant label on the same scheme and port', () => {
    expect(resolveAllowedOrigin('https://central-cafe.cafeos.et', allowed)).toBe(
      'https://central-cafe.cafeos.et',
    )
    expect(resolveAllowedOrigin('https://platform.cafeos.et', allowed)).toBe('https://platform.cafeos.et') // explicit entry
    expect(resolveAllowedOrigin('https://www.cafeos.et', allowed)).toBeNull()
    expect(resolveAllowedOrigin('https://a.b.cafeos.et', allowed)).toBeNull()
    expect(resolveAllowedOrigin('http://central-cafe.cafeos.et', allowed)).toBeNull()
    expect(resolveAllowedOrigin('https://central-cafe.cafeos.et:8443', allowed)).toBeNull()
    expect(resolveAllowedOrigin('https://cafeos.et', allowed)).toBeNull()
    expect(resolveAllowedOrigin('https://central-cafe.cafeos.et.evil.com', allowed)).toBeNull()
    expect(
      corsHeaders(resolveAllowedOrigin('https://central-cafe.cafeos.et', allowed))[
        'Access-Control-Allow-Origin'
      ],
    ).toBe('https://central-cafe.cafeos.et')
  })
  it('platform host is NOT covered by the wildcard (reserved)', () => {
    expect(resolveAllowedOrigin('https://platform.cafeos.et', ['https://*.cafeos.et'])).toBeNull()
  })
  it('supports the dev wildcard with a port', () => {
    const dev = parseAllowedOrigins('http://*.localhost:5173')
    expect(resolveAllowedOrigin('http://acme.localhost:5173', dev)).toBe('http://acme.localhost:5173')
    expect(resolveAllowedOrigin('http://acme.localhost:3000', dev)).toBeNull()
  })
})
