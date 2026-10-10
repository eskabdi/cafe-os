import type { ReactNode } from 'react'

/** Page title row shared by the portal pages: one h1, an optional description and actions. */
export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 space-y-1">
        <h1 className="text-2xl font-semibold text-ink">{title}</h1>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  )
}

/** White card section with an h2. */
export function Card({ title, children, actions, id }: { title: string; children: ReactNode; actions?: ReactNode; id?: string }) {
  const headingId = id ?? `card-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
  return (
    <section aria-labelledby={headingId} className="space-y-4 rounded-card border border-line bg-white p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={headingId} className="text-base font-semibold text-ink">
          {title}
        </h2>
        {actions}
      </div>
      {children}
    </section>
  )
}

/** Definition list row helper. */
export function Facts({ items }: { items: Array<{ label: string; value: ReactNode }> }) {
  return (
    <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
      {items.map((i) => (
        <div key={i.label} className="min-w-0">
          <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{i.label}</dt>
          <dd className="break-words text-sm text-ink">{i.value}</dd>
        </div>
      ))}
    </dl>
  )
}
