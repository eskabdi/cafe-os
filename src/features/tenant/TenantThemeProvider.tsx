import { useLayoutEffect, type ReactNode } from 'react'
import { BRAND_VARS, brandThemeVars } from '@/lib/domain/theme'

/**
 * Applies a restaurant's branding (primary / accent from the restaurants row, delivered by fn_get_session_context) as CSS
 * custom properties on <html>, so portalled UI (dialogs, toasts) is branded too. Colours are validated as strict #rrggbb and
 * fall back to the CafeOS defaults. Only brand tokens are touched: semantic status colours (--status-*) stay platform-fixed.
 * On unmount (sign-out, leaving the tenant) the overrides are removed and the stylesheet defaults apply again.
 */
export function TenantThemeProvider({ branding, children }: { branding: unknown; children: ReactNode }) {
  const vars = brandThemeVars(branding)
  const signature = BRAND_VARS.map((k) => vars[k]).join('|')

  useLayoutEffect(() => {
    const root = document.documentElement
    const values = signature.split('|')
    BRAND_VARS.forEach((k, i) => root.style.setProperty(k, values[i] ?? ''))
    return () => BRAND_VARS.forEach((k) => root.style.removeProperty(k))
  }, [signature])

  return <>{children}</>
}
