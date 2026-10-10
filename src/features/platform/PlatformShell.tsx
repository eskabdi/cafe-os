import { Suspense, useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { LogOut, Menu, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/features/auth'
import { ShellErrorBoundary } from '@/features/shell/ErrorBoundary'
import { PageSkeleton } from '@/features/shell/states'
import { cn } from '@/lib/utils/cn'
import { PLATFORM_NAV } from './platform-nav'

const focusRing = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
const linkClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    'flex min-h-[44px] items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors',
    focusRing,
    isActive ? 'bg-primary/10 text-primary' : 'text-ink hover:bg-accent',
  )

/** The platform sidebar, generated from PLATFORM_NAV only. */
export function PlatformNav({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav aria-label="Platform" className="p-2">
      <ul className="space-y-1">
        {PLATFORM_NAV.map((n) => (
          <li key={n.id}>
            <NavLink to={n.path} end={n.end} className={linkClass} onClick={onNavigate}>
              <n.icon aria-hidden="true" className="h-5 w-5 shrink-0" />
              {n.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  )
}

function MobileNav() {
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
            <DialogPrimitive.Title className="text-base font-semibold text-ink">Navigation</DialogPrimitive.Title>
            <DialogPrimitive.Close asChild>
              <Button variant="ghost" size="icon" aria-label="Close navigation">
                <X aria-hidden="true" className="h-5 w-5" />
              </Button>
            </DialogPrimitive.Close>
          </div>
          <PlatformNav onNavigate={() => setOpen(false)} />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

/**
 * Platform Admin Portal layout (actor "Super Admin"). Separate from the tenant AppShell: own header, own sidebar, CafeOS
 * default branding (no tenant theme), no station provider and no tenant data source.
 */
export function PlatformShell() {
  const { signOut } = useAuth()
  const { pathname } = useLocation()
  return (
    <div className="min-h-screen bg-background [--shell-header-h:53px]" data-portal="platform">
      <a
        href="#main-content"
        className={`sr-only z-[60] rounded-md bg-white px-4 py-3 text-ink focus:not-sr-only focus:fixed focus:left-2 focus:top-2 ${focusRing}`}
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-40 border-b border-line bg-white">
        <div className="flex items-center gap-2 px-2 py-1 lg:px-4">
          <MobileNav />
          <Link to="/platform" className={`inline-flex min-h-[44px] items-center text-lg font-bold text-ink ${focusRing}`}>
            Cafe<span className="text-primary">OS</span>
          </Link>
          <span className="ml-2 rounded-pill border border-line px-2.5 py-0.5 text-xs font-semibold text-ink">Platform admin</span>
          <div className="ml-auto flex items-center gap-2">
            <span className="hidden text-sm font-medium text-ink md:block" data-testid="platform-actor">
              Super Admin
            </span>
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
          <PlatformNav />
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
  )
}
