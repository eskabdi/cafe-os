import { Link, NavLink, Outlet } from 'react-router-dom'
import { buttonVariants } from '@/components/ui/button'
import { useAuth } from '@/features/auth'
import {
  changePinPath,
  pinApprovalsPath,
  sessionTimersPath,
  tenantHomePath,
} from '@/features/pin-change/pin-paths'
import { pinChangeStatusOf } from '@/lib/domain/pin-change'
import { cn } from '@/lib/utils/cn'

/**
 * Header for every signed-in tenant route. Links are UX only (the server re-authorizes everything):
 *  - "Change PIN" stays visible while the server reports pin_change_status = 'required'
 *  - "PIN approvals" for holders of users.manage, "Session timers" for settings.session_timers (an unrestricted user; a
 *    restricted user holds no permission at all)
 */
export function TenantShell() {
  const { context, can } = useAuth()
  const slug = context?.restaurant?.slug
  if (!slug || !context?.user) return <Outlet />
  const status = pinChangeStatusOf(context)

  return (
    <>
      <header className="border-b border-line bg-white">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2">
          <Link
            to={tenantHomePath(slug)}
            className="inline-flex min-h-[44px] items-center text-lg font-bold text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Cafe<span className="text-primary">OS</span>
          </Link>
          <nav aria-label="Account" className="ml-auto flex flex-wrap items-center gap-2">
            {status === 'required' && (
              <NavLink to={changePinPath(slug)} className={cn(buttonVariants({ variant: 'default' }))}>
                Change PIN
              </NavLink>
            )}
            {status === 'none' && can('users.manage') && (
              <NavLink to={pinApprovalsPath(slug)} className={cn(buttonVariants({ variant: 'ghost' }))}>
                PIN approvals
              </NavLink>
            )}
            {status === 'none' && can('settings.session_timers') && (
              <NavLink to={sessionTimersPath(slug)} className={cn(buttonVariants({ variant: 'ghost' }))}>
                Session timers
              </NavLink>
            )}
          </nav>
        </div>
      </header>
      <Outlet />
    </>
  )
}
