export interface VercelHeaderRule {
  source: string
  headers: { key: string; value: string }[]
}
export interface VercelConfig {
  $schema: string
  cleanUrls: boolean
  trailingSlash: boolean
  headers: VercelHeaderRule[]
  rewrites: { source: string; destination: string }[]
}
export function toVercelSource(pattern: string): string
export function parseHeaders(text: string): VercelHeaderRule[]
export function toVercelConfig(text: string): VercelConfig
