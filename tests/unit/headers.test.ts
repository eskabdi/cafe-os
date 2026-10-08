import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const text = fs.readFileSync(path.resolve(__dirname, '../../public/_headers'), 'utf8')

/** Minimal parser for the Netlify/Cloudflare `_headers` format: unindented path lines, indented `Name: value` lines. */
function parse(src: string): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>()
  let current: Map<string, string> | null = null
  for (const raw of src.split('\n')) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue
    if (!/^\s/.test(raw)) {
      current = new Map()
      out.set(raw.trim(), current)
    } else if (current) {
      const i = raw.indexOf(':')
      current.set(raw.slice(0, i).trim().toLowerCase(), raw.slice(i + 1).trim())
    }
  }
  return out
}

function directives(csp: string): Map<string, string[]> {
  return new Map(
    csp
      .split(';')
      .map((d) => d.trim().split(/\s+/))
      .filter((p) => p[0])
      .map(([n, ...v]) => [n!, v]),
  )
}

describe('public/_headers', () => {
  const all = parse(text).get('/*')!
  const csp = directives(all.get('content-security-policy') ?? '')

  it('has a strict CSP', () => {
    expect(csp.get('default-src')).toEqual(["'self'"])
    expect(csp.get('script-src')).toEqual(["'self'"])
    expect(csp.get('object-src')).toEqual(["'none'"])
    expect(csp.get('base-uri')).toEqual(["'self'"])
    expect(csp.get('form-action')).toEqual(["'self'"])
    expect(csp.get('frame-ancestors')).toEqual(["'none'"])
    expect(csp.get('font-src')).toEqual(["'self'"])
    expect(csp.get('connect-src')).toEqual(["'self'", 'https://*.supabase.co', 'wss://*.supabase.co'])
    expect(csp.get('img-src')).toEqual(expect.arrayContaining(["'self'", 'data:', 'blob:']))
  })

  it('never allows unsafe script sources or wildcards in script-src', () => {
    const script = csp.get('script-src')!.join(' ')
    expect(script).not.toMatch(/unsafe-inline|unsafe-eval|\*|https?:/)
    expect(text.replace(/^#.*$/gm, '')).not.toMatch(/unsafe-eval/)
  })

  it('sets the other hardening headers', () => {
    expect(all.get('x-content-type-options')).toBe('nosniff')
    expect(all.get('referrer-policy')).toBe('no-referrer')
    expect(all.get('permissions-policy')).toContain('camera=()')
  })

  it('never caches the terminal', () => {
    const rules = parse(text)
    expect(rules.get('/terminal')?.get('cache-control')).toBe('no-store')
    expect(rules.get('/r/*')?.get('cache-control')).toBe('no-store')
  })
})
