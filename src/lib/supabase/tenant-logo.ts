import { z } from 'zod'

// The tenant's current logo for the sign-in page, BEFORE anyone is signed in (tenant-logo Edge Function, Public; owner
// decision 2026-10-08). The function signs a 10-minute URL for the private tenant-branding object; every miss is {url: null}.
// Called with the anon key only (like pin-login): no user token, no tenant id, just the public slug.

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/
const responseSchema = z.object({ url: z.string().nullable() })

export async function fetchTenantLogoUrl(slug: string, timeoutMs = 5000): Promise<string | null> {
  const base = String(import.meta.env.VITE_SUPABASE_URL ?? '').replace(/\/+$/, '')
  const anon = String(import.meta.env.VITE_SUPABASE_ANON_KEY ?? '')
  if (!base || !anon || !SLUG_RE.test(slug)) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${base}/functions/v1/tenant-logo?slug=${encodeURIComponent(slug)}`, {
      method: 'GET',
      headers: { apikey: anon, Authorization: `Bearer ${anon}` },
      credentials: 'omit',
      signal: controller.signal,
    })
    if (!res.ok) return null
    const parsed = responseSchema.safeParse(await res.json())
    const url = parsed.success ? parsed.data.url : null
    // only this project's Storage over http(s) is ever rendered
    if (!url) return null
    const u = new URL(url)
    return u.origin === new URL(base).origin && /^https?:$/.test(u.protocol) ? url : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
