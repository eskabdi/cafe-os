import { Suspense, useState } from 'react'
import { Link, Outlet, useLocation } from 'react-router-dom'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { LogOut, Menu, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/features/auth'
import { tenantHomePath } from '@/features/pin-change/pin-paths'
import { ShellErrorBoundary } from './ErrorBoundary'
import { StationsProvider } from '@/features/stations/StationsProvider'
import { ShellNav } from './ShellNav'
import { PageSkeleton } from './states'

const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'

function Brand({ slug }: { slug: string }) {
  return (
    <Link
      to={tenantHomePath(slug)}
      className={`inline-flex min-h-[44px] items-center text-lg font-bold text-ink ${focusRing}`}
    >
      Cafe<span className="text-primary">OS</span>
    </Link>
  )
}

/** Left drawer with the same generated navigation, for small screens. Radix handles focus trap, Escape and restore. */
function MobileNav({ slug }: { slug: string }) {
  const [open, setOpen] = useState(false)
  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Trigger asChild>
        <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open navigation">
          <Menu aria-hidden="true" className="h-6 w-6" />
        </Button>
      </DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 lg:hidden" />
        <DialogPrimitive.Content
          className="fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col overflow-y-auto bg-white shadow-xl lg:hidden"
          aria-describedby={undefined}
        >
          <div className="flex items-center justify-between border-b border-line px-3">
            <DialogPrimitive.Title className="text-base font-semibold text-ink">
              Navigation
            </DialogPrimitive.Title>
            <DialogPrimitive.Close asChild>
              <Button variant="ghost" size="icon" aria-label="Close navigation">
                <X aria-hidden="true" className="h-5 w-5" />
              </Button>
            </DialogPrimitive.Close>
          </div>
          <ShellNav slug={slug} onNavigate={() => setOpen(false)} />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

/**
 * Responsive tenant shell: sticky header, permission-generated sidebar on large screens, drawer on small screens, and the
 * page inside an error boundary + suspense skeleton. Tenant name and user come from the server-derived session context.
 */
export function AppShell({ slug }: { slug: string }) {
  const { context, signOut } = useAuth()
  const { pathname } = useLocation()
  const user = context?.user
  const displayName = user?.short_name || user?.first_name

  return (
    <StationsProvider>
      <div className="min-h-screen bg-background [--shell-header-h:53px]">
        <a
          href="#main-content"
          className={`sr-only z-[60] rounded-md bg-white px-4 py-3 text-ink focus:not-sr-only focus:fixed focus:left-2 focus:top-2 ${focusRing}`}
        >
          Skip to content
        </a>
        <header className="sticky top-0 z-40 border-b border-line bg-white">
          <div className="flex items-center gap-2 px-2 py-1 lg:px-4">
            <MobileNav slug={slug} />
            <Brand slug={slug} />
            {context?.restaurant && (
              <span
                className="ml-2 hidden truncate text-sm font-medium text-ink sm:inline"
                data-testid="shell-tenant"
              >
                {context.restaurant.name}
              </span>
            )}
            <div className="ml-auto flex items-center gap-2">
              {displayName && (
                <span className="hidden text-right text-sm leading-tight md:block">
                  <span className="block font-medium text-ink">{displayName}</span>
                  {context?.role && (
                    <span className="block text-xs text-muted-foreground">{context.role.name}</span>
                  )}
                </span>
              )}
              <Button variant="ghost" onClick={() => void signOut()}>
                <LogOut aria-hidden="true" className="h-5 w-5" />
                <span className="hidden sm:inline">Sign out</span>
                <span className="sr-only sm:hidden">Sign out</span>
              </Button>
            </div>
          </div>
        </header>
        <div className="flex">
          <aside
            aria-label="Sidebar"
            className="sticky top-[var(--shell-header-h)] hidden h-[calc(100dvh-var(--shell-header-h))] w-64 shrink-0 overflow-y-auto border-r border-line bg-white lg:block"
          >
            <ShellNav slug={slug} />
          </aside>
          <main id="main-content" tabIndex={-1} className="min-w-0 flex-1 focus:outline-none">
            <ShellErrorBoundary resetKey={pathname}>
              <Suspense fallback={<PageSkeleton />}>
                <Outlet />
              </Suspense>
            </ShellErrorBoundary>
          </main>
        </div>
      </div>
    </StationsProvider>
  )
}
