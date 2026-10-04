import { TerminalShell } from './TerminalShell'

/**
 * Neutral screen for a device that is not (or no longer) a registered terminal. It never says why: unknown, revoked,
 * wrong tenant and suspended tenant look identical (kiosk-terminals.md).
 */
export function TerminalUnauthorized({ slug }: { slug: string | null }) {
  return (
    <TerminalShell slug={slug}>
      <section className="mx-auto max-w-md space-y-3 pt-8 text-center">
        <h1 className="text-xl font-semibold text-ink">Terminal not set up</h1>
        <p role="status" className="text-base text-muted-foreground">
          This terminal is not set up. Ask a manager to register it.
        </p>
      </section>
    </TerminalShell>
  )
}
