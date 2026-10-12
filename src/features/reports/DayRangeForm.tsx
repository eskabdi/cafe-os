import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { parseDayRange, type DayRange } from '@/lib/domain/reports'

/** Business-day range picker: two day numbers validated with the Zod range schema (the server re-validates). */
export function DayRangeForm({ onApply }: { onApply: (range: DayRange) => void }) {
  const [fromText, setFromText] = useState('')
  const [toText, setToText] = useState('')
  const [error, setError] = useState<string | null>(null)

  return (
    <form
      aria-label="Business day range"
      className="space-y-2"
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        const r = parseDayRange(fromText, toText)
        if (!r.ok) {
          setError(r.error)
          return
        }
        setError(null)
        onApply(r.range)
      }}
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="rep-from">From day</Label>
          <Input
            id="rep-from"
            inputMode="numeric"
            className="h-11 w-28"
            value={fromText}
            maxLength={6}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'rep-range-error' : undefined}
            onChange={(e) => setFromText(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="rep-to">To day</Label>
          <Input
            id="rep-to"
            inputMode="numeric"
            className="h-11 w-28"
            value={toText}
            maxLength={6}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'rep-range-error' : undefined}
            onChange={(e) => setToText(e.target.value)}
          />
        </div>
        <Button type="submit" className="h-11">
          Show
        </Button>
        <Button
          type="button"
          variant="outline"
          className="h-11"
          onClick={() => {
            setFromText('')
            setToText('')
            setError(null)
            onApply({ from: null, to: null })
          }}
        >
          Current day
        </Button>
      </div>
      {error && (
        <p id="rep-range-error" role="alert" className="text-sm text-status-error">
          {error}
        </p>
      )}
    </form>
  )
}
