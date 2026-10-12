import { useRef, type KeyboardEvent } from 'react'
import { cn } from '@/lib/utils/cn'
import { REPORT_TYPES, type ReportType } from '@/lib/supabase/reports'
import { REPORT_TITLES } from './report-model'

export const tabId = (t: ReportType) => `rep-tab-${t}`
export const PANEL_ID = 'rep-panel'

/** WAI-ARIA tabs: one tab stop (roving tabindex), arrows / Home / End move and select, 44px targets. */
export function ReportTabs({ value, onChange }: { value: ReportType; onChange: (t: ReportType) => void }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const move = (e: KeyboardEvent, i: number) => {
    const n = REPORT_TYPES.length
    const next = e.key === 'ArrowRight' ? (i + 1) % n : e.key === 'ArrowLeft' ? (i - 1 + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1
    if (next < 0) return
    e.preventDefault()
    const t = REPORT_TYPES[next]
    if (!t) return
    onChange(t)
    refs.current[next]?.focus()
  }
  return (
    <div role="tablist" aria-label="Report type" className="no-print flex gap-1 overflow-x-auto border-b border-line">
      {REPORT_TYPES.map((t, i) => {
        const selected = t === value
        return (
          <button
            key={t}
            ref={(el) => {
              refs.current[i] = el
            }}
            id={tabId(t)}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={PANEL_ID}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(t)}
            onKeyDown={(e) => move(e, i)}
            className={cn(
              'h-11 shrink-0 whitespace-nowrap border-b-2 px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              selected ? 'border-primary text-ink' : 'border-transparent text-muted-foreground hover:text-ink',
            )}
          >
            {REPORT_TITLES[t]}
          </button>
        )
      })}
    </div>
  )
}
