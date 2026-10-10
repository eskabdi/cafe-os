import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { FormError, FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/select'

export const reasonSchema = z
  .string()
  .trim()
  .min(3, 'Enter a reason of 3 to 500 characters.')
  .max(500, 'Enter a reason of 3 to 500 characters.')

/**
 * Confirmation for a sensitive platform / tenant action that needs an audited reason, optionally a typed confirmation (e.g. the
 * tenant slug before a terminal cancellation). Extra fields (a plan or status picker) go in `children`. `error` is safe fixed
 * copy. The server re-validates everything (reason 3..500, confirm slug equality).
 */
export function ReasonDialog({
  open,
  title,
  description,
  confirmLabel,
  busy,
  error,
  confirmText,
  confirmTextLabel,
  destructive,
  children,
  canSubmit = true,
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: string
  description: ReactNode
  confirmLabel: string
  busy?: boolean
  error?: string | null
  /** When set, the user must type exactly this text to enable the action. */
  confirmText?: string
  confirmTextLabel?: string
  destructive?: boolean
  children?: ReactNode
  canSubmit?: boolean
  onConfirm: (reason: string, typed: string) => void
  onCancel: () => void
}) {
  const [reason, setReason] = useState('')
  const [typed, setTyped] = useState('')
  const [reasonError, setReasonError] = useState<string | undefined>()

  useEffect(() => {
    if (open) {
      setReason('')
      setTyped('')
      setReasonError(undefined)
    }
  }, [open])

  const typedOk = confirmText === undefined || typed.trim() === confirmText
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    const parsed = reasonSchema.safeParse(reason)
    if (!parsed.success) {
      setReasonError(parsed.error.issues[0]?.message)
      return
    }
    setReasonError(undefined)
    if (!typedOk || !canSubmit) return
    onConfirm(parsed.data, typed.trim())
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && onCancel()}>
      <DialogContent>
        <form onSubmit={submit} noValidate className="space-y-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          {children}
          <FormField id="action-reason" label="Reason (recorded in the audit log)" error={reasonError}>
            {(a11y) => (
              <Textarea {...a11y} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
            )}
          </FormField>
          {confirmText !== undefined && (
            <FormField id="action-confirm" label={confirmTextLabel ?? `Type ${confirmText} to confirm`}>
              {(a11y) => (
                <Input {...a11y} value={typed} autoComplete="off" onChange={(e) => setTyped(e.target.value)} />
              )}
            </FormField>
          )}
          <FormError message={error ?? null} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={busy || !typedOk || !canSubmit}
              className={destructive ? 'bg-status-error text-white hover:bg-status-error/90' : undefined}
            >
              {busy ? 'Working…' : confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
