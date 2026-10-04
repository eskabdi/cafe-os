import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TILE_LOGIN_MESSAGES } from '@/lib/supabase/tile-login-messages'
import { clearKioskToken, getKioskToken, setKioskToken } from '@/lib/utils/kiosk-token'
import { TerminalPage } from './TerminalPage'

const h = vi.hoisted(() => ({ fetchStaffRoster: vi.fn(), pinLoginTile: vi.fn() }))
vi.mock('@/lib/supabase/staff-roster', async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  fetchStaffRoster: h.fetchStaffRoster,
}))
vi.mock('@/lib/supabase/client', () => ({ supabase: {} }))
vi.mock('@/lib/supabase/pin-login', () => ({ pinLoginTile: h.pinLoginTile }))

const TOKEN = 'ef'.repeat(32)
const staff = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Abebe Kebede',
    role: 'Waiter',
    color: '#2563eb',
    icon: 'concierge-bell',
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'Dawit Haile',
    role: 'Runner',
    color: '#fde047',
    icon: 'bike',
  },
]

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>
}

function renderAt(path = '/r/demo-cafe/terminal') {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <Where />
        <Routes>
          <Route path="/r/:slug/terminal" element={<TerminalPage />} />
          <Route path="/r/:slug" element={<p>app</p>} />
          <Route path="/r/:slug/login" element={<p>login</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  h.fetchStaffRoster.mockReset()
  h.pinLoginTile.mockReset()
  clearKioskToken('demo-cafe')
})
afterEach(() => {
  clearKioskToken('demo-cafe')
})

describe('TerminalPage', () => {
  it('shows the neutral unauthorized screen without a token, without calling the roster', () => {
    renderAt()
    expect(screen.getByText('This terminal is not set up. Ask a manager to register it.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Sign in with username' })).toHaveAttribute(
      'href',
      '/r/demo-cafe/login',
    )
    expect(screen.getByRole('link', { name: 'Admin sign-in' })).toHaveAttribute(
      'href',
      '/r/demo-cafe/admin-login',
    )
    expect(h.fetchStaffRoster).not.toHaveBeenCalled()
  })

  it('shows the unauthorized screen for an invalid slug', () => {
    renderAt('/r/WWW/terminal')
    expect(screen.getByText('This terminal is not set up. Ask a manager to register it.')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Admin sign-in' })).toBeNull()
  })

  it('on 401 shows the neutral screen WITHOUT erasing the token, and offers an explicit removal', async () => {
    const user = userEvent.setup()
    setKioskToken('demo-cafe', TOKEN)
    h.fetchStaffRoster.mockResolvedValue({ ok: false, reason: 'invalid_kiosk' })
    renderAt()
    expect(
      await screen.findByText('This terminal is not set up. Ask a manager to register it.'),
    ).toBeInTheDocument()
    expect(getKioskToken('demo-cafe')).toBe(TOKEN)
    expect(screen.queryByRole('radio')).toBeNull()
    expect(document.body.textContent).not.toMatch(/revoked|expired|suspend/i)
    await user.click(screen.getByRole('button', { name: 'Remove setup from this device' }))
    expect(getKioskToken('demo-cafe')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Remove setup from this device' })).toBeNull()
  })

  it('never shows the tiles for a frame before the unauthorized screen on 401', async () => {
    setKioskToken('demo-cafe', TOKEN)
    h.fetchStaffRoster.mockResolvedValue({ ok: false, reason: 'invalid_kiosk' })
    renderAt()
    await screen.findByText(/not set up/i, { selector: 'p' })
    expect(screen.queryByRole('radiogroup')).toBeNull()
  })

  it('keeps the previous tiles and the open pad when a background refetch fails', async () => {
    const user = userEvent.setup()
    setKioskToken('demo-cafe', TOKEN)
    h.fetchStaffRoster.mockResolvedValueOnce({ ok: true, staff })
    renderAt()
    await user.click(await screen.findByRole('radio', { name: /Abebe/ }))
    await user.keyboard('12')
    h.fetchStaffRoster.mockResolvedValue({ ok: false, reason: 'network' })
    act(() => {
      focusManager.setFocused(false)
      focusManager.setFocused(true)
    })
    await waitFor(() => expect(h.fetchStaffRoster.mock.calls.length).toBeGreaterThan(1))
    expect(screen.getAllByRole('radio')).toHaveLength(2)
    expect(screen.getByText('2 of 4 digits entered')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('renders roster rows named Admin or Cashier verbatim (exclusion is server-side, not client filtering)', async () => {
    setKioskToken('demo-cafe', TOKEN)
    h.fetchStaffRoster.mockResolvedValue({
      ok: true,
      staff: [
        { id: staff[0]!.id, name: 'Admin', role: 'Cashier', color: null, icon: null },
        { id: staff[1]!.id, name: 'Cashier', role: 'Admin', color: null, icon: null },
      ],
    })
    renderAt()
    expect(await screen.findAllByRole('radio')).toHaveLength(2)
    expect(screen.getByRole('radio', { name: /^Admin/ })).toHaveTextContent('Cashier')
    expect(screen.getByRole('radio', { name: /^Cashier/ })).toHaveTextContent('Admin')
  })

  it('keeps the token and offers a retry on a transient failure', async () => {
    setKioskToken('demo-cafe', TOKEN)
    h.fetchStaffRoster.mockResolvedValue({ ok: false, reason: 'network' })
    renderAt()
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(getKioskToken('demo-cafe')).toBe(TOKEN)
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('requests the roster with the slug and token, and renders exactly the returned tiles', async () => {
    setKioskToken('demo-cafe', TOKEN)
    h.fetchStaffRoster.mockResolvedValue({ ok: true, staff })
    renderAt()
    expect(await screen.findAllByRole('radio')).toHaveLength(2)
    expect(h.fetchStaffRoster).toHaveBeenCalledWith({ restaurant_slug: 'demo-cafe', kiosk_token: TOKEN })
    expect(screen.getByRole('radio', { name: /Dawit Haile/ })).toHaveTextContent('Runner')
    expect(screen.queryByRole('heading', { name: 'Enter your PIN' })).toBeNull()
    // the token is never rendered
    expect(document.body.textContent).not.toContain(TOKEN)
  })

  it('reveals the 4-dot pad on selection, signs in via the tile path and routes to the app', async () => {
    const user = userEvent.setup()
    setKioskToken('demo-cafe', TOKEN)
    h.fetchStaffRoster.mockResolvedValue({ ok: true, staff })
    h.pinLoginTile.mockResolvedValue({ ok: true })
    renderAt()
    await user.click(await screen.findByRole('radio', { name: /Dawit Haile/ }))
    expect(screen.getByRole('heading', { name: 'Enter your PIN' })).toBeInTheDocument()
    await user.keyboard('4829')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/r/demo-cafe'))
    expect(h.pinLoginTile).toHaveBeenCalledWith({
      restaurant_slug: 'demo-cafe',
      kiosk_token: TOKEN,
      profile_id: staff[1]!.id,
      pin: '4829',
    })
  })

  it('shows the generic failure and keeps the tile selected', async () => {
    const user = userEvent.setup()
    setKioskToken('demo-cafe', TOKEN)
    h.fetchStaffRoster.mockResolvedValue({ ok: true, staff })
    h.pinLoginTile.mockResolvedValue({ ok: false, reason: 'invalid_credentials' })
    renderAt()
    await user.click(await screen.findByRole('radio', { name: /Abebe/ }))
    await user.keyboard('1111{Enter}')
    expect(await screen.findByRole('alert')).toHaveTextContent(TILE_LOGIN_MESSAGES.invalid_credentials)
    expect(screen.getByRole('radio', { name: /Abebe/ })).toBeChecked()
  })

  it('"Not you?" returns to the tiles with focus back on the tile and the PIN gone', async () => {
    const user = userEvent.setup()
    setKioskToken('demo-cafe', TOKEN)
    h.fetchStaffRoster.mockResolvedValue({ ok: true, staff })
    renderAt()
    await user.click(await screen.findByRole('radio', { name: /Abebe/ }))
    await user.keyboard('12')
    await user.click(screen.getByRole('button', { name: 'Not you?' }))
    expect(screen.queryByRole('heading', { name: 'Enter your PIN' })).toBeNull()
    expect(screen.getByRole('radio', { name: /Abebe/ })).toHaveFocus()
    await user.click(screen.getByRole('radio', { name: /Abebe/ }))
    expect(screen.getByText('0 of 4 digits entered')).toBeInTheDocument()
  })

  it('shows a neutral empty state for an empty roster', async () => {
    setKioskToken('demo-cafe', TOKEN)
    h.fetchStaffRoster.mockResolvedValue({ ok: true, staff: [] })
    renderAt()
    expect(await screen.findByText(/No one is available/)).toBeInTheDocument()
  })
})
