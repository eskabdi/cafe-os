#!/usr/bin/env node
// Wrapper so `pnpm test -- --run` and `pnpm test -- path/to/file.test.ts` behave as documented.
// pnpm forwards a literal "--" which vitest would treat as a file filter and then hang in watch mode.
import { spawnSync } from 'node:child_process'

const args = process.argv.slice(2).filter((a) => a !== '--')
const result = spawnSync('pnpm', ['exec', 'vitest', ...args], { stdio: 'inherit' })
process.exit(result.status ?? 1)
