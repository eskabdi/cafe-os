import { useEffect, useRef, type KeyboardEvent } from 'react'
import { Delete } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { PIN_MAX_LENGTH, PIN_MIN_LENGTH } from '@/lib/supabase/pin-login-errors'

export interface PinPadProps {
  value: string
  onChange: (next: string) => void
  /** Called on Enter once at least `minLength` digits are entered. */
  onSubmit?: () => void
  minLength?: number
  maxLength?: number
  disabled?: boolean
  label?: string
}

const DIGIT_ROWS = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
] as const

const KEY_CLASS =
  'flex h-14 min-w-[44px] items-center justify-center rounded-xl border border-line bg-bg text-lg font-bold text-ink ' +
  'transition-colors hover:bg-white active:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 ' +
  'focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-40'

/**
 * Accessible PIN keypad. Controlled and display-only: the digits are never rendered, only a count
 * (dots + a polite live region). Physical keyboard: 0-9, Backspace, Delete/Escape clear, Enter submit.
 */
export function PinPad({
  value,
  onChange,
  onSubmit,
  minLength = PIN_MIN_LENGTH,
  maxLength = PIN_MAX_LENGTH,
  disabled = false,
  label = 'PIN keypad',
}: PinPadProps) {
  const groupRef = useRef<HTMLDivElement>(null)

  // Keep keyboard focus on the pad (initially, and after a busy/disabled period such as a failed attempt).
  useEffect(() => {
    if (!disabled) groupRef.current?.focus()
  }, [disabled])

  const add = (digit: string) => {
    if (disabled || value.length >= maxLength) return
    onChange(value + digit)
  }
  const back = () => !disabled && onChange(value.slice(0, -1))
  const clear = () => !disabled && onChange('')

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled || e.ctrlKey || e.metaKey || e.altKey) return
    if (/^[0-9]$/.test(e.key)) {
      e.preventDefault()
      add(e.key)
    } else if (e.key === 'Backspace') {
      e.preventDefault()
      back()
    } else if (e.key === 'Delete' || e.key === 'Escape') {
      e.preventDefault()
      clear()
    } else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault()
      if (value.length >= minLength) onSubmit?.()
    }
  }

  return (
    <div
      ref={groupRef}
      role="group"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="outline-none"
    >
      <div className="mb-5 flex h-6 items-center justify-center gap-3" aria-hidden="true">
        {Array.from({ length: maxLength }, (_, i) => (
          <span
            key={i}
            className={cn(
              'h-3.5 w-3.5 rounded-full border-2',
              value.length > i ? 'border-primary bg-primary' : 'border-slate-300 bg-white',
            )}
          />
        ))}
      </div>
      <p role="status" aria-live="polite" className="sr-only">
        {value.length} of {maxLength} digits entered
      </p>
      <div className="grid grid-cols-3 gap-2.5">
        {DIGIT_ROWS.flat().map((d) => (
          <button
            key={d}
            type="button"
            className={KEY_CLASS}
            disabled={disabled}
            aria-label={`Digit ${d}`}
            onClick={() => add(d)}
          >
            {d}
          </button>
        ))}
        <button
          type="button"
          className={cn(KEY_CLASS, 'text-xs tracking-wide text-muted-foreground')}
          disabled={disabled}
          aria-label="Clear PIN"
          onClick={clear}
        >
          CLR
        </button>
        <button
          type="button"
          className={KEY_CLASS}
          disabled={disabled}
          aria-label="Digit 0"
          onClick={() => add('0')}
        >
          0
        </button>
        <button
          type="button"
          className={KEY_CLASS}
          disabled={disabled}
          aria-label="Delete last digit"
          onClick={back}
        >
          <Delete size={18} aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}
