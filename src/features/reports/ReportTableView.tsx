import { cn } from '@/lib/utils/cn'
import { formatCell, formatKpi, RESTRICTED_NOTICE, type ReportKpi, type ReportTable } from './report-model'
import { KpiTile } from './charts'

/** Neutral notice for a section the server withheld (never an error colour: nothing is wrong, the data is just not shown). */
export function RestrictedNotice({ title }: { title: string }) {
  return (
    <section aria-label={title} className="rounded-lg border border-dashed border-line bg-muted/40 p-4">
      <h3 className="text-sm font-medium text-ink">{title}</h3>
      <p className="mt-1 text-sm text-muted-foreground" data-testid="restricted-notice">
        {RESTRICTED_NOTICE}
      </p>
    </section>
  )
}

/** A report table with a caption, numeric columns right-aligned with tabular figures. Text is rendered as text only. */
export function ReportTableView({ t, className }: { t: ReportTable; className?: string }) {
  if (t.restricted) return <RestrictedNotice title={t.title} />
  return (
    <div className={cn('overflow-x-auto rounded-lg border border-line bg-white', className)}>
      <table className="w-full text-sm">
        <caption className="px-4 pt-3 text-left text-sm font-medium text-ink">{t.title}</caption>
        <thead>
          <tr className="border-b border-line text-xs uppercase text-muted-foreground">
            {t.columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={cn('px-4 py-2 font-medium', c.kind === 'text' ? 'text-left' : 'text-right')}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {t.rows.length === 0 ? (
            <tr>
              <td colSpan={t.columns.length} className="px-4 py-3 text-muted-foreground">
                {t.empty}
              </td>
            </tr>
          ) : (
            t.rows.map((r, i) => (
              <tr key={i} className="border-b border-line last:border-0">
                {t.columns.map((c, j) => {
                  const text = formatCell(c.kind, r[c.key] ?? null)
                  const cls = cn('px-4 py-2', c.kind === 'text' ? 'text-left' : 'text-right tabular-nums')
                  return j === 0 ? (
                    <th key={c.key} scope="row" className={cn(cls, 'font-normal text-ink')}>
                      {text}
                    </th>
                  ) : (
                    <td key={c.key} className={cls}>
                      {text}
                    </td>
                  )
                })}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}

export function KpiGrid({ kpis }: { kpis: readonly ReportKpi[] }) {
  if (kpis.length === 0) return null
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5" data-testid="report-kpis">
      {kpis.map((k) => (
        <KpiTile key={k.label} label={k.label} value={formatKpi(k)} hint={k.hint} />
      ))}
    </div>
  )
}
