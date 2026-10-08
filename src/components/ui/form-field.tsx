import type { ReactNode } from 'react'
import { Label } from './label'

export interface FieldA11y {
  id: string
  'aria-invalid'?: true
  'aria-describedby'?: string
}

/** Label + control + hint + error with the ids wired for assistive tech. The control receives the a11y props. */
export function FormField({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string
  label: string
  hint?: string
  error?: string
  children: (a11y: FieldA11y) => ReactNode
}) {
  const hintId = hint ? `${id}-hint` : undefined
  const errorId = error ? `${id}-error` : undefined
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children({ id, 'aria-invalid': error ? true : undefined, 'aria-describedby': describedBy })}
      {hint && (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-sm font-medium text-status-error">
          {error}
        </p>
      )}
    </div>
  )
}

/** Form-level error (safe fixed copy only). */
export function FormError({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <p
      role="alert"
      className="rounded-md border border-status-error bg-white p-3 text-sm font-medium text-status-error"
    >
      {message}
    </p>
  )
}
