export interface Violation {
  file: string
  line: number
  rule: string
  message: string
  match: string
}
export const LOCAL_STORAGE_ALLOWLIST: string[]
export interface AllowEntry {
  file: string
  rule: string
  match?: string
  reason: string
}
export const SYSTEM_ROLE_LITERALS: string[]
export const DOMAIN_NAMES: Record<string, string[]>
export function seedRegions(raw: string): Array<[number, number]>
export function scanText(file: string, text: string, allow?: AllowEntry[]): Violation[]
export function scanRepo(root: string): { violations: Violation[]; scanned: number }
