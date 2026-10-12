/// <reference types="vitest/config" />
import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  server: { port: 5173, strictPort: true },
  build: {
    rollupOptions: {
      output: {
        // Phase 11 performance: the always-loaded vendor code gets its own long-cached chunks, so an app deploy does not
        // make every terminal re-download React / Supabase. Only eagerly-needed packages are named here: the lazy
        // chunks (charts, report PDF, KDS) keep their own vendors.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (/node_modules\/(react|react-dom|scheduler|react-router|react-router-dom)\//.test(id))
            return 'vendor-react'
          if (/node_modules\/(@supabase\/[^/]+|iceberg-js)\//.test(id)) return 'vendor-supabase'
          return undefined
        },
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}', 'tests/unit/**/*.test.{ts,tsx}'],
    css: false,
  },
})
