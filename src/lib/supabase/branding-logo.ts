import { sniffImageType } from '@/lib/domain/inventory'
import { isUuid } from '@/lib/domain/navigation'
import { checkLogoFile, logoObjectPath } from '@/lib/domain/portal'
import { supabase } from './client'
import { RpcError } from './rpc'

// Tenant logos live in the PRIVATE bucket `tenant-branding` under `restaurants/<own tenant id>/branding/<file>` (migration 0031).
// The Storage policies derive the tenant prefix from the caller's identity; fn_update_restaurant_branding re-checks the path and
// that the object exists. Display uses short-lived signed URLs; no base64 images, no public bucket.

export const BRANDING_BUCKET = 'tenant-branding'
export const LOGO_SIGNED_URL_TTL_SECONDS = 3600

/**
 * Validates (type, size, magic bytes) and uploads a picked logo. `restaurantId` must be the identity's own restaurant id
 * (session context). Returns the object path to pass to fn_update_restaurant_branding. Throws RpcError logo_invalid /
 * logo_upload_failed.
 */
export async function uploadLogo(restaurantId: string, file: File): Promise<string> {
  const check = checkLogoFile(file)
  if (!check.ok || !isUuid(restaurantId)) throw new RpcError('logo_invalid')
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer())
  if (sniffImageType(head) !== check.contentType) throw new RpcError('logo_invalid')
  const path = logoObjectPath(restaurantId.toLowerCase(), check.ext)
  const { error } = await supabase.storage
    .from(BRANDING_BUCKET)
    .upload(path, file, { contentType: check.contentType, upsert: false, cacheControl: '3600' })
  if (error) throw new RpcError('logo_upload_failed')
  return path
}

/** Short-lived signed URL for the stored logo path, or null when it cannot be signed. Only http(s) URLs are returned. */
export async function signedLogoUrl(path: string): Promise<string | null> {
  const { data, error } = await supabase.storage.from(BRANDING_BUCKET).createSignedUrl(path, LOGO_SIGNED_URL_TTL_SECONDS)
  if (error || !data?.signedUrl) return null
  return /^https?:\/\//i.test(data.signedUrl) ? data.signedUrl : null
}

/** Best effort: removes an uploaded logo that was never applied (the policy refuses deleting the current logo). */
export async function removeLogo(path: string): Promise<void> {
  try {
    await supabase.storage.from(BRANDING_BUCKET).remove([path])
  } catch {
    // an orphaned object in the tenant's own private prefix is harmless
  }
}
