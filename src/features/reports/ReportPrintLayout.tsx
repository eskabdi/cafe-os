import { createPortal } from 'react-dom'
import { formatCell, formatKpi, RESTRICTED_NOTICE, type ReportView } from './report-model'
import type { ExportMeta, GeneratedAt } from './report-export'

/**
 * Print-only layout, portalled to <body> while a print job runs (index.css hides the app and shows only `.report-print`).
 * Header: logo, restaurant, report title, period (Ethiopian + Gregorian), generated at (Ethiopian clock + international).
 */
export function ReportPrintLayout({
  view,
  meta,
  generated,
}: {
  view: ReportView
  meta: ExportMeta
  generated: GeneratedAt
}) {
  return createPortal(
    <div className="report-print" data-testid="report-print">
      <header className="report-print-header">
        {meta.logoUrl && <img src={meta.logoUrl} alt="" className="report-print-logo" />}
        <div>
          <p className="report-print-restaurant">{meta.restaurantName}</p>
          <h1>{view.title}</h1>
          <p className="font-amharic">
            {meta.period.ethiopian} · {meta.period.gregorian}
          </p>
          <p>
            Generated <span className="font-amharic">{generated.ethiopian}</span> ({generated.international})
          </p>
        </div>
      </header>
      {view.kpis.length > 0 && (
        <table>
          <caption>Key figures</caption>
          <tbody>
            {view.kpis.map((k) => (
              <tr key={k.label}>
                <th scope="row">{k.label}</th>
                <td className="num">{formatKpi(k)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {view.tables.map((t) => (
        <table key={t.id}>
          <caption>{t.title}</caption>
          <thead>
            <tr>
              {t.columns.map((c) => (
                <th key={c.key} scope="col" className={c.kind === 'text' ? undefined : 'num'}>
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {t.restricted || t.rows.length === 0 ? (
              <tr>
                <td colSpan={t.columns.length}>{t.restricted ? RESTRICTED_NOTICE : t.empty}</td>
              </tr>
            ) : (
              t.rows.map((r, i) => (
                <tr key={i}>
                  {t.columns.map((c) => (
                    <td key={c.key} className={c.kind === 'text' ? undefined : 'num'}>
                      {formatCell(c.kind, r[c.key] ?? null)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      ))}
    </div>,
    document.body,
  )
}
