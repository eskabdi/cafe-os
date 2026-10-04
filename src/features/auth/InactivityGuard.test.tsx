import { act, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearKioskToken, setKioskToken } from '@/lib/utils/kiosk-token'
import { InactivityGuard } from './InactivityGuard'
import { AuthContext, type AuthValue } from './useAuth'

vi.mock('@/lib/supabase/client', () => ({ supabase: {} }))

class FakeChannel {
  static all: FakeChannel[] = []
  onmessage: ((e: { data: unknown }) => void) | null = null
  closed = false
  constructor(public name: string) {
    FakeChannel.all.push(this)
  }
  postMessage(data: unknown) {
    for (const c of FakeChannel.all) if (c !== this && !c.closed) c.onmessage?.({ data })
  }
  close() {
    this.closed = true
  }
}

const TOKEN = '12'.repeat(32)
const signOut = vi.fn()

function value(
  over: Partial<AuthValue['context'] & object> = {},
  status: AuthValue['status'] = 'authenticated',
): AuthValue {
  return {
    status,
    session: null,
    context: {
      user: { id: 'u', first_name: 'A', username: 'a' },
      role: { id: 'r', name: 'Whatever', system_key: null, is_active: true },
      restaurant: { id: 'x', name: 'Demo', slug: 'demo-cafe', status: 'active' },
      permissions: [],
      station_ids: [],
      ...over,
    },
    contextStatus: 'ready',
    can: () => false,
    signOut,
    refreshContext: () => {},
  }
}

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>
}

let client: QueryClient
function renderGuard(v: AuthValue = value()) {
  client = new QueryClient()
  render(
    <AuthContext.Provider value={v}>
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/r/demo-cafe']}>
          <Where />
          <InactivityGuard />
          <Routes>
            <Route path="*" element={<p>app</p>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </AuthContext.Provider>,
  )
}

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })

beforeEach(() => {
  vi.useFakeTimers()
  FakeChannel.all = []
  vi.stubGlobal('BroadcastChannel', FakeChannel)
  signOut.mockReset().mockResolvedValue(undefined)
  clearKioskToken('demo-cafe')
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  clearKioskToken('demo-cafe')
})

describe('InactivityGuard', () => {
  it('follows the tenant session_timers from the context (warning at 10 s, sign-out at 25 s)', async () => {
    renderGuard(
      value({ session_timers: { idle_warning_seconds: 10, signout_seconds: 25, pin_pad_idle_seconds: 60 } }),
    )
    await advance(9_000)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    await advance(2_000)
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    await advance(12_000)
    expect(signOut).not.toHaveBeenCalled()
    await advance(3_000)
    expect(signOut).toHaveBeenCalledTimes(1)
  })

  it.each(['required', 'pending_approval'] as const)(
    'still signs out a user on the forced PIN screens (status %s)',
    async (status) => {
      renderGuard(
        value({ pin_change_status: status, must_change_pin: status === 'required', permissions: [] }),
      )
      await advance(16_000)
      expect(screen.getByRole('alertdialog')).toBeInTheDocument()
      await advance(15_000)
      expect(signOut).toHaveBeenCalledTimes(1)
      expect(screen.getByTestId('where')).toHaveTextContent('/r/demo-cafe/login')
    },
  )

  it('shows nothing before 15s, then a focused alertdialog with a countdown', async () => {
    renderGuard()
    await advance(14_000)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    await advance(2_000)
    const dlg = screen.getByRole('alertdialog')
    expect(dlg).toHaveAccessibleName('Still there?')
    expect(screen.getByRole('button', { name: 'Continue' })).toHaveFocus()
    expect(screen.getByRole('status')).toHaveTextContent(/Signing out in \d+ seconds/)
    await advance(5_000)
    expect(screen.getByRole('status')).toHaveTextContent('Signing out in 9 seconds')
    expect(signOut).not.toHaveBeenCalled()
  })

  it('activity before the warning restarts the countdown', async () => {
    renderGuard()
    await advance(12_000)
    act(() => {
      document.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    })
    await advance(12_000)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    await advance(4_000)
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
  })

  it('Continue resets everything', async () => {
    renderGuard()
    await advance(17_000)
    act(() => screen.getByRole('button', { name: 'Continue' }).click())
    expect(screen.queryByRole('alertdialog')).toBeNull()
    await advance(14_000)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(signOut).not.toHaveBeenCalled()
  })

  it('ambient activity does not dismiss the warning', async () => {
    renderGuard()
    await advance(17_000)
    act(() => {
      document.dispatchEvent(new Event('keydown', { bubbles: true }))
      document.dispatchEvent(new Event('wheel', { bubbles: true }))
    })
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
  })

  it('signs out at 30s total, clears the query cache and goes to the staff login', async () => {
    renderGuard()
    client.setQueryData(['secret'], 'staff data')
    await advance(31_000)
    expect(signOut).toHaveBeenCalledTimes(1)
    expect(client.getQueryData(['secret'])).toBeUndefined()
    expect(screen.getByTestId('where')).toHaveTextContent('/r/demo-cafe/login')
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('goes to the terminal when the device holds a kiosk token', async () => {
    setKioskToken('demo-cafe', TOKEN)
    renderGuard()
    await advance(31_000)
    expect(signOut).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('where')).toHaveTextContent('/r/demo-cafe/terminal')
  })

  it('the Sign out button signs out immediately', async () => {
    renderGuard()
    await advance(17_000)
    await act(async () => screen.getByRole('button', { name: 'Sign out' }).click())
    expect(signOut).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('where')).toHaveTextContent('/login')
  })

  it('signs out on the first tick after a long sleep (wall clock jumped)', async () => {
    renderGuard()
    vi.setSystemTime(Date.now() + 3_600_000) // device slept; timers did not run
    await advance(1_000)
    expect(signOut).toHaveBeenCalledTimes(1)
  })

  it('a visibility return after the deadline signs out instead of counting as activity', async () => {
    renderGuard()
    vi.setSystemTime(Date.now() + 3_600_000)
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await advance(0)
    expect(signOut).toHaveBeenCalledTimes(1)
  })

  it('a visibility return before the deadline counts as activity', async () => {
    renderGuard()
    await advance(12_000)
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await advance(12_000)
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it.each([
    [
      'tenant_admin',
      { role: { id: 'r', name: 'Administrator', system_key: 'tenant_admin', is_active: true } },
    ],
    ['platform admin', { platform_role: 'platform_super_admin' }],
  ])('exempts %s', async (_n, over) => {
    renderGuard(value(over))
    await advance(10 * 60_000)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(signOut).not.toHaveBeenCalled()
  })

  it('does nothing for a signed-out visitor', async () => {
    renderGuard({ ...value(), status: 'signed_out', context: null })
    await advance(10 * 60_000)
    expect(signOut).not.toHaveBeenCalled()
  })

  it('does not interrupt an in-flight mutation', async () => {
    renderGuard()
    let release!: () => void
    const p = new Promise<void>((r) => (release = r))
    const { MutationObserver } = await import('@tanstack/react-query')
    const obs = new MutationObserver(client, { mutationFn: () => p })
    await act(async () => {
      void obs.mutate()
    })
    await advance(10) // let React flush the mutation count into the guard
    for (let i = 0; i < 12; i++) await advance(10_000)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(signOut).not.toHaveBeenCalled()
    release()
    await advance(0)
    await advance(17_000)
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
  })

  it('cross-tab: activity elsewhere resets, a sign-out elsewhere signs this tab out', async () => {
    renderGuard()
    const other = new FakeChannel('cafeos-session')
    await advance(17_000)
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    act(() => other.postMessage({ type: 'activity' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    await act(async () => other.postMessage({ type: 'signout' }))
    expect(signOut).toHaveBeenCalledTimes(1)
  })

  it('broadcasts its own sign-out and survives a missing BroadcastChannel', async () => {
    renderGuard()
    const other = new FakeChannel('cafeos-session')
    const got = vi.fn()
    other.onmessage = (e) => got(e.data)
    await advance(31_000)
    expect(got).toHaveBeenCalledWith({ type: 'signout' })
  })

  it('works without BroadcastChannel and removes its listeners on unmount', async () => {
    vi.stubGlobal('BroadcastChannel', undefined)
    const remove = vi.spyOn(document, 'removeEventListener')
    renderGuard()
    await advance(31_000)
    expect(signOut).toHaveBeenCalledTimes(1)
    remove.mockRestore()
  })
})
