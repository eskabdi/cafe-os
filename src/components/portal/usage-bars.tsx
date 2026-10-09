import { formatBytes, formatCount, usageRows } from '@/lib/domain/portal'
import { cn } from '@/lib/utils/cn'

/**
 * Usage vs plan quota (aggregate counters from fn_tenant_usage; both portals show the same numbers). Over-quota uses the
 * fixed semantic error colour, never the tenant brand. Bars are presentational: a meter role with a text equivalent.
 */
export function UsageBars({
  usage,
  limits,
  overQuota,
}: {
  usage: Record<string, unknown>
  limits: Record<string, unknown>
  overQuota: readonly string[]
}) {
  const rows = usageRows(usage, limits, overQuota)
  return (
    <ul className="space-y-4" aria-label="Usage against plan limits">
      {rows.map((r) => {
        const fmt = r.format === 'bytes' ? formatBytes : formatCount
        const text = `${fmt(r.used)} of ${r.limit === null ? 'unlimited' : fmt(r.limit)}`
        return (
          <li key={r.metric} className="space-y-1" data-testid={`usage-${r.metric}`}>
            <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
              <span className="font-medium text-ink">{r.label}</span>
              <span className={cn('tabular-nums', r.over ? 'font-semibold text-status-error' : 'text-muted-foreground')}>
                {text}
                {r.over && ' (over quota)'}
              </span>
            </div>
            {r.percent !== null && (
              <div
                role="meter"
                aria-label={r.label}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={r.percent}
                aria-valuetext={text}
                className="h-2.5 w-full overflow-hidden rounded-pill bg-muted"
              >
                <div
                  className={cn('h-full rounded-pill', r.over ? 'bg-status-error' : r.percent >= 80 ? 'bg-status-warning' : 'bg-status-success')}
                  style={{ width: `${r.percent}%` }}
                />
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}
