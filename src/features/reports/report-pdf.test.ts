import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderReportPdf } from './report-pdf'
import type { ReportView } from './report-model'

// The real jsPDF + autoTable (no mock): the document is produced and the font fallback is reported.
const view: ReportView = {
  type: 'payments',
  title: 'Payments by method',
  kpis: [
    { label: 'Collected', value: 414, kind: 'money' },
    { label: 'Cash', value: null, kind: 'money' },
  ],
  tables: [
    {
      id: 'by-payment-method',
      title: 'Collected by payment method',
      columns: [
        { key: 'name', header: 'Method', kind: 'text' },
        { key: 'amount', header: 'Amount', kind: 'money' },
      ],
      rows: [{ name: 'Amole', amount: 253 }],
      restricted: false,
      empty: 'Nothing in this period.',
    },
    { id: 'x', title: 'Withheld', columns: [{ key: 'a', header: 'A', kind: 'text' }], rows: [], restricted: true, empty: '' },
  ],
}
const meta = {
  restaurantName: 'Demo Cafe',
  slug: 'demo-cafe',
  from: '2026-10-12',
  to: '2026-10-18',
  period: { ethiopian: '2 ጥቅምት 2019 – 8 ጥቅምት 2019', gregorian: '2026-10-12 – 2026-10-18' },
  timezone: 'Africa/Addis_Ababa',
  logoUrl: null,
}
const generated = { ethiopian: '2 ጥቅምት 2019, 3:00 ጠዋት', international: '2026-10-12 09:00' }

afterEach(() => vi.unstubAllGlobals())

describe('renderReportPdf', () => {
  it('falls back to Helvetica (and says so) when /fonts/Tayitu.ttf is missing or not a font', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } }))
    vi.stubGlobal('fetch', fetch)
    const r = await renderReportPdf(view, meta, generated)
    expect(fetch).toHaveBeenCalledWith('/fonts/Tayitu.ttf', expect.anything())
    expect(r.amharicFont).toBe(false)
    expect(r.blob.size).toBeGreaterThan(1000)
    const head = new TextDecoder().decode(new Uint8Array(await r.blob.arrayBuffer()).slice(0, 5))
    expect(head).toBe('%PDF-')
  })

  it('a failed font request is a fallback too, never an error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')))
    await expect(renderReportPdf(view, meta, generated)).resolves.toMatchObject({ amharicFont: false })
  })
})
