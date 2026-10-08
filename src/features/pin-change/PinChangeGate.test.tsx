import { act, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthValue } from '@/features/auth/useAuth'
import { TenantShell } from '@/features/tenant/TenantShell'
import type { SessionContext } from '@/lib/supabase/rpc'
import { PinChangeGate } from './PinChangeGate'
import { pinGateTarget } from './pin-paths'

vi.mock('@/lib/supabase/client', () => ({ supabase: {} }))
vi.mock('@/lib/supabase/pin-change', () => ({ changePin: vi.fn() }))
vi.mock('@/lib/supabase/rpc', () => ({ listPendingPinChanges: vi.fn().mockResolvedValue([]) }))

// imported after the mocks
const { ChangePinPage } = await import('./ChangePinPage')
const { PinPendingPage } = await import('./PinPendingPage')

type Status = 'none' | 'required' | 'pending_approval'

function ctx(status: Status | undefined, perms: string[] = []): SessionContext {
  return {
    user: { id: 'u-1', first_name: 'Abebe', short_name: 'Abebe Kebede', username: 'abebe' },
    restaurant: { id: 'r-1', name: 'Demo', slug: 'demo-cafe', status: 'active' },
    role: { id: 'role-1', name: 'Some Role', system_key: null, is_active: true },
    permissions: perms,
    station_ids: [],
    ...(status
      ? { pin_change_status: status, must_change_pin: status === 'required', pin_length: 4 as const }
      : {}),
  }
}

function auth(context: SessionContext): AuthValue {
  return {
    status: 'authenticated',
    session: null,
    context,
    contextStatus: 'ready',
    can: (p) => context.permissions.includes(p),
    signOut: vi.fn().mockResolvedValue(undefined),
    refreshContext: vi.fn(),
  }
}

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>
}

function tree(value: AuthValue, client: QueryClient, path: string) {
  return (
    <AuthContext.Provider value={value}>
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <Where />
          <Routes>
            <Route path="/r/:slug" element={<PinChangeGate />}>
              <Route element={<TenantShell />}>
                <Route path="change-pin" element={<ChangePinPage />} />
                <Route path="pin-pending" element={<PinPendingPage />} />
                <Route path="settings/pin-approvals" element={<p>approvals page</p>} />
                <Route index element={<p>home page</p>} />
                <Route path="*" element={<p>other page</p>} />
              </Route>
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </AuthContext.Provider>
  )
}

function renderAt(path: string, context: SessionContext) {
  const client = new QueryClient()
  const view = render(tree(auth(context), client, path))
  return { ...view, rerenderWith: (c: SessionContext) => view.rerender(tree(auth(c), client, path)) }
}

const where = () => screen.getByTestId('where').textContent

describe('pinGateTarget', () => {
  it('routes per status', () => {
    expect(pinGateTarget('required', '/r/a/orders', 'a')).toBe('/r/a/change-pin')
    expect(pinGateTarget('required', '/r/a/change-pin/', 'a')).toBeNull()
    expect(pinGateTarget('required', '/r/a/pin-pending', 'a')).toBe('/r/a/change-pin')
    expect(pinGateTarget('pending_approval', '/r/a', 'a')).toBe('/r/a/pin-pending')
    expect(pinGateTarget('pending_approval', '/r/a/change-pin', 'a')).toBe('/r/a/pin-pending')
    expect(pinGateTarget('pending_approval', '/r/a/pin-pending', 'a')).toBeNull()
    expect(pinGateTarget('none', '/r/a/change-pin', 'a')).toBe('/r/a')
    expect(pinGateTarget('none', '/r/a/pin-pending', 'a')).toBe('/r/a')
    expect(pinGateTarget('none', '/r/a/settings/terminals', 'a')).toBeNull()
  })
})

describe('PinChangeGate', () => {
  it('required: every tenant route lands on Change PIN, with the persistent header button', () => {
    for (const path of ['/r/demo-cafe', '/r/demo-cafe/orders', '/r/demo-cafe/settings/pin-approvals']) {
      const { unmount } = renderAt(path, ctx('required'))
      expect(where()).toBe('/r/demo-cafe/change-pin')
      expect(screen.getByRole('heading', { level: 1, name: 'Change your PIN' })).toBeInTheDocument()
      expect(screen.getByRole('link', { name: 'Change PIN' })).toHaveAttribute(
        'href',
        '/r/demo-cafe/change-pin',
      )
      expect(screen.queryByText('approvals page')).toBeNull()
      unmount()
    }
  })

  it('pending_approval: every tenant route lands on the waiting screen', () => {
    for (const path of ['/r/demo-cafe', '/r/demo-cafe/change-pin', '/r/demo-cafe/settings/terminals']) {
      const { unmount } = renderAt(path, ctx('pending_approval'))
      expect(where()).toBe('/r/demo-cafe/pin-pending')
      expect(screen.getByRole('heading', { name: 'Waiting for manager approval' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument()
      expect(screen.queryByRole('link', { name: 'Change PIN' })).toBeNull()
      unmount()
    }
  })

  it('none (or a context without the fields): routes render, forced screens bounce home', () => {
    renderAt('/r/demo-cafe/orders', ctx('none')).unmount()
    renderAt('/r/demo-cafe/orders', ctx(undefined))
    expect(where()).toBe('/r/demo-cafe/orders')
    expect(screen.getByText('other page')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Change PIN' })).toBeNull()
  })

  it('none: the forced screens redirect to the tenant home', () => {
    renderAt('/r/demo-cafe/pin-pending', ctx('none'))
    expect(where()).toBe('/r/demo-cafe')
    expect(screen.getByText('home page')).toBeInTheDocument()
  })

  it('uses the identity slug, never the URL slug', () => {
    renderAt('/r/other-cafe/orders', ctx('required'))
    expect(where()).toBe('/r/demo-cafe/change-pin')
  })

  it('shows PIN approvals in the header only to users.manage holders without a restriction', () => {
    const { unmount } = renderAt('/r/demo-cafe', ctx('none', ['users.manage']))
    expect(screen.getByRole('link', { name: 'PIN approvals' })).toHaveAttribute(
      'href',
      '/r/demo-cafe/settings/pin-approvals',
    )
    unmount()
    renderAt('/r/demo-cafe', ctx('none', []))
    expect(screen.queryByRole('link', { name: 'PIN approvals' })).toBeNull()
  })

  it('live: pending -> none goes home, pending -> required goes to Change PIN with a neutral explanation', () => {
    const view = renderAt('/r/demo-cafe/pin-pending', ctx('pending_approval'))
    expect(where()).toBe('/r/demo-cafe/pin-pending')
    act(() => view.rerenderWith(ctx('required')))
    expect(where()).toBe('/r/demo-cafe/change-pin')
    expect(
      screen.getByText('Your manager did not approve your new PIN. Please choose a different PIN.'),
    ).toBeInTheDocument()
    view.unmount()

    const approved = renderAt('/r/demo-cafe/pin-pending', ctx('pending_approval'))
    act(() => approved.rerenderWith(ctx('none')))
    expect(where()).toBe('/r/demo-cafe')
    expect(screen.getByText('home page')).toBeInTheDocument()
  })

  it('a plain required state (no rejection) shows no rejection note', () => {
    renderAt('/r/demo-cafe', ctx('required'))
    expect(screen.queryByText(/did not approve/)).toBeNull()
  })
})
