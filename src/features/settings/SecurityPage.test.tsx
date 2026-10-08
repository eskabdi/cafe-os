import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { Toaster } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthValue } from '@/features/auth/useAuth'
import { SecurityPage } from './SecurityPage'

const h = vi.hoisted(() => ({
  listFactors: vi.fn(),
  enroll: vi.fn(),
  challengeAndVerify: vi.fn(),
  unenroll: vi.fn(),
  refreshSession: vi.fn(),
}))
vi.mock('@/lib/supabase/client', () => ({
  supabase: {
    auth: {
      refreshSession: h.refreshSession,
      mfa: {
        listFactors: h.listFactors,
        enroll: h.enroll,
        challengeAndVerify: h.challengeAndVerify,
        unenroll: h.unenroll,
      },
    },
  },
}))

const refreshContext = vi.fn()
const passwordSession = { user: { id: 'u', email: 'owner@example.com', app_metadata: {} } }
const pinSession = {
  user: { id: 'u', email: 'abebe@demo.staff.cafeos.invalid', app_metadata: { staff: true } },
}
const SECRET = 'JBSWY3DPEHPK3PXP'
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><path d="M0 0h1v1z"/></svg>'

const verifiedFactor = {
  id: 'f-1',
  friendly_name: 'My phone',
  factor_type: 'totp',
  status: 'verified',
  created_at: '2026-03-04T10:00:00Z',
  updated_at: '2026-03-04T10:00:00Z',
}
const listed = (verified: unknown[], unverified: unknown[] = []) => ({
  data: { totp: verified, all: [...verified, ...unverified] },
  error: null,
})

function renderPage(session: unknown = passwordSession) {
  const value = {
    status: 'authenticated',
    session,
    context: {
      user: { id: 'u', first_name: 'Owner', username: 'owner' },
      restaurant: { id: 'r', name: 'Demo', slug: 'demo-cafe', status: 'active' },
      permissions: [],
      station_ids: [],
    },
    contextStatus: 'ready',
    can: () => false,
    signOut: vi.fn(),
    refreshContext,
  } as unknown as AuthValue
  return render(
    <AuthContext.Provider value={value}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <SecurityPage />
          <Toaster />
        </MemoryRouter>
      </QueryClientProvider>
    </AuthContext.Provider>,
  )
}

const enrollResponse = {
  data: {
    id: 'f-new',
    type: 'totp',
    friendly_name: 'Authenticator app',
    totp: { qr_code: SVG, secret: SECRET, uri: `otpauth://totp/x?secret=${SECRET}` },
  },
  error: null,
}

describe('SecurityPage', () => {
  beforeEach(() => {
    for (const fn of Object.values(h)) fn.mockReset()
    refreshContext.mockReset()
    h.refreshSession.mockResolvedValue({ data: {}, error: null })
    h.unenroll.mockResolvedValue({ data: { id: 'x' }, error: null })
  })

  it('a PIN session sees a notice and nothing is requested from the authenticator API', () => {
    renderPage(pinSession)
    expect(screen.getByRole('alert')).toHaveTextContent(
      'only available to accounts that sign in with an email address',
    )
    expect(screen.queryByRole('button', { name: 'Set up authenticator' })).not.toBeInTheDocument()
    expect(h.listFactors).not.toHaveBeenCalled()
    expect(h.enroll).not.toHaveBeenCalled()
  })

  it('lists enrolled authenticators with their status', async () => {
    h.listFactors.mockResolvedValue(listed([verifiedFactor]))
    renderPage()
    expect(await screen.findByText('My phone')).toBeInTheDocument()
    expect(screen.getByText('Active')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Set up authenticator' })).not.toBeInTheDocument()
  })

  it('a failing list shows a neutral error with a retry', async () => {
    h.listFactors.mockResolvedValue({ data: null, error: new Error('boom') })
    renderPage()
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Could not load your authenticators.')
    expect(alert.textContent).not.toMatch(/mfa|aal/i)
  })

  describe('enrollment', () => {
    it('shows the QR as an image and the key as text, verifies a code, then refreshes and forgets the secret', async () => {
      const user = userEvent.setup()
      h.listFactors
        .mockResolvedValueOnce(listed([])) // page load
        .mockResolvedValueOnce(listed([])) // stale-factor sweep
        .mockResolvedValue(listed([verifiedFactor])) // after verification
      h.enroll.mockResolvedValue(enrollResponse)
      h.challengeAndVerify.mockResolvedValue({ data: {}, error: null })
      renderPage()

      await user.click(await screen.findByRole('button', { name: 'Set up authenticator' }))
      expect(h.enroll).toHaveBeenCalledWith({ factorType: 'totp', friendlyName: 'Authenticator app' })

      const img = await screen.findByAltText(/scan with your authenticator app/i)
      const src = img.getAttribute('src') ?? ''
      expect(src.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true)
      expect(src).not.toContain('<') // markup is never injected, only an encoded image URL
      expect(screen.getByTestId('authenticator-key')).toHaveTextContent('JBSW Y3DP EHPK 3PXP')

      const input = screen.getByLabelText('Authentication code')
      expect(input).toHaveAttribute('autocomplete', 'one-time-code')
      await user.type(input, '123456')
      await user.click(screen.getByRole('button', { name: 'Verify and finish' }))

      await waitFor(() =>
        expect(h.challengeAndVerify).toHaveBeenCalledWith({ factorId: 'f-new', code: '123456' }),
      )
      await waitFor(() => expect(h.refreshSession).toHaveBeenCalledTimes(1))
      expect(refreshContext).toHaveBeenCalledTimes(1)
      expect(await screen.findByText('My phone')).toBeInTheDocument()
      expect(screen.queryByTestId('authenticator-key')).not.toBeInTheDocument()
      expect(document.body.textContent).not.toContain(SECRET)
    })

    it('removes an abandoned, unverified factor before enrolling again', async () => {
      const user = userEvent.setup()
      const stale = { id: 'f-stale', factor_type: 'totp', status: 'unverified' }
      h.listFactors.mockResolvedValueOnce(listed([])).mockResolvedValue(listed([], [stale]))
      h.enroll.mockResolvedValue(enrollResponse)
      renderPage()
      await user.click(await screen.findByRole('button', { name: 'Set up authenticator' }))
      await screen.findByTestId('authenticator-key')
      expect(h.unenroll).toHaveBeenCalledWith({ factorId: 'f-stale' })
      expect(h.unenroll.mock.invocationCallOrder[0]!).toBeLessThan(h.enroll.mock.invocationCallOrder[0]!)
    })

    it('rejects anything but six digits before calling the server, and a wrong code stays neutral', async () => {
      const user = userEvent.setup()
      h.listFactors.mockResolvedValue(listed([]))
      h.enroll.mockResolvedValue(enrollResponse)
      h.challengeAndVerify.mockResolvedValue({
        data: null,
        error: { code: 'mfa_verification_failed', status: 400 },
      })
      renderPage()
      await user.click(await screen.findByRole('button', { name: 'Set up authenticator' }))
      const input = await screen.findByLabelText('Authentication code')

      await user.type(input, '12ab34')
      expect(input).toHaveValue('1234') // non-digits are dropped as typed
      await user.click(screen.getByRole('button', { name: 'Verify and finish' }))
      expect(await screen.findByRole('alert')).toHaveTextContent('That code did not work.')
      expect(h.challengeAndVerify).not.toHaveBeenCalled()

      await user.type(input, '56')
      await user.click(screen.getByRole('button', { name: 'Verify and finish' }))
      await waitFor(() => expect(h.challengeAndVerify).toHaveBeenCalledTimes(1))
      const alert = await screen.findByRole('alert')
      expect(alert).toHaveTextContent('That code did not work.')
      expect(alert.textContent).not.toMatch(/mfa|aal/i)
      expect(h.refreshSession).not.toHaveBeenCalled()
      expect(refreshContext).not.toHaveBeenCalled()
      expect(input).toHaveValue('') // the entered code is cleared
    })

    it('validates the name and maps a name clash to neutral copy', async () => {
      const user = userEvent.setup()
      h.listFactors.mockResolvedValue(listed([]))
      h.enroll.mockResolvedValue({ data: null, error: { code: 'mfa_factor_name_conflict', status: 422 } })
      renderPage()
      const name = await screen.findByLabelText('Name')
      await user.clear(name)
      await user.click(screen.getByRole('button', { name: 'Set up authenticator' }))
      expect(await screen.findByRole('alert')).toHaveTextContent('Enter a name of 1 to 40 characters.')
      expect(h.enroll).not.toHaveBeenCalled()

      await user.type(name, 'Phone')
      await user.click(screen.getByRole('button', { name: 'Set up authenticator' }))
      expect(await screen.findByRole('alert')).toHaveTextContent('That name is already in use.')
    })

    it('without a usable QR it still offers the setup key', async () => {
      const user = userEvent.setup()
      h.listFactors.mockResolvedValue(listed([]))
      h.enroll.mockResolvedValue({
        data: {
          ...enrollResponse.data,
          totp: { ...enrollResponse.data.totp, qr_code: 'javascript:alert(1)' },
        },
        error: null,
      })
      renderPage()
      await user.click(await screen.findByRole('button', { name: 'Set up authenticator' }))
      expect(await screen.findByTestId('authenticator-key')).toBeInTheDocument()
      expect(screen.queryByRole('img')).not.toBeInTheDocument()
    })

    it('cancelling, or leaving the page, discards the unfinished factor and the secret', async () => {
      const user = userEvent.setup()
      h.listFactors.mockResolvedValue(listed([]))
      h.enroll.mockResolvedValue(enrollResponse)
      const view = renderPage()
      await user.click(await screen.findByRole('button', { name: 'Set up authenticator' }))
      await screen.findByTestId('authenticator-key')
      await user.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(h.unenroll).toHaveBeenCalledWith({ factorId: 'f-new' })
      expect(screen.queryByTestId('authenticator-key')).not.toBeInTheDocument()

      h.unenroll.mockClear()
      await user.click(screen.getByRole('button', { name: 'Set up authenticator' }))
      await screen.findByTestId('authenticator-key')
      view.unmount()
      expect(h.unenroll).toHaveBeenCalledWith({ factorId: 'f-new' })
    })
  })

  describe('removal', () => {
    it('warns, verifies a code first, then removes and refreshes', async () => {
      const user = userEvent.setup()
      h.listFactors.mockResolvedValueOnce(listed([verifiedFactor])).mockResolvedValue(listed([]))
      h.challengeAndVerify.mockResolvedValue({ data: {}, error: null })
      renderPage()
      await user.click(await screen.findByRole('button', { name: 'Remove' }))

      const dialog = await screen.findByRole('dialog')
      expect(dialog).toHaveTextContent(
        'approving PIN changes and changing the session timers will stop working',
      )
      expect(dialog.textContent).not.toMatch(/mfa|aal/i)
      await user.type(within(dialog).getByLabelText('Authentication code'), '654321')
      await user.click(within(dialog).getByRole('button', { name: 'Remove authenticator' }))

      await waitFor(() => expect(h.unenroll).toHaveBeenCalledWith({ factorId: 'f-1' }))
      expect(h.challengeAndVerify).toHaveBeenCalledWith({ factorId: 'f-1', code: '654321' })
      expect(h.challengeAndVerify.mock.invocationCallOrder[0]!).toBeLessThan(
        h.unenroll.mock.invocationCallOrder[0]!,
      )
      await waitFor(() => expect(h.refreshSession).toHaveBeenCalled())
      expect(refreshContext).toHaveBeenCalled()
      expect(await screen.findByRole('button', { name: 'Set up authenticator' })).toBeInTheDocument()
    })

    it('a wrong code removes nothing', async () => {
      const user = userEvent.setup()
      h.listFactors.mockResolvedValue(listed([verifiedFactor]))
      h.challengeAndVerify.mockResolvedValue({
        data: null,
        error: { code: 'mfa_verification_failed', status: 400 },
      })
      renderPage()
      await user.click(await screen.findByRole('button', { name: 'Remove' }))
      const dialog = await screen.findByRole('dialog')
      await user.type(within(dialog).getByLabelText('Authentication code'), '000000')
      await user.click(within(dialog).getByRole('button', { name: 'Remove authenticator' }))
      expect(await within(dialog).findByRole('alert')).toHaveTextContent('That code did not work.')
      expect(h.unenroll).not.toHaveBeenCalled()
    })

    it('cancel closes the dialog without calling the server', async () => {
      const user = userEvent.setup()
      h.listFactors.mockResolvedValue(listed([verifiedFactor]))
      renderPage()
      await user.click(await screen.findByRole('button', { name: 'Remove' }))
      const dialog = await screen.findByRole('dialog')
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      expect(h.challengeAndVerify).not.toHaveBeenCalled()
      expect(h.unenroll).not.toHaveBeenCalled()
    })
  })
})
