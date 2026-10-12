import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseHeaders, toVercelConfig, toVercelSource } from '../../scripts/ops/headers-to-vercel.mjs'

type Rule = { source: string; headers: { key: string; value: string }[] }
const text = fs.readFileSync(path.resolve(__dirname, '../../public/_headers'), 'utf8')

describe('headers-to-vercel', () => {
  it('maps _headers paths to Vercel sources', () => {
    expect(toVercelSource('/*')).toBe('/(.*)')
    expect(toVercelSource('/r/*')).toBe('/r/(.*)')
    expect(toVercelSource('/terminal')).toBe('/terminal')
    expect(() => toVercelSource('/a b')).toThrow()
  })

  it('carries every security header of public/_headers to every path', () => {
    const rules: Rule[] = parseHeaders(text)
    const all = rules.find((r) => r.source === '/(.*)')
    const keys = all?.headers.map((h) => h.key) ?? []
    for (const k of [
      'Content-Security-Policy',
      'X-Content-Type-Options',
      'Referrer-Policy',
      'Permissions-Policy',
      'Strict-Transport-Security',
      'Cross-Origin-Opener-Policy',
      'X-Frame-Options',
    ]) {
      expect(keys).toContain(k)
    }
    const csp = all?.headers.find((h) => h.key === 'Content-Security-Policy')?.value ?? ''
    expect(csp).toContain("script-src 'self'")
    expect(csp).toContain("frame-ancestors 'none'")
  })

  it('keeps the no-store rule for tenant and terminal pages and adds the SPA rewrite', () => {
    const cfg = toVercelConfig(text)
    for (const src of ['/terminal', '/r/(.*)']) {
      expect(cfg.headers.find((r) => r.source === src)?.headers).toContainEqual({
        key: 'Cache-Control',
        value: 'no-store',
      })
    }
    expect(cfg.rewrites).toEqual([{ source: '/(.*)', destination: '/index.html' }])
  })

  it('refuses a header line before any path', () => {
    expect(() => parseHeaders('  X-Test: 1\n')).toThrow()
  })
})
