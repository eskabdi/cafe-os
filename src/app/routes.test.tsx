import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createMemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

// Signed-out visitor: Supabase reports INITIAL_SESSION with no session.
vi.mock('@/lib/supabase/client', () => ({
  supabase: {
    auth: {
      onAuthStateChange: (cb: (event: string, session: unknown) => void) => {
        queueMicrotask(() => cb('INITIAL_SESSION', null))
        return { data: { subscription: { unsubscribe: vi.fn() } } }
      },
      signOut: vi.fn(),
    },
  },
}))
vi.mock('@/lib/supabase/rpc', () => ({
  getSessionContext: vi.fn().mockResolvedValue(null),
  isPlatformSuperAdmin: vi.fn().mockResolvedValue(false),
  resolveTenantSlug: vi.fn().mockResolvedValue(null),
}))

import { routes } from './routes'

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return router
}

// Regression: bare `/r/:slug` and `/platform` are index routes and must hit the auth guard,
// not render a blank page (commit 880b6f7).
describe('route guards on index routes (signed out)', () => {
  it('redirects /r/:slug to the slug login', async () => {
    const router = renderAt('/r/demo-cafe')
    await waitFor(() => expect(router.state.location.pathname).toBe('/r/demo-cafe/login'))
    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument()
  })

  it('redirects /r/:slug/anything to the slug login', async () => {
    const router = renderAt('/r/demo-cafe/orders')
    await waitFor(() => expect(router.state.location.pathname).toBe('/r/demo-cafe/login'))
  })

  it('redirects /platform to the platform login', async () => {
    const router = renderAt('/platform')
    await waitFor(() => expect(router.state.location.pathname).toBe('/platform/login'))
  })

  it('redirects /platform/anything to the platform login', async () => {
    const router = renderAt('/platform/tenants')
    await waitFor(() => expect(router.state.location.pathname).toBe('/platform/login'))
  })

  it('does not redirect the public login routes', async () => {
    const router = renderAt('/r/demo-cafe/login')
    await waitFor(() => expect(router.state.location.pathname).toBe('/r/demo-cafe/login'))
  })
})
