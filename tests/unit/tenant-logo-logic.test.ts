import { describe, expect, it } from 'vitest'
import {
  LOGO_URL_TTL_SEC,
  interpretLogoPath,
  isSignedUrlForProject,
  parseSlugParam,
  shapeLogo,
  shapeRateLimited,
} from '../../supabase/functions/tenant-logo/logic'

const RID = '11111111-1111-4111-8111-111111111111'
const BASE = 'https://abc.supabase.co'

describe('tenant-logo logic', () => {
  it('accepts exactly ?slug=<valid slug>', () => {
    expect(parseSlugParam(`${BASE}/functions/v1/tenant-logo?slug=Central-Cafe`)).toBe('central-cafe')
    expect(parseSlugParam(`${BASE}/functions/v1/tenant-logo`)).toBeNull()
    expect(parseSlugParam(`${BASE}/functions/v1/tenant-logo?slug=a&x=1`)).toBeNull()
    expect(parseSlugParam(`${BASE}/functions/v1/tenant-logo?slug=../etc`)).toBeNull()
    expect(parseSlugParam(`${BASE}/functions/v1/tenant-logo?slug=${'a'.repeat(80)}`)).toBeNull()
  })
  it('only a branding path of one tenant', () => {
    expect(interpretLogoPath({ logo_path: `restaurants/${RID}/branding/logo.png` })).toBe(`restaurants/${RID}/branding/logo.png`)
    expect(interpretLogoPath({ logo_path: null })).toBeNull()
    expect(interpretLogoPath({ logo_path: `restaurants/${RID}/menu/x.png` })).toBeNull()
    expect(interpretLogoPath({ logo_path: `restaurants/${RID}/branding/../x.png` })).toBeNull()
    expect(interpretLogoPath(null)).toBeNull()
  })
  it('the signed URL must be this project, the branding bucket, https', () => {
    expect(isSignedUrlForProject(`${BASE}/storage/v1/object/sign/tenant-branding/restaurants/x?token=t`, BASE)).toBe(true)
    expect(isSignedUrlForProject(`https://evil.example/storage/v1/object/sign/tenant-branding/x`, BASE)).toBe(false)
    expect(isSignedUrlForProject(`${BASE}/storage/v1/object/sign/menu-images/x`, BASE)).toBe(false)
    expect(isSignedUrlForProject(`http://abc.supabase.co/storage/v1/object/sign/tenant-branding/x`, BASE)).toBe(false)
    expect(isSignedUrlForProject(undefined, BASE)).toBe(false)
  })
  it('one response shape for found and not found (no oracle)', () => {
    const miss = shapeLogo(null)
    const hit = shapeLogo('https://x')
    expect(miss.status).toBe(hit.status)
    expect(Object.keys(miss.body).sort()).toEqual(Object.keys(hit.body).sort())
    expect(hit.body.expires_in).toBe(LOGO_URL_TTL_SEC)
    expect(miss.headers['Cache-Control']).toBe('no-store')
    expect(shapeRateLimited(0).headers['Retry-After']).toBe('1')
  })
})
