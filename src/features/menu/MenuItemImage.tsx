import { UtensilsCrossed } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { useMenuImageUrl } from './useMenu'

/** Item thumbnail: the private image through a short-lived signed URL, else the emoji, else a neutral icon. */
export function MenuItemImage({
  path,
  emoji,
  className,
}: {
  path?: string | null
  emoji?: string | null
  className?: string
}) {
  const url = useMenuImageUrl(path)
  const box = cn(
    'flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted',
    className,
  )
  if (path && url.data) {
    return (
      <span className={box}>
        <img src={url.data} alt="" className="h-full w-full object-cover" loading="lazy" decoding="async" />
      </span>
    )
  }
  return (
    <span className={box} aria-hidden="true">
      {emoji ? (
        <span className="text-3xl leading-none">{emoji}</span>
      ) : (
        <UtensilsCrossed className="h-6 w-6 text-muted-foreground" />
      )}
    </span>
  )
}
