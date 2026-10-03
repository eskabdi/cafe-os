import { Button } from '@/components/ui/button'
import { useAuth } from '@/features/auth'

/** Placeholder for the `/platform/*` super-admin surface (rendered behind RequireAuth + RequirePlatformAdmin; Phase 11). */
export default function PlatformRoutes() {
  const { signOut } = useAuth()
  return (
    <main className="mx-auto max-w-xl space-y-3 p-6">
      <h1 className="text-xl font-semibold text-ink">Platform administration</h1>
      <p className="text-muted-foreground">Coming in a later phase.</p>
      <Button variant="outline" onClick={() => void signOut()}>
        Sign out
      </Button>
    </main>
  )
}
