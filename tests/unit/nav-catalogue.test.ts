import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MODULE_NAV } from '@/features/shell/nav-config'

// Every navigation entry must be keyed by a permission code that really exists in the server's catalogue (migrations), so the
// route guard, the nav and RLS/RPC checks agree. Inventing a code would silently hide a module from everyone but tenant_admin.
function catalogue(): Set<string> {
  const dir = path.resolve(__dirname, '../../supabase/migrations')
  const keys = new Set<string>()
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.sql'))) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8')
    for (const block of sql.matchAll(/insert into public\.permissions[^;]*;/gi)) {
      for (const m of block[0].matchAll(/\(\s*'([a-z_]+\.[a-z_]+)'\s*,/g)) keys.add(m[1] ?? '')
    }
  }
  return keys
}

describe('MODULE_NAV', () => {
  const codes = catalogue()

  it('parses the permission catalogue', () => {
    expect(codes.has('dashboard.view')).toBe(true)
    expect(codes.has('kiosks.manage')).toBe(true)
  })

  it('uses only real permission codes', () => {
    for (const m of MODULE_NAV) expect(codes, `${m.id} -> ${m.permission}`).toContain(m.permission)
  })

  it('has unique ids and segments, none of them station routes', () => {
    expect(new Set(MODULE_NAV.map((m) => m.id)).size).toBe(MODULE_NAV.length)
    expect(new Set(MODULE_NAV.map((m) => m.segment)).size).toBe(MODULE_NAV.length)
    expect(MODULE_NAV.some((m) => m.segment.startsWith('stations'))).toBe(false)
  })
})
