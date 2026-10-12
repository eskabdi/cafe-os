import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { formatEtb } from '@/lib/domain/decimal'
import { activeHours, ethiopianHourLabel, internationalHourLabel } from '@/lib/domain/reports'

// Chart rules (Phase 8): one series per chart in one hue (the tenant primary, via the CSS variable), one value axis, thin bars,
// a recessive grid, no legend (single series), text in ink / muted colours (never the series colour), and an sr-only table with
// the same figures for every chart so nothing is colour-, shape- or hover-only. Semantic status colours are never used as series.

const AXIS_TICK = { fill: 'hsl(var(--muted-foreground))', fontSize: 11 }

export function KpiTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-line bg-white p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-ink">{value}</p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

export interface HourRow {
  hour: number
  orders: number
  sales: number
}

/** Orders per tenant-local hour (24 thin bars). Hour labels: international on the axis, Ethiopian clock in tooltip and table. */
export function HourlyChart({ data, title }: { data: readonly HourRow[]; title: string }) {
  const rows = activeHours(data)
  return (
    <figure className="rounded-lg border border-line bg-white p-4">
      <figcaption className="mb-2 text-sm font-medium text-ink">{title}</figcaption>
      <div className="h-48" aria-hidden="true">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={[...data]} margin={{ top: 4, right: 4, bottom: 0, left: 0 }} barCategoryGap="30%">
            <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
            <XAxis dataKey="hour" tickLine={false} axisLine={false} tick={AXIS_TICK} interval={2} tickFormatter={(h: number) => String(h).padStart(2, '0')} />
            <YAxis allowDecimals={false} tickLine={false} axisLine={false} tick={AXIS_TICK} width={28} />
            <Tooltip
              cursor={{ fill: 'hsl(var(--muted))' }}
              contentStyle={{ color: '#1e293b' }}
              formatter={(v: number) => [v, 'Orders']}
              labelFormatter={(h: number) => `${internationalHourLabel(h)} · ${ethiopianHourLabel(h)}`}
            />
            <Bar dataKey="orders" fill="hsl(var(--primary))" maxBarSize={14} radius={[3, 3, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <table className="sr-only">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">Hour</th>
            <th scope="col">Ethiopian time</th>
            <th scope="col">Orders</th>
            <th scope="col">Sales</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={4}>No orders.</td>
            </tr>
          ) : (
            rows.map((d) => (
              <tr key={d.hour}>
                <th scope="row">{internationalHourLabel(d.hour)}</th>
                <td>{ethiopianHourLabel(d.hour)}</td>
                <td>{d.orders}</td>
                <td>{formatEtb(d.sales)}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </figure>
  )
}

export interface RankedRow {
  key: string
  label: string
  value: number
  detail?: string
}

/**
 * A ranked breakdown as horizontal bars (one hue, value labels in ink). The visual list is decorative for assistive technology;
 * the sr-only table carries the same rows. Row names come from the data (tenant rows / snapshots), never from code.
 */
export function RankedBars({
  title,
  rows,
  valueLabel,
  valueHeader = 'Amount',
}: {
  title: string
  rows: readonly RankedRow[]
  valueLabel: (v: number) => string
  valueHeader?: string
}) {
  const max = Math.max(0, ...rows.map((r) => r.value))
  return (
    <section className="rounded-lg border border-line bg-white p-4">
      <h3 className="mb-3 text-sm font-medium text-ink">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing yet.</p>
      ) : (
        <>
          <ul className="space-y-2" aria-hidden="true">
            {rows.map((r) => (
              <li key={r.key}>
                <div className="flex justify-between gap-2 text-sm">
                  <span className="min-w-0 truncate text-ink">{r.label}</span>
                  <span className="shrink-0 tabular-nums text-ink">
                    {valueLabel(r.value)}
                    {r.detail && <span className="ml-1 text-xs text-muted-foreground">{r.detail}</span>}
                  </span>
                </div>
                <div className="mt-1 h-1.5 rounded-full bg-muted">
                  <div
                    className="h-1.5 rounded-full bg-primary"
                    style={{ width: `${max > 0 && r.value > 0 ? Math.max(2, (r.value / max) * 100) : 0}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
          <table className="sr-only">
            <caption>{title}</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">{valueHeader}</th>
                <th scope="col">Detail</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <th scope="row">{r.label}</th>
                  <td>{valueLabel(r.value)}</td>
                  <td>{r.detail ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  )
}
