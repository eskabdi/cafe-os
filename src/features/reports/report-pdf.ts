import { jsPDF } from 'jspdf'
import { autoTable } from 'jspdf-autotable'
import { formatCell, formatKpi, RESTRICTED_NOTICE, type ReportView } from './report-model'
import type { ExportMeta, GeneratedAt } from './report-export'

// PDF export. This module is only ever loaded with a dynamic import() from the export flow, so jsPDF and autoTable live in
// their own chunk and the main bundle does not grow. Amharic needs an Ethiopic font: the Tayitu font is fetched from
// /fonts/Tayitu.ttf and embedded; when it is missing the document falls back to Helvetica (Latin only) and says so.

export const FONT_URL = '/fonts/Tayitu.ttf'
export const FALLBACK_NOTE =
  'Amharic text needs the Tayitu font, which could not be loaded: this PDF uses Helvetica (Latin only).'

const ETHIOPIC = /[ሀ-᎟ⶀ-⷟꬀-꬯]/

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

/** A TrueType / OpenType file (not, for example, the SPA's index.html served for an unknown path). */
function isFont(buf: ArrayBuffer): boolean {
  const b = new Uint8Array(buf.slice(0, 4))
  const tag = String.fromCharCode(...b)
  return (b[0] === 0 && b[1] === 1 && b[2] === 0 && b[3] === 0) || tag === 'true' || tag === 'OTTO'
}

async function loadTayitu(doc: jsPDF): Promise<boolean> {
  try {
    const res = await fetch(FONT_URL, { credentials: 'same-origin' })
    if (!res.ok) return false
    const buf = await res.arrayBuffer()
    if (buf.byteLength < 1024 || buf.byteLength > 8 * 1024 * 1024 || !isFont(buf)) return false
    doc.addFileToVFS('Tayitu.ttf', toBase64(buf))
    doc.addFont('Tayitu.ttf', 'Tayitu', 'normal')
    doc.setFont('Tayitu', 'normal')
    return true
  } catch {
    return false
  }
}

/** Best effort: the tenant logo (PNG / JPEG only, at most 1 MB) as a data URL for addImage, or null. */
async function loadLogo(url: string | null): Promise<{ data: string; format: 'PNG' | 'JPEG' } | null> {
  if (!url || !/^https?:\/\//i.test(url)) return null
  try {
    const res = await fetch(url, { credentials: 'omit' })
    if (!res.ok) return null
    const blob = await res.blob()
    const format = blob.type === 'image/png' ? 'PNG' : blob.type === 'image/jpeg' ? 'JPEG' : null
    if (!format || blob.size > 1024 * 1024) return null
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(new Error('read'))
      reader.readAsDataURL(blob)
    })
    return { data, format }
  } catch {
    return null
  }
}

function lastY(doc: jsPDF, fallback: number): number {
  return (doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY ?? fallback
}

export interface PdfResult {
  blob: Blob
  /** false when the Tayitu font could not be loaded (Helvetica, Latin only). */
  amharicFont: boolean
}

export async function renderReportPdf(
  view: ReportView,
  meta: ExportMeta,
  generated: GeneratedAt,
): Promise<PdfResult> {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' })
  const [amharicFont, logo] = await Promise.all([loadTayitu(doc), loadLogo(meta.logoUrl)])
  const font = amharicFont ? 'Tayitu' : 'helvetica'
  // without an Ethiopic font, Ethiopic text would print as garbage: show the Latin form only
  const latin = (s: string) => (amharicFont || !ETHIOPIC.test(s) ? s : '')
  const margin = 40
  let y = margin

  if (logo) {
    try {
      doc.addImage(logo.data, logo.format, margin, y, 40, 40)
    } catch {
      /* an unreadable image is skipped */
    }
  }
  const x = logo ? margin + 52 : margin
  doc.setFont(font, 'normal')
  doc.setFontSize(16)
  doc.text(meta.restaurantName, x, y + 14)
  doc.setFontSize(13)
  doc.text(view.title, x, y + 32)
  y += 52
  doc.setFontSize(9)
  const lines = [
    latin(`Period: ${meta.period.ethiopian}`),
    `Gregorian: ${meta.period.gregorian}`,
    [latin(`Generated: ${generated.ethiopian}`), `(${generated.international})`].filter(Boolean).join(' '),
    amharicFont ? '' : FALLBACK_NOTE,
  ].filter((l) => l !== '')
  for (const line of lines) {
    doc.text(line, margin, y, { maxWidth: doc.internal.pageSize.getWidth() - 2 * margin })
    y += 13
  }
  y += 6

  const styles = { font, fontStyle: 'normal' as const, fontSize: 9 }
  const headStyles = {
    font,
    fontStyle: 'normal' as const,
    fillColor: [30, 41, 59] as [number, number, number],
  }
  if (view.kpis.length > 0) {
    autoTable(doc, {
      startY: y,
      head: [['Key figures', 'Value']],
      body: view.kpis.map((k) => [k.label, formatKpi(k)]),
      styles,
      headStyles,
      margin: { left: margin, right: margin },
      columnStyles: { 1: { halign: 'right' } },
    })
    y = lastY(doc, y) + 18
  }
  for (const t of view.tables) {
    if (y > doc.internal.pageSize.getHeight() - 90) {
      doc.addPage()
      y = margin
    }
    doc.setFontSize(11)
    doc.text(t.title, margin, y)
    y += 6
    const numeric = Object.fromEntries(
      t.columns.flatMap((c, i) => (c.kind === 'text' ? [] : [[i, { halign: 'right' as const }]])),
    )
    autoTable(doc, {
      startY: y,
      head: [t.columns.map((c) => c.header)],
      body: t.restricted
        ? [[{ content: RESTRICTED_NOTICE, colSpan: t.columns.length }]]
        : t.rows.length === 0
          ? [[{ content: t.empty, colSpan: t.columns.length }]]
          : t.rows.map((r) => t.columns.map((c) => latin(formatCell(c.kind, r[c.key] ?? null)) || '—')),
      styles,
      headStyles,
      margin: { left: margin, right: margin },
      columnStyles: t.restricted || t.rows.length === 0 ? {} : numeric,
    })
    y = lastY(doc, y) + 18
  }
  return { blob: doc.output('blob'), amharicFont }
}
