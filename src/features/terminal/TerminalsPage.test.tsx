import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthValue } from '@/features/auth/useAuth'
import { clearKioskToken, getKioskToken } from '@/lib/utils/kiosk-token'
import { TerminalsPage } from './TerminalsPage'

const h = vi.hoisted(() => ({ listKiosks: vi.fn(), registerKiosk: vi.fn(), revokeKiosk: vi.fn() }))
vi.mock('@/lib/supabase/client', () => ({ supabase: {} }))
vi.mock('@/lib/supabase/rpc', () => {
  class RpcError extends Error {
    readonly code: string
    constructor(code: string) {
      super(code)
      this.code = code
    }
  }
  return { ...h, RpcError }
})

const TOKEN = '0a'.repeat(32)
const KIOSK_ID = '33333333-3333-4333-8333-333333333333'
const kiosk = {
  id: KIOSK_ID,
  name: 'Front counter',
  created_at: '2026-10-03T08:00:00Z',
  last_seen_at: null,
  revoked_at: null,
}

function auth(perms: string[]): AuthValue {
  return {
    status: 'authenticated',
    session: null,
    context: {
      permissions: perms,
      station_ids: [],
      restaurant: { id: 'r', name: 'Demo', slug: 'demo-cafe', status: 'active' },
    },
    contextStatus: 'ready',
    can: (p) => perms.includes(p),
    signOut: async () => {},
    refreshContext: () => {},
  }
}

function renderPage(perms = ['kiosks.manage']) {
  render(
    <AuthContext.Provider value={auth(perms)}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={['/r/demo-cafe/settings/terminals']}>
          <Routes>
            <Route path="/r/:slug/settings/terminals" element={<TerminalsPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </AuthContext.Provider>,
  )
}

beforeEach(() => {
  h.listKiosks.mockReset().mockResolvedValue([kiosk])
  h.registerKiosk.mockReset()
  h.revokeKiosk.mockReset()
  clearKioskToken('demo-cafe')
})
afterEach(() => {
  clearKioskToken('demo-cafe')
})

describe('TerminalsPage', () => {
  it('is hidden without kiosks.manage and calls nothing', () => {
    renderPage([])
    expect(screen.getByText('You do not have permission to view this page.')).toBeInTheDocument()
    expect(h.listKiosks).not.toHaveBeenCalled()
  })

  it('lists terminals from fn_list_kiosks', async () => {
    h.listKiosks.mockResolvedValue([
      kiosk,
      {
        ...kiosk,
        id: '44444444-4444-4444-8444-444444444444',
        name: 'Old',
        revoked_at: '2026-10-02T08:00:00Z',
      },
    ])
    renderPage()
    expect(await screen.findByText('Front counter')).toBeInTheDocument()
    expect(screen.getByText(/Revoked 2026-10-02/)).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /^Revoke / })).toHaveLength(1)
  })

  it('validates the name locally', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByRole('button', { name: 'Register terminal' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a name for the terminal.')
    expect(h.registerKiosk).not.toHaveBeenCalled()
  })

  it('shows the raw token once, can set up this device, and forgets it on dismiss', async () => {
    const user = userEvent.setup()
    h.registerKiosk.mockResolvedValue({ id: KIOSK_ID, name: 'Bar tablet', token: TOKEN })
    renderPage()
    await user.type(await screen.findByLabelText('Terminal name'), '  Bar tablet ')
    await user.click(screen.getByRole('button', { name: 'Register terminal' }))
    expect(await screen.findByTestId('kiosk-token')).toHaveTextContent(TOKEN)
    expect(h.registerKiosk).toHaveBeenCalledWith('Bar tablet')
    await waitFor(() => expect(h.listKiosks).toHaveBeenCalledTimes(2)) // invalidated

    await user.click(screen.getByRole('button', { name: 'Set this device up' }))
    expect(getKioskToken('demo-cafe')).toBe(TOKEN)
    expect(screen.getByText('This browser is set up as a terminal.')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'I have saved it' }))
    expect(screen.queryByTestId('kiosk-token')).toBeNull()
    expect(document.body.textContent).not.toContain(TOKEN)
  })

  it('copies the token to the clipboard', async () => {
    const user = userEvent.setup()
    h.registerKiosk.mockResolvedValue({ id: KIOSK_ID, name: 'X', token: TOKEN })
    renderPage()
    await user.type(await screen.findByLabelText('Terminal name'), 'X')
    await user.click(screen.getByRole('button', { name: 'Register terminal' }))
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await user.click(await screen.findByRole('button', { name: 'Copy code' }))
    expect(writeText).toHaveBeenCalledWith(TOKEN)
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument()
  })

  it('shows a neutral message when step-up is required', async () => {
    const user = userEvent.setup()
    const { RpcError } = await import('@/lib/supabase/rpc')
    h.registerKiosk.mockRejectedValue(new RpcError('mfa_required'))
    renderPage()
    await user.type(await screen.findByLabelText('Terminal name'), 'X')
    await user.click(screen.getByRole('button', { name: 'Register terminal' }))
    const alert = await screen.findByText(/second sign-in step/)
    expect(alert).toHaveAttribute('role', 'alert')
    expect(alert.textContent).not.toMatch(/mfa|aal2/i)
    expect(screen.queryByTestId('kiosk-token')).toBeNull()
  })

  it('revokes only after confirmation', async () => {
    const user = userEvent.setup()
    h.revokeKiosk.mockResolvedValue(undefined)
    renderPage()
    await user.click(await screen.findByRole('button', { name: 'Revoke Front counter' }))
    const dialog = await screen.findByRole('dialog')
    expect(h.revokeKiosk).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(h.revokeKiosk).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Revoke Front counter' }))
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Revoke terminal' }),
    )
    await waitFor(() => expect(h.revokeKiosk).toHaveBeenCalledWith(KIOSK_ID))
    await waitFor(() => expect(h.listKiosks).toHaveBeenCalledTimes(2))
  })

  it('overwrites the clipboard on dismiss after a copy', async () => {
    const user = userEvent.setup()
    h.registerKiosk.mockResolvedValue({ id: KIOSK_ID, name: 'X', token: TOKEN })
    renderPage()
    await user.type(await screen.findByLabelText('Terminal name'), 'X')
    await user.click(screen.getByRole('button', { name: 'Register terminal' }))
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await user.click(await screen.findByRole('button', { name: 'Copy code' }))
    await user.click(screen.getByRole('button', { name: 'I have saved it' }))
    expect(writeText).toHaveBeenLastCalledWith('')
    expect(screen.queryByTestId('kiosk-token')).toBeNull()
  })

  it('never throws when the clipboard cannot be overwritten', async () => {
    const user = userEvent.setup()
    h.registerKiosk.mockResolvedValue({ id: KIOSK_ID, name: 'X', token: TOKEN })
    renderPage()
    await user.type(await screen.findByLabelText('Terminal name'), 'X')
    await user.click(screen.getByRole('button', { name: 'Register terminal' }))
    const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(new Error('denied'))
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await user.click(await screen.findByRole('button', { name: 'Copy code' }))
    await user.click(screen.getByRole('button', { name: 'I have saved it' }))
    expect(screen.queryByTestId('kiosk-token')).toBeNull()
  })

  it('auto-hides the token after 3 minutes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
      h.registerKiosk.mockResolvedValue({ id: KIOSK_ID, name: 'X', token: TOKEN })
      renderPage()
      await user.type(await screen.findByLabelText('Terminal name'), 'X')
      await user.click(screen.getByRole('button', { name: 'Register terminal' }))
      expect(await screen.findByTestId('kiosk-token')).toBeInTheDocument()
      act(() => {
        vi.advanceTimersByTime(179_000)
      })
      expect(screen.getByTestId('kiosk-token')).toBeInTheDocument()
      act(() => {
        vi.advanceTimersByTime(2_000)
      })
      expect(screen.queryByTestId('kiosk-token')).toBeNull()
      expect(document.body.textContent).not.toContain(TOKEN)
    } finally {
      vi.useRealTimers()
    }
  })
})
