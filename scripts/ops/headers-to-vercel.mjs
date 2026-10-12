#!/usr/bin/env node
// Converts a Netlify/Cloudflare-style `_headers` file (public/_headers, copied to dist/) into a Vercel `vercel.json`, so Vercel
// serves exactly the same security and cache headers. The deploy workflow runs it on dist/ AFTER the CSP is narrowed to the
// project origin, then deploys dist/ as a static directory (dist/vercel.json is that deployment's config).
// Unknown paths are rewritten to /index.html (SPA routing); Vercel serves real files before applying rewrites.
import { readFileSync, writeFileSync } from 'node:fs'

/** `/r/*` -> `/r/(.*)` (path-to-regexp); anything else outside [A-Za-z0-9/_.-] is refused rather than guessed. */
export function toVercelSource(pattern) {
  if (!/^\/[A-Za-z0-9/_.*-]*$/.test(pattern)) throw new Error(`unsupported _headers path: ${pattern}`)
  return pattern.replace(/\./g, '\\.').replace(/\*/g, '(.*)')
}

export function parseHeaders(text) {
  const rules = []
  let current = null
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue
    if (!/^\s/.test(raw)) {
      current = { source: toVercelSource(raw.trim()), headers: [] }
      rules.push(current)
      continue
    }
    if (!current) throw new Error(`header line before any path: ${raw}`)
    const i = raw.indexOf(':')
    if (i < 1) throw new Error(`malformed header line: ${raw}`)
    current.headers.push({ key: raw.slice(0, i).trim(), value: raw.slice(i + 1).trim() })
  }
  return rules.filter((r) => r.headers.length > 0)
}

export function toVercelConfig(text) {
  return {
    $schema: 'https://openapi.vercel.sh/vercel.json',
    cleanUrls: false,
    trailingSlash: false,
    headers: parseHeaders(text),
    rewrites: [{ source: '/(.*)', destination: '/index.html' }],
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [input = 'dist/_headers', output = 'dist/vercel.json'] = process.argv.slice(2)
  writeFileSync(output, `${JSON.stringify(toVercelConfig(readFileSync(input, 'utf8')), null, 2)}\n`)
  console.log(`wrote ${output}`)
}
