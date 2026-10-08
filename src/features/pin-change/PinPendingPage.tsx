import { Button } from '@/components/ui/button'
import { useAuth } from '@/features/auth'

/**
 * Route /r/:slug/pin-pending: the new PIN is stored, a tenant admin must approve it. The NotificationsListener refreshes the
 * session context when the approved / rejected notification arrives (Realtime, no polling); PinChangeGate then moves the user
 * on. "Check again" is a user-initiated refresh for a missed event. The inactivity guard still signs the user out here.
 */
export function PinPendingPage() {
  const { context, signOut, refreshContext, contextStatus } = useAuth()
  const name = context?.user?.short_name ?? context?.user?.first_name
  return (
    <main className="mx-auto max-w-md space-y-4 p-6">
      <h1 className="text-xl font-semibold text-ink">Waiting for manager approval</h1>
      <div className="space-y-2 text-sm text-ink">
        {name && <p className="font-medium">{name}</p>}
        <p>
          Your new PIN is saved. A manager needs to approve the change before you can continue. This page
          updates on its own when they decide.
        </p>
        <p className="text-muted-foreground">You can sign out and come back later.</p>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button
          className="flex-1"
          variant="outline"
          onClick={refreshContext}
          disabled={contextStatus === 'loading'}
        >
          Check again
        </Button>
        <Button className="flex-1" onClick={() => void signOut()}>
          Sign out
        </Button>
      </div>
    </main>
  )
}
