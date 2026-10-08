import { useEffect, useRef, type KeyboardEvent } from 'react'
import { Check } from 'lucide-react'
import type { RosterTile } from '@/lib/supabase/staff-roster'
import { tileStyle } from '@/lib/domain/tile-style'
import { cn } from '@/lib/utils/cn'
import { tileIconFor } from './tile-icons'

export interface StaffTileGridProps {
  tiles: readonly RosterTile[]
  selectedId: string | null
  onSelect: (id: string) => void
  /** When set, that tile receives keyboard focus (used when returning from the PIN pad). */
  focusId?: string | null
}

/**
 * Staff tiles as a radio group. Renders exactly the roster it is given: no filtering, no role-name logic. Colour and
 * icon come from the row (validated hex, allowlisted icon). Arrow keys move focus (roving tabindex); Enter/Space/click
 * select. Targets are >= 44px.
 */
export function StaffTileGrid({ tiles, selectedId, onSelect, focusId = null }: StaffTileGridProps) {
  const refs = useRef(new Map<string, HTMLButtonElement>())

  useEffect(() => {
    if (focusId) refs.current.get(focusId)?.focus()
  }, [focusId])

  const tabbable = tiles.some((t) => t.id === selectedId) ? selectedId : (tiles[0]?.id ?? null)

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const ids = tiles.map((t) => t.id)
    const current = ids.indexOf((document.activeElement as HTMLElement | null)?.dataset.tileId ?? '')
    if (current < 0 || ids.length === 0) return
    let next = current
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (current + 1) % ids.length
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (current - 1 + ids.length) % ids.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = ids.length - 1
    else return
    e.preventDefault()
    const id = ids[next]
    if (id) refs.current.get(id)?.focus()
  }

  return (
    <div
      role="radiogroup"
      aria-label="Who is signing in"
      onKeyDown={onKeyDown}
      className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4"
    >
      {tiles.map((tile) => {
        const checked = tile.id === selectedId
        const style = tileStyle(tile.color)
        const Icon = tileIconFor(tile.icon)
        return (
          <button
            key={tile.id}
            ref={(el) => {
              if (el) refs.current.set(tile.id, el)
              else refs.current.delete(tile.id)
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            data-tile-id={tile.id}
            tabIndex={tile.id === tabbable ? 0 : -1}
            onClick={() => onSelect(tile.id)}
            className={cn(
              'relative flex min-h-[7rem] min-w-[44px] flex-col items-center justify-center gap-2 rounded-card border-2 bg-white p-3 text-center shadow-sm transition-colors',
              'hover:bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
              checked ? 'border-ink' : 'border-line',
            )}
          >
            <span
              aria-hidden="true"
              className="flex h-12 w-12 items-center justify-center rounded-full"
              style={{ backgroundColor: style.background, color: style.foreground }}
            >
              <Icon size={24} />
            </span>
            <span className="block max-w-full break-words text-base font-semibold leading-tight text-ink">
              {tile.name}
            </span>
            <span className="block max-w-full break-words text-sm leading-tight text-muted-foreground">
              {tile.role}
            </span>
            {checked && <Check size={16} aria-hidden="true" className="absolute right-2 top-2 text-ink" />}
          </button>
        )
      })}
    </div>
  )
}
