import { useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/select'
import { ETHIOPIAN_MONTHS } from '@/lib/domain/ethiopian-time'
import {
  defaultPeriod,
  isIsoDate,
  MAX_ETH_YEAR,
  MIN_ETH_YEAR,
  parseCustomRange,
  parseEthiopianYear,
  PERIOD_KINDS,
  periodLabel,
  shiftPeriod,
  type Period,
  type PeriodKind,
} from '@/lib/domain/reports-period'

const KIND_LABEL: Record<PeriodKind, string> = {
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
  custom: 'Custom',
}

function CustomRangeForm({
  value,
  onApply,
}: {
  value: { from: string; to: string }
  onApply: (p: Period) => void
}) {
  const [from, setFrom] = useState(value.from)
  const [to, setTo] = useState(value.to)
  const [error, setError] = useState<string | null>(null)
  const described = error ? 'rep-custom-error' : undefined
  return (
    <form
      aria-label="Custom period"
      noValidate
      className="flex flex-wrap items-end gap-3"
      onSubmit={(e) => {
        e.preventDefault()
        const r = parseCustomRange(from, to)
        if (!r.ok) return setError(r.error)
        setError(null)
        onApply({ kind: 'custom', ...r.range })
      }}
    >
      <div className="space-y-1">
        <Label htmlFor="rep-custom-from">From</Label>
        <Input
          id="rep-custom-from"
          type="date"
          className="w-44"
          value={from}
          aria-describedby={described}
          onChange={(e) => setFrom(e.target.value)}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="rep-custom-to">To</Label>
        <Input
          id="rep-custom-to"
          type="date"
          className="w-44"
          value={to}
          aria-describedby={described}
          onChange={(e) => setTo(e.target.value)}
        />
      </div>
      <Button type="submit">Show</Button>
      {error && (
        <p id="rep-custom-error" role="alert" className="w-full text-sm text-status-error">
          {error}
        </p>
      )}
    </form>
  )
}

function MonthFields({
  year,
  month,
  onChange,
}: {
  year: number
  month: number
  onChange: (p: Period) => void
}) {
  // Local text while typing ("20", "201" are not years yet); a valid year is committed on blur / Enter only, an invalid
  // one shows an error and keeps the current period.
  const [draft, setDraft] = useState(String(year))
  const [invalid, setInvalid] = useState(false)
  const [shownYear, setShownYear] = useState(year)
  if (shownYear !== year) {
    // the period changed from outside (prev / next): show the new year
    setShownYear(year)
    setDraft(String(year))
    setInvalid(false)
  }
  const commit = () => {
    const y = parseEthiopianYear(draft)
    if (y === null) return setInvalid(true)
    setInvalid(false)
    setDraft(String(y))
    if (y !== year) onChange({ kind: 'monthly', year: y, month })
  }
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="space-y-1">
        <Label htmlFor="rep-eth-month">Ethiopian month</Label>
        <NativeSelect
          id="rep-eth-month"
          className="w-44"
          value={month}
          onChange={(e) => onChange({ kind: 'monthly', year, month: Number(e.target.value) })}
        >
          {ETHIOPIAN_MONTHS.map((name, i) => (
            <option key={name} value={i + 1}>
              {i + 1} · {name}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="space-y-1">
        <Label htmlFor="rep-eth-year">Ethiopian year</Label>
        <Input
          id="rep-eth-year"
          type="number"
          inputMode="numeric"
          min={MIN_ETH_YEAR}
          max={MAX_ETH_YEAR}
          className="w-28"
          value={draft}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? 'rep-eth-year-error' : undefined}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commit()
            }
          }}
        />
        {invalid && (
          <p id="rep-eth-year-error" role="alert" className="text-sm text-status-error">
            Enter a year from {MIN_ETH_YEAR} to {MAX_ETH_YEAR}.
          </p>
        )}
      </div>
    </div>
  )
}

/**
 * Daily (a date), Weekly (Monday–Sunday containing a date), Monthly (an Ethiopian month, Pagume included) or Custom (at
 * most 366 days). The label shows the Ethiopian date first, the Gregorian dates second; prev / next move one period.
 */
export function PeriodPicker({
  value,
  today,
  onChange,
}: {
  value: Period
  today: string
  onChange: (p: Period) => void
}) {
  const label = periodLabel(value)
  return (
    <div className="space-y-3 rounded-lg border border-line bg-white p-4 no-print">
      <div role="group" aria-label="Period type" className="flex flex-wrap gap-2">
        {PERIOD_KINDS.map((k) => (
          <Button
            key={k}
            type="button"
            variant={value.kind === k ? 'default' : 'outline'}
            aria-pressed={value.kind === k}
            onClick={() => value.kind !== k && onChange(defaultPeriod(k, today))}
          >
            {KIND_LABEL[k]}
          </Button>
        ))}
      </div>
      {(value.kind === 'daily' || value.kind === 'weekly') && (
        <div className="space-y-1">
          <Label htmlFor="rep-date">{value.kind === 'daily' ? 'Date' : 'A date in the week'}</Label>
          <Input
            id="rep-date"
            type="date"
            className="w-44"
            value={value.date}
            onChange={(e) =>
              isIsoDate(e.target.value) && onChange({ kind: value.kind, date: e.target.value })
            }
          />
        </div>
      )}
      {value.kind === 'monthly' && <MonthFields year={value.year} month={value.month} onChange={onChange} />}
      {value.kind === 'custom' && (
        <CustomRangeForm key={`${value.from}_${value.to}`} value={value} onApply={onChange} />
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="Previous period"
          onClick={() => onChange(shiftPeriod(value, -1))}
        >
          <ChevronLeft aria-hidden="true" className="h-5 w-5" />
        </Button>
        <p className="min-w-0" data-testid="period-label" aria-live="polite">
          <span className="block font-medium text-ink font-amharic">{label.ethiopian}</span>
          <span className="block text-sm text-muted-foreground">{label.gregorian}</span>
        </p>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="Next period"
          onClick={() => onChange(shiftPeriod(value, 1))}
        >
          <ChevronRight aria-hidden="true" className="h-5 w-5" />
        </Button>
      </div>
    </div>
  )
}
