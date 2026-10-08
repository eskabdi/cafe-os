/**
 * The ONLY file allowed to touch localStorage (allowlisted in
 * scripts/check-forbidden-patterns.mjs). Per-viewer UI preferences only
 * (e.g. collapsed sidebar). Never domain data, tokens, PINs or tenant data.
 */
export function readUiPref(key: string): string | null {
  try {
    return localStorage.getItem(`cafeos:ui:${key}`)
  } catch {
    return null
  }
}

export function writeUiPref(key: string, value: string): void {
  try {
    localStorage.setItem(`cafeos:ui:${key}`, value)
  } catch {
    // storage unavailable (private mode / blocked): preferences are best-effort
  }
}
