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
  parseCustomRange,
  PERIOD_KINDS,
  periodLabel,
  shiftPeriod,
  type Period,
  type PeriodKind,
} from '@/lib/domain/reports-period'

const KIND_LABEL: Record<PeriodKind, string> = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', custom: 'Custom' }

function CustomRangeForm({ value, onApply }: { value: { from: string; to: string }; onApply: (p: Period) => void }) {
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
        <Input id="rep-custom-from" type="date" className="w-44" value={from} aria-describedby={described} onChange={(e) => setFrom(e.target.value)} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="rep-custom-to">To</Label>
        <Input id="rep-custom-to" type="date" className="w-44" value={to} aria-describedby={described} onChange={(e) => setTo(e.target.value)} />
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

function MonthFields({ year, month, onChange }: { year: number; month: number; onChange: (p: Period) => void }) {
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
          min={1990}
          max={2100}
          className="w-28"
          value={year}
          onChange={(e) => {
            const y = Number(e.target.value)
            if (Number.isInteger(y) && y >= 1990 && y <= 2100) onChange({ kind: 'monthly', year: y, month })
          }}
        />
      </div>
    </div>
  )
}

/**
 * Daily (a date), Weekly (Monday–Sunday containing a date), Monthly (an Ethiopian month, Pagume included) or Custom (at
 * most 366 days). The label shows the Ethiopian date first, the Gregorian dates second; prev / next move one period.
 */
export function PeriodPicker({ value, today, onChange }: { value: Period; today: string; onChange: (p: Period) => void }) {
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
            onChange={(e) => isIsoDate(e.target.value) && onChange({ kind: value.kind, date: e.target.value })}
          />
        </div>
      )}
      {value.kind === 'monthly' && <MonthFields year={value.year} month={value.month} onChange={onChange} />}
      {value.kind === 'custom' && <CustomRangeForm key={`${value.from}_${value.to}`} value={value} onApply={onChange} />}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" size="icon" aria-label="Previous period" onClick={() => onChange(shiftPeriod(value, -1))}>
          <ChevronLeft aria-hidden="true" className="h-5 w-5" />
        </Button>
        <p className="min-w-0" data-testid="period-label" aria-live="polite">
          <span className="block font-medium text-ink font-amharic">{label.ethiopian}</span>
          <span className="block text-sm text-muted-foreground">{label.gregorian}</span>
        </p>
        <Button type="button" variant="outline" size="icon" aria-label="Next period" onClick={() => onChange(shiftPeriod(value, 1))}>
          <ChevronRight aria-hidden="true" className="h-5 w-5" />
        </Button>
      </div>
    </div>
  )
}
