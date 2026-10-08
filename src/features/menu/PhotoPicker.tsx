import { useEffect, useRef, useState } from 'react'
import { ImagePlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { checkMenuImage } from '@/lib/domain/inventory'
import { MenuItemImage } from './MenuItemImage'

/** What the form should do with the photo on save. */
export type PhotoChoice = { kind: 'keep' } | { kind: 'remove' } | { kind: 'new'; file: File }

/**
 * Visible photo control for a menu item: current photo (signed URL) or a local preview of the picked file (a blob: object URL,
 * never base64), with Choose / Replace / Remove. Pre-checks png / jpeg / webp and 2 MiB; the upload re-checks magic bytes and the
 * bucket and RPC re-validate server-side.
 */
export function PhotoPicker({
  currentPath,
  emoji,
  choice,
  onChange,
  disabled,
}: {
  currentPath: string | null
  emoji?: string | null
  choice: PhotoChoice
  onChange: (c: PhotoChoice) => void
  disabled?: boolean
}) {
  const input = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const file = choice.kind === 'new' ? choice.file : null

  useEffect(() => {
    if (!file || typeof URL.createObjectURL !== 'function') {
      setPreview(null)
      return
    }
    let url: string | null = null
    try {
      url = URL.createObjectURL(file)
    } catch {
      url = null // no preview available; the file name is still shown
    }
    setPreview(url)
    return () => {
      if (url) URL.revokeObjectURL(url)
    }
  }, [file])

  const pick = (f: File | null) => {
    setError(null)
    if (!f) return
    const check = checkMenuImage(f)
    if (!check.ok) {
      setError(
        check.reason === 'size' ? 'The photo is larger than 2 MB.' : 'Choose a PNG, JPEG or WebP photo.',
      )
      if (input.current) input.current.value = ''
      return
    }
    onChange({ kind: 'new', file: f })
  }

  const showCurrent = choice.kind === 'keep' && currentPath
  const hasPhoto = Boolean(showCurrent || file)
  return (
    <div className="space-y-2">
      <span id="menu-photo-label" className="text-sm font-medium leading-none">
        Photo (optional)
      </span>
      <div className="flex flex-wrap items-center gap-3">
        <div data-testid="menu-photo-preview">
          {file ? (
            <span className="flex h-20 w-20 items-center justify-center overflow-hidden rounded-md bg-muted">
              {preview ? (
                <img src={preview} alt="Selected photo preview" className="h-full w-full object-cover" />
              ) : (
                <ImagePlus aria-hidden="true" className="h-6 w-6 text-muted-foreground" />
              )}
            </span>
          ) : (
            <MenuItemImage path={showCurrent ? currentPath : null} emoji={emoji} className="h-20 w-20" />
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <input
            ref={input}
            id="menu-photo"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="sr-only"
            aria-labelledby="menu-photo-label"
            aria-describedby="menu-photo-hint"
            disabled={disabled}
            onChange={(ev) => pick(ev.target.files?.[0] ?? null)}
          />
          <Button type="button" variant="outline" disabled={disabled} onClick={() => input.current?.click()}>
            {hasPhoto ? 'Replace photo' : 'Choose photo'}
          </Button>
          {hasPhoto && (
            <Button
              type="button"
              variant="ghost"
              disabled={disabled}
              onClick={() => {
                if (input.current) input.current.value = ''
                onChange(currentPath && file ? { kind: 'keep' } : { kind: 'remove' })
              }}
            >
              {file && currentPath ? 'Keep current photo' : 'Remove photo'}
            </Button>
          )}
          {choice.kind === 'remove' && currentPath && (
            <Button
              type="button"
              variant="ghost"
              disabled={disabled}
              onClick={() => onChange({ kind: 'keep' })}
            >
              Undo remove
            </Button>
          )}
        </div>
      </div>
      <p id="menu-photo-hint" className="text-xs text-muted-foreground">
        {file
          ? `Selected: ${file.name}. `
          : choice.kind === 'remove' && currentPath
            ? 'The photo will be removed on save. '
            : ''}
        PNG, JPEG or WebP, at most 2 MB.
      </p>
      {error && (
        <p role="alert" className="text-sm font-medium text-status-error">
          {error}
        </p>
      )}
    </div>
  )
}
