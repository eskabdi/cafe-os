import { render, screen, waitFor, act } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider } from './AuthProvider'
import { useAuth } from './useAuth'

const h = vi.hoisted(() => ({
  listener: null as null | ((event: string, session: unknown) => void),
  unsubscribe: vi.fn(),
  getSessionContext: vi.fn(),
}))
vi.mock('@/lib/supabase/client', () => ({
  supabase: {
    auth: {
      onAuthStateChange: (cb: (event: string, session: unknown) => void) => {
        h.listener = cb
        return { data: { subscription: { unsubscribe: h.unsubscribe } } }
      },
      signOut: vi.fn(),
    },
  },
}))
vi.mock('@/lib/supabase/rpc', () => ({ getSessionContext: h.getSessionContext }))

function Probe() {
  const a = useAuth()
  return (
    <div>
      <p data-testid="status">{a.status}</p>
      <p data-testid="ctx">{a.contextStatus}</p>
      <p data-testid="role">{a.context?.role?.name ?? 'none'}</p>
      <p data-testid="can">{String(a.can('orders.view'))}</p>
    </div>
  )
}

const session = { user: { id: 'u1' }, access_token: 'a' }

describe('AuthProvider', () => {
  beforeEach(() => {
    h.listener = null
    h.unsubscribe.mockReset()
    h.getSessionContext.mockReset()
  })

  it('goes signed_out on an empty initial session', async () => {
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    )
    expect(screen.getByTestId('status')).toHaveTextContent('loading')
    act(() => h.listener?.('INITIAL_SESSION', null))
    expect(screen.getByTestId('status')).toHaveTextContent('signed_out')
    expect(h.getSessionContext).not.toHaveBeenCalled()
  })

  it('loads server-derived context after sign-in and clears it on sign-out', async () => {
    h.getSessionContext.mockResolvedValue({
      role: { id: 'r', name: 'Waiter', is_active: true },
      permissions: ['orders.view'],
      station_ids: [],
    })
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    )
    act(() => h.listener?.('SIGNED_IN', session))
    expect(screen.getByTestId('ctx')).toHaveTextContent('loading')
    await waitFor(() => expect(screen.getByTestId('ctx')).toHaveTextContent('ready'))
    expect(screen.getByTestId('role')).toHaveTextContent('Waiter')
    expect(screen.getByTestId('can')).toHaveTextContent('true')

    // a token refresh for the same user must not reload the context
    act(() => h.listener?.('TOKEN_REFRESHED', { ...session, access_token: 'b' }))
    expect(h.getSessionContext).toHaveBeenCalledTimes(1)

    act(() => h.listener?.('SIGNED_OUT', null))
    expect(screen.getByTestId('status')).toHaveTextContent('signed_out')
    expect(screen.getByTestId('role')).toHaveTextContent('none')
    expect(screen.getByTestId('can')).toHaveTextContent('false')
  })

  it('reports a context error without granting anything', async () => {
    h.getSessionContext.mockRejectedValue(new Error('x'))
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    )
    act(() => h.listener?.('SIGNED_IN', session))
    await waitFor(() => expect(screen.getByTestId('ctx')).toHaveTextContent('error'))
    expect(screen.getByTestId('can')).toHaveTextContent('false')
  })

  it('unsubscribes on unmount', () => {
    const { unmount } = render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    )
    unmount()
    expect(h.unsubscribe).toHaveBeenCalled()
  })
})
