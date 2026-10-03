export interface Violation {
  file: string
  line: number
  rule: string
  message: string
  match: string
}
export const LOCAL_STORAGE_ALLOWLIST: string[]
export function scanText(file: string, text: string): Violation[]
export function scanRepo(root: string): { violations: Violation[]; scanned: number }
