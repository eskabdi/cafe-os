import { Navigate } from 'react-router-dom'
import { hostTenantSlug } from '@/features/terminal/terminal-paths'
import { getKioskToken } from '@/lib/utils/kiosk-token'

export function HomePage() {
  // On a tenant subdomain, a device that holds a kiosk token is a terminal: go straight to the tiles.
  const slug = hostTenantSlug()
  if (slug && getKioskToken(slug)) return <Navigate to="/terminal" replace />
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center gap-3 p-6 text-center">
      <h1 className="text-3xl font-bold text-ink">
        Cafe<span className="text-primary">OS</span>
      </h1>
      <p className="text-muted-foreground">
        Restaurant operations platform. Open your restaurant at /r/&lt;slug&gt;.
      </p>
    </main>
  )
}
