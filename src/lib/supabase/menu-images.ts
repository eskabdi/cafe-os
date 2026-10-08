import { checkMenuImage, menuImagePath, sniffImageType } from '@/lib/domain/inventory'
import { isUuid } from '@/lib/domain/navigation'
import { supabase } from './client'
import { ClientActionError } from './menu-inventory-errors'

// Menu images live in the PRIVATE bucket `menu-images` under `restaurants/<own tenant id>/menu/<file>` (migration 0029).
// The Storage policies derive the tenant prefix from the caller's identity and fn_menu_check_image re-checks the path and
// that the object exists, so a forged prefix is refused server-side. Display uses short-lived signed URLs; no base64 images.

export const MENU_IMAGE_BUCKET = 'menu-images'
/** Signed URL lifetime; the query re-signs before it expires. */
export const SIGNED_URL_TTL_SECONDS = 3600

export const menuImageUrlKey = (path: string) => ['menu-image-url', path] as const

/**
 * Validates (type, size, magic bytes) and uploads a picked file. `restaurantId` must be the identity's own restaurant id
 * (session context). Returns the object path to pass as image_path. Throws ClientActionError image_invalid / image_upload_failed.
 */
export async function uploadMenuImage(restaurantId: string, file: File): Promise<string> {
  const check = checkMenuImage(file)
  if (!check.ok || !isUuid(restaurantId)) throw new ClientActionError('image_invalid')
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer())
  if (sniffImageType(head) !== check.contentType) throw new ClientActionError('image_invalid')
  const path = menuImagePath(restaurantId.toLowerCase(), check.ext)
  const { error } = await supabase.storage
    .from(MENU_IMAGE_BUCKET)
    .upload(path, file, { contentType: check.contentType, upsert: false, cacheControl: '3600' })
  if (error) throw new ClientActionError('image_upload_failed')
  return path
}

/** Best effort: removes an object no menu item points at (the delete policy refuses one that is still referenced). */
export async function removeMenuImage(path: string): Promise<void> {
  try {
    await supabase.storage.from(MENU_IMAGE_BUCKET).remove([path])
  } catch {
    // an orphaned object is harmless (private bucket, own tenant prefix)
  }
}

/** Short-lived signed URL for a stored image path, or null when it cannot be signed (deleted, no access). */
export async function signedMenuImageUrl(path: string): Promise<string | null> {
  const { data, error } = await supabase.storage.from(MENU_IMAGE_BUCKET).createSignedUrl(path, SIGNED_URL_TTL_SECONDS)
  if (error || !data?.signedUrl) return null
  // only an http(s) URL is ever used as an <img src>
  return /^https?:\/\//i.test(data.signedUrl) ? data.signedUrl : null
}
