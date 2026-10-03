import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { RequireAuth, RequirePermission, RequirePlatformAdmin } from './guards'
import { AuthContext, type AuthValue } from './useAuth'

function value(over: Partial<AuthValue>): AuthValue {
  return {
    status: 'authenticated',
    session: null,
    context: { permissions: ['orders.view'], station_ids: [] },
    contextStatus: 'ready',
    can: (p) => p === 'orders.view',
    signOut: vi.fn().mockResolvedValue(undefined),
    refreshContext: vi.fn(),
    ...over,
  }
}

function renderWith(v: AuthValue, ui: React.ReactNode, path = '/secure') {
  return render(
    <AuthContext.Provider value={v}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/login" element={<p>login page</p>} />
          <Route path="/secure" element={ui} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  )
}

describe('RequireAuth', () => {
  it('shows a loading state while auth or context is loading', () => {
    renderWith(value({ status: 'loading' }), <RequireAuth loginPath="/login">secret</RequireAuth>)
    expect(screen.getByRole('status')).toHaveTextContent('Loading')
    expect(screen.queryByText('secret')).not.toBeInTheDocument()
  })

  it('redirects signed-out users to the login path', () => {
    renderWith(
      value({ status: 'signed_out', context: null, contextStatus: 'idle' }),
      <RequireAuth loginPath="/login">secret</RequireAuth>,
    )
    expect(screen.getByText('login page')).toBeInTheDocument()
    expect(screen.queryByText('secret')).not.toBeInTheDocument()
  })

  it('renders children for a signed-in user with a server context', () => {
    renderWith(value({}), <RequireAuth loginPath="/login">secret</RequireAuth>)
    expect(screen.getByText('secret')).toBeInTheDocument()
  })

  it('blocks a signed-in user with no server context (inactive / suspended tenant)', () => {
    renderWith(value({ context: null }), <RequireAuth loginPath="/login">secret</RequireAuth>)
    expect(screen.getByText('Access unavailable')).toBeInTheDocument()
    expect(screen.queryByText('secret')).not.toBeInTheDocument()
  })

  it('offers retry on a context load error', () => {
    renderWith(
      value({ context: null, contextStatus: 'error' }),
      <RequireAuth loginPath="/login">secret</RequireAuth>,
    )
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })
})

describe('RequirePermission', () => {
  it('renders when the permission is held, otherwise the fallback / notice', () => {
    const { unmount } = renderWith(
      value({}),
      <RequirePermission permission="orders.view">orders</RequirePermission>,
    )
    expect(screen.getByText('orders')).toBeInTheDocument()
    unmount()
    renderWith(value({}), <RequirePermission permission="roles.manage">roles</RequirePermission>)
    expect(screen.queryByText('roles')).not.toBeInTheDocument()
    expect(screen.getByText('Not authorised')).toBeInTheDocument()
  })

  it('uses a custom fallback', () => {
    renderWith(
      value({}),
      <RequirePermission permission="x.y" fallback={<p>nope</p>}>
        hidden
      </RequirePermission>,
    )
    expect(screen.getByText('nope')).toBeInTheDocument()
  })
})

describe('RequirePlatformAdmin', () => {
  it('requires the server-reported platform role', () => {
    const { unmount } = renderWith(value({}), <RequirePlatformAdmin>platform</RequirePlatformAdmin>)
    expect(screen.queryByText('platform')).not.toBeInTheDocument()
    unmount()
    renderWith(
      value({ context: { permissions: [], station_ids: [], platform_role: 'platform_super_admin' } }),
      <RequirePlatformAdmin>platform</RequirePlatformAdmin>,
    )
    expect(screen.getByText('platform')).toBeInTheDocument()
  })
})
