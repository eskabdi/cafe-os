import { useId, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Construction, Inbox, Lock, TriangleAlert, type LucideIcon } from 'lucide-react'
import { Button, buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils/cn'

// Shared page states. Copy is fixed and safe: no server error text, SQL or ids are ever rendered.

/** Placeholder blocks while a page or list loads. Announced once to assistive tech. */
export function PageSkeleton({ label = 'Loading' }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" className="space-y-4 p-4 lg:p-6">
      <span className="sr-only">{label}…</span>
      <div aria-hidden="true" className="h-8 w-48 animate-pulse rounded-md bg-muted" />
      <div aria-hidden="true" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-24 animate-pulse rounded-card bg-muted" />
        ))}
      </div>
    </div>
  )
}

/** Compact skeleton rows for a nav list. */
export function NavSkeleton({ rows = 3, label }: { rows?: number; label: string }) {
  return (
    <div role="status" aria-live="polite" className="space-y-2 px-2 py-1">
      <span className="sr-only">{label}…</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} aria-hidden="true" className="h-11 animate-pulse rounded-md bg-muted" />
      ))}
    </div>
  )
}

interface StateProps {
  title: string
  children?: ReactNode
  action?: ReactNode
}

function StatePanel({
  icon: Icon,
  tone,
  role,
  title,
  children,
  action,
  level = 1,
}: StateProps & { icon: LucideIcon; tone: string; role?: 'alert' | 'status'; level?: 1 | 2 }) {
  const titleId = useId()
  const Heading = level === 1 ? 'h1' : 'h2'
  return (
    <section
      aria-labelledby={titleId}
      className="mx-auto flex max-w-lg flex-col items-center gap-3 p-6 text-center lg:p-10"
    >
      <Icon aria-hidden="true" className={cn('h-10 w-10', tone)} />
      <Heading id={titleId} className="text-xl font-semibold text-ink">
        {title}
      </Heading>
      <div role={role} className="space-y-2 text-sm text-muted-foreground">
        {children}
      </div>
      {action}
    </section>
  )
}

/** Generic failure with an optional retry. Uses the fixed semantic error colour, never the tenant brand. */
export function ErrorState({
  title = 'Something went wrong',
  children,
  onRetry,
  level,
}: Partial<StateProps> & { onRetry?: () => void; level?: 1 | 2 }) {
  return (
    <StatePanel
      icon={TriangleAlert}
      tone="text-status-error"
      role="alert"
      title={title}
      level={level}
      action={onRetry ? <Button onClick={onRetry}>Try again</Button> : undefined}
    >
      {children ?? <p>Please check your connection and try again.</p>}
    </StatePanel>
  )
}

export function EmptyState({ title, children, action, level }: StateProps & { level?: 1 | 2 }) {
  return (
    <StatePanel
      icon={Inbox}
      tone="text-muted-foreground"
      role="status"
      title={title}
      action={action}
      level={level}
    >
      {children}
    </StatePanel>
  )
}

/** Accessible placeholder for a module that is not built yet. */
export function ComingSoonState({
  title,
  summary,
  level,
}: {
  title: string
  summary: string
  level?: 1 | 2
}) {
  return (
    <StatePanel icon={Construction} tone="text-muted-foreground" role="status" title={title} level={level}>
      <p>{summary}</p>
      <p className="font-medium text-ink">Coming soon</p>
    </StatePanel>
  )
}

/** 403 for a route the user lacks the permission for (UX only; the server denies the data anyway). */
export function ForbiddenState({ homePath }: { homePath: string }) {
  return (
    <StatePanel
      icon={Lock}
      tone="text-status-error"
      role="alert"
      title="Not authorised"
      action={
        <Link to={homePath} className={buttonVariants({ variant: 'outline' })}>
          Back to home
        </Link>
      }
    >
      <p>You do not have permission to view this page. Ask your administrator if you need access.</p>
    </StatePanel>
  )
}

export function NotFoundState({ homePath }: { homePath: string }) {
  return (
    <EmptyState
      title="Page not found"
      action={
        <Link to={homePath} className={buttonVariants({ variant: 'outline' })}>
          Back to home
        </Link>
      }
    >
      <p>This page does not exist or is no longer available.</p>
    </EmptyState>
  )
}
