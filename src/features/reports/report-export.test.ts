import { afterEach, describe, expect, it, vi } from 'vitest'
import { RpcError } from '@/lib/supabase/rpc'
import { exportErrorMessage, PRINT_LOGO_TIMEOUT_MS, waitForImage } from './report-export'

vi.mock('@/lib/supabase/client', () => ({ supabase: {} }))

const pending = (img: HTMLImageElement, decode?: () => Promise<void>) => {
  Object.defineProperty(img, 'complete', { configurable: true, get: () => false })
  Object.defineProperty(img, 'decode', { configurable: true, value: decode })
  return img
}

afterEach(() => vi.useRealTimers())

describe('waitForImage (print waits for the logo)', () => {
  it('no logo: resolves at once', async () => {
    await expect(waitForImage(null)).resolves.toBeUndefined()
  })

  it('resolves when img.decode() resolves, and when it rejects (a broken logo never blocks printing)', async () => {
    let ok!: () => void
    const img = pending(document.createElement('img'), () => new Promise<void>((r) => (ok = r)))
    let done = false
    const p = waitForImage(img, 10_000).then(() => (done = true))
    await Promise.resolve()
    expect(done).toBe(false)
    ok()
    await p
    expect(done).toBe(true)
    await expect(waitForImage(pending(document.createElement('img'), () => Promise.reject(new Error('broken'))), 10_000)).resolves.toBeUndefined()
  })

  it('without decode(): the load / error event settles it', async () => {
    const img = pending(document.createElement('img'))
    const p = waitForImage(img, 10_000)
    img.dispatchEvent(new Event('load'))
    await expect(p).resolves.toBeUndefined()
  })

  it('a logo that never settles is given up after the timeout', async () => {
    vi.useFakeTimers()
    const img = pending(document.createElement('img'), () => new Promise<void>(() => {}))
    let done = false
    const p = waitForImage(img).then(() => (done = true))
    await vi.advanceTimersByTimeAsync(PRINT_LOGO_TIMEOUT_MS - 1)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await p
    expect(done).toBe(true)
  })
})

describe('exportErrorMessage', () => {
  it('the export throttle has its own fixed message', () => {
    expect(exportErrorMessage(new RpcError('rate_limited'))).toBe(
      'Too many exports in the last minute. Wait a minute and try again. Nothing was exported.',
    )
  })
})
