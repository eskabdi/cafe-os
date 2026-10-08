import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  upload: vi.fn(),
  remove: vi.fn(),
  createSignedUrl: vi.fn(),
  bucket: [] as string[],
}))
vi.mock('./client', () => ({
  supabase: {
    storage: {
      from: (b: string) => {
        h.bucket.push(b)
        return { upload: h.upload, remove: h.remove, createSignedUrl: h.createSignedUrl }
      },
    },
  },
}))

const { removeMenuImage, signedMenuImageUrl, uploadMenuImage } = await import('./menu-images')
const { ClientActionError } = await import('./menu-inventory-errors')

const RID = '99999999-9999-4999-8999-999999999999'
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

beforeEach(() => {
  h.upload.mockReset().mockResolvedValue({ data: { path: 'x' }, error: null })
  h.remove.mockReset().mockResolvedValue({ data: [], error: null })
  h.createSignedUrl.mockReset()
  h.bucket.length = 0
})

describe('uploadMenuImage', () => {
  it('uploads to the private bucket under the own tenant menu prefix, never upserting', async () => {
    const file = new File([PNG], 'photo.PNG', { type: 'image/png' })
    const path = await uploadMenuImage(RID, file)
    expect(path).toMatch(new RegExp(`^restaurants/${RID}/menu/[0-9a-f-]{36}\\.png$`))
    expect(h.bucket).toEqual(['menu-images'])
    expect(h.upload).toHaveBeenCalledWith(path, file, expect.objectContaining({ contentType: 'image/png', upsert: false }))
  })

  it('refuses a renamed non-image, an unsupported type and an oversize file before any upload', async () => {
    const fake = new File([new TextEncoder().encode('<svg onload=alert(1)>')], 'x.png', { type: 'image/png' })
    await expect(uploadMenuImage(RID, fake)).rejects.toBeInstanceOf(ClientActionError)
    const svg = new File(['<svg/>'], 'x.svg', { type: 'image/svg+xml' })
    await expect(uploadMenuImage(RID, svg)).rejects.toMatchObject({ code: 'image_invalid' })
    const big = new File([PNG, new Uint8Array(2 * 1024 * 1024)], 'big.png', { type: 'image/png' })
    await expect(uploadMenuImage(RID, big)).rejects.toMatchObject({ code: 'image_invalid' })
    await expect(uploadMenuImage('not-a-uuid', new File([PNG], 'a.png', { type: 'image/png' }))).rejects.toMatchObject({
      code: 'image_invalid',
    })
    expect(h.upload).not.toHaveBeenCalled()
  })

  it('maps a Storage refusal to image_upload_failed', async () => {
    h.upload.mockResolvedValue({ data: null, error: { message: 'new row violates row-level security policy' } })
    await expect(uploadMenuImage(RID, new File([PNG], 'a.png', { type: 'image/png' }))).rejects.toMatchObject({
      code: 'image_upload_failed',
    })
  })
})

describe('signed URLs and removal', () => {
  it('returns only http(s) signed URLs', async () => {
    h.createSignedUrl.mockResolvedValueOnce({ data: { signedUrl: 'https://x.test/a?token=t' }, error: null })
    await expect(signedMenuImageUrl('restaurants/r/menu/a.png')).resolves.toBe('https://x.test/a?token=t')
    h.createSignedUrl.mockResolvedValueOnce({ data: { signedUrl: 'javascript:alert(1)' }, error: null })
    await expect(signedMenuImageUrl('p')).resolves.toBeNull()
    h.createSignedUrl.mockResolvedValueOnce({ data: null, error: { message: 'not found' } })
    await expect(signedMenuImageUrl('p')).resolves.toBeNull()
  })

  it('removal is best effort and never throws', async () => {
    h.remove.mockRejectedValueOnce(new Error('network'))
    await expect(removeMenuImage('p')).resolves.toBeUndefined()
    expect(h.remove).toHaveBeenCalledWith(['p'])
  })
})
