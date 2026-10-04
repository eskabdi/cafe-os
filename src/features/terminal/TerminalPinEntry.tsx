import { useState } from 'react'
import { AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { PinPad } from '@/features/auth/PinPad'
import { pinLoginTile } from '@/lib/supabase/pin-login'
import { TILE_LOGIN_MESSAGES } from '@/lib/supabase/tile-login-messages'
import type { RosterTile } from '@/lib/supabase/staff-roster'
import { useIdleTimeout } from './useIdleTimeout'

/** Floor PINs are exactly 4 digits (the roster only lists 4-digit staff). */
export const TERMINAL_PIN_LENGTH = 4
/** A pad left untouched this long returns to the tile grid and forgets any digits. */
export const TERMINAL_IDLE_MS = 60_000

export interface TerminalPinEntryProps {
  slug: string
  kioskToken: string
  tile: RosterTile
  onCancel: () => void
  onSignedIn: () => void
  idleMs?: number
}

/**
 * 4-dot PIN entry for one tile. The PIN lives only in this component's state and is cleared the moment it is submitted.
 * Failure copy is always the generic TILE_LOGIN_MESSAGES text (no lockout counts, no hint whether name or PIN was wrong).
 */
export function TerminalPinEntry({
  slug,
  kioskToken,
  tile,
  onCancel,
  onSignedIn,
  idleMs = TERMINAL_IDLE_MS,
}: TerminalPinEntryProps) {
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useIdleTimeout(!busy, idleMs, onCancel)

  const submit = async () => {
    if (busy || pin.length !== TERMINAL_PIN_LENGTH) return
    const attempt = pin
    setPin('') // never kept longer than the request needs
    setBusy(true)
    setError(null)
    try {
      const result = await pinLoginTile({
        restaurant_slug: slug,
        kiosk_token: kioskToken,
        profile_id: tile.id,
        pin: attempt,
      })
      if (result.ok) onSignedIn()
      else setError(TILE_LOGIN_MESSAGES[result.reason])
    } catch {
      setError(TILE_LOGIN_MESSAGES.server_error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      aria-labelledby="terminal-pin-title"
      className="mx-auto w-full max-w-xs space-y-4 rounded-card border border-line bg-white p-5 shadow-sm"
    >
      <h2 id="terminal-pin-title" className="text-center text-lg font-semibold text-ink">
        Enter your PIN
      </h2>
      <PinPad
        value={pin}
        onChange={(next) => {
          setPin(next)
          if (error) setError(null)
        }}
        onSubmit={() => void submit()}
        fixedLength={TERMINAL_PIN_LENGTH}
        disabled={busy}
        label={`PIN keypad for ${tile.name}`}
      />
      <div className="min-h-[2.5rem]">
        {error && (
          <p
            role="alert"
            className="flex items-start justify-center gap-2 text-center text-sm font-medium text-status-error"
          >
            <AlertCircle size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </p>
        )}
        {busy && (
          <p role="status" className="text-center text-sm text-muted-foreground">
            Signing in…
          </p>
        )}
      </div>
      <Button variant="ghost" className="w-full" disabled={busy} onClick={onCancel}>
        Not you?
      </Button>
    </section>
  )
}
