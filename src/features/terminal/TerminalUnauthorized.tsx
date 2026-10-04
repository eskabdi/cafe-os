import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { TerminalShell } from './TerminalShell'

/**
 * Neutral screen for a device that is not (or no longer) a registered terminal. It never says why: unknown, revoked,
 * wrong tenant and suspended tenant look identical (kiosk-terminals.md). The stored token is NOT erased automatically;
 * when one exists the user may remove it explicitly.
 */
export function TerminalUnauthorized({
  slug,
  onRemoveSetup,
}: {
  slug: string | null
  onRemoveSetup?: () => void
}) {
  const [removed, setRemoved] = useState(false)
  return (
    <TerminalShell slug={slug}>
      <section className="mx-auto max-w-md space-y-4 pt-8 text-center">
        <h1 className="text-xl font-semibold text-ink">Terminal not set up</h1>
        <p role="status" className="text-base text-muted-foreground">
          This terminal is not set up. Ask a manager to register it.
        </p>
        {onRemoveSetup && !removed && (
          <Button
            variant="outline"
            onClick={() => {
              onRemoveSetup()
              setRemoved(true)
            }}
          >
            Remove setup from this device
          </Button>
        )}
      </section>
    </TerminalShell>
  )
}
