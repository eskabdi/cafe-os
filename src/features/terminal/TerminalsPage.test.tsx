import { useEffect, useRef } from 'react'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { AuthContext, type AuthValue } from '@/features/auth/useAuth'
import { clearKioskToken, getKioskToken } from '@/lib/utils/kiosk-token'
import { TerminalsPage } from './TerminalsPage'

const h = vi.hoisted(() => ({
  listKiosks: vi.fn(),
  registerKiosk: vi.fn(),
  revokeKiosk: vi.fn(),
  // Test switch: when on, the mocked step-up dialog "verifies" by itself the moment it opens (no admin action at all).
  autoVerify: { on: false },
}))
vi.mock('@/lib/supabase/client', () => ({ supabase: {} }))
vi.mock('@/features/auth/StepUpDialog', () => ({
  StepUpDialog: function StepUpDialog({
    open,
    onVerified,
    onCancel,
  }: {
    open: boolean
    onVerified: () => void
    onCancel: () => void
  }) {
    const fired = useRef(false)
    useEffect(() => {
      if (!open) {
        fired.current = false
        return
      }
      if (h.autoVerify.on && !fired.current) {
        fired.current = true
        onVerified()
      }
    }, [open, onVerified])
    return open ? (
      <div role="dialog" aria-label="step-up">
        <button onClick={onVerified}>Verify code</button>
        <button onClick={onCancel}>Cancel step-up</button>
      </div>
    ) : null
  },
}))
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
const NEUTRAL = 'Verify with your authenticator to continue.'
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
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <AuthContext.Provider value={auth(perms)}>
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/r/demo-cafe/settings/terminals']}>
          <Routes>
            <Route path="/r/:slug/settings/terminals" element={<TerminalsPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </AuthContext.Provider>,
  )
  return { client }
}

type User = ReturnType<typeof userEvent.setup>

const mfaRequired = async () => {
  const { RpcError } = await import('@/lib/supabase/rpc')
  return new RpcError('mfa_required')
}

/** Refuses every call with mfa_required, but gives up (generic error) after `limit` calls so a regression fails instead of spinning. */
async function refuseAlways(fn: Mock, limit = 25) {
  const { RpcError } = await import('@/lib/supabase/rpc')
  let calls = 0
  fn.mockImplementation(async () => {
    calls += 1
    if (calls > limit) throw new Error('runaway retry loop')
    throw new RpcError('mfa_required')
  })
}

async function startRegister(user: User, typed: string) {
  await user.type(await screen.findByLabelText('Terminal name'), typed)
  await user.click(screen.getByRole('button', { name: 'Register terminal' }))
}

async function startRevoke(user: User) {
  await user.click(await screen.findByRole('button', { name: 'Revoke Front counter' }))
  await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Revoke terminal' }))
}

const stepUp = () => screen.findByRole('dialog', { name: 'step-up' })
const verify = async (user: User) =>
  user.click(within(await stepUp()).getByRole('button', { name: 'Verify code' }))
const cancelStepUp = async (user: User) =>
  user.click(within(await stepUp()).getByRole('button', { name: 'Cancel step-up' }))

/** Lets any stray timer or promise chain run: if the page were going to act on its own, it would have by now. */
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50))
  })

beforeEach(() => {
  h.listKiosks.mockReset().mockResolvedValue([kiosk])
  h.registerKiosk.mockReset()
  h.revokeKiosk.mockReset()
  h.autoVerify.on = false
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
    expect(h.revokeKiosk).toHaveBeenCalledTimes(1)
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

  it('maps other refusals to safe copy and never opens a step-up for them', async () => {
    const user = userEvent.setup()
    const { RpcError } = await import('@/lib/supabase/rpc')
    h.registerKiosk.mockRejectedValue(new RpcError('kiosk_limit_reached'))
    renderPage()
    await startRegister(user, 'Bar tablet')
    expect(await screen.findByRole('alert')).toHaveTextContent('The limit of active terminals is reached.')
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('TerminalsPage step-up (mfa_required)', () => {
  it('register: opens the step-up, and a verified code registers the SAME name once', async () => {
    const user = userEvent.setup()
    h.registerKiosk
      .mockRejectedValueOnce(await mfaRequired())
      .mockResolvedValueOnce({ id: KIOSK_ID, name: 'Bar tablet', token: TOKEN })
    renderPage()
    await startRegister(user, '  Bar tablet ')
    await stepUp()
    expect(h.registerKiosk).toHaveBeenCalledTimes(1)
    // Nothing is shown while the admin verifies: no code, no error, and the pending name is not echoed anywhere.
    expect(screen.queryByTestId('kiosk-token')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(document.body.textContent).not.toContain('Bar tablet')

    await verify(user)
    expect(await screen.findByTestId('kiosk-token')).toHaveTextContent(TOKEN)
    expect(h.registerKiosk).toHaveBeenCalledTimes(2)
    expect(h.registerKiosk).toHaveBeenNthCalledWith(1, 'Bar tablet')
    expect(h.registerKiosk).toHaveBeenNthCalledWith(2, 'Bar tablet')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByLabelText('Terminal name')).toHaveValue('')
    await waitFor(() => expect(h.listKiosks).toHaveBeenCalledTimes(2)) // invalidated once, after the success
    expect(getKioskToken('demo-cafe')).toBeNull() // stored only if the admin presses "Set this device up"
  })

  it('register: the retry sends the name that was refused, not whatever the field holds by then', async () => {
    const user = userEvent.setup()
    h.registerKiosk
      .mockRejectedValueOnce(await mfaRequired())
      .mockResolvedValueOnce({ id: KIOSK_ID, name: 'Bar tablet', token: TOKEN })
    renderPage()
    await startRegister(user, 'Bar tablet')
    await stepUp()
    await user.type(screen.getByLabelText('Terminal name'), ' (edited)') // the real dialog is modal; this is the worst case
    await verify(user)
    await screen.findByTestId('kiosk-token')
    expect(h.registerKiosk).toHaveBeenNthCalledWith(2, 'Bar tablet')
  })

  it('register: cancelling the step-up shows the neutral message, registers nothing and keeps the name', async () => {
    const user = userEvent.setup()
    h.registerKiosk.mockRejectedValue(await mfaRequired())
    renderPage()
    await startRegister(user, 'Bar tablet')
    await cancelStepUp(user)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(NEUTRAL)
    expect(alert.textContent).not.toMatch(/mfa|aal/i)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByTestId('kiosk-token')).toBeNull()
    expect(screen.getByLabelText('Terminal name')).toHaveValue('Bar tablet')
    expect(h.registerKiosk).toHaveBeenCalledTimes(1)
    expect(h.listKiosks).toHaveBeenCalledTimes(1) // nothing changed, so nothing was refetched
  })

  it('revoke: opens the step-up (not stacked on the confirmation), and a verified code revokes the SAME terminal', async () => {
    const user = userEvent.setup()
    h.revokeKiosk.mockRejectedValueOnce(await mfaRequired()).mockResolvedValueOnce(undefined)
    renderPage()
    await startRevoke(user)
    await stepUp()
    expect(screen.getAllByRole('dialog')).toHaveLength(1) // the confirmation closed first
    expect(screen.queryByText('Revoke this terminal?')).toBeNull()
    expect(h.revokeKiosk).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alert')).toBeNull()

    await verify(user)
    await waitFor(() => expect(h.revokeKiosk).toHaveBeenCalledTimes(2))
    expect(h.revokeKiosk).toHaveBeenNthCalledWith(1, KIOSK_ID)
    expect(h.revokeKiosk).toHaveBeenNthCalledWith(2, KIOSK_ID)
    await waitFor(() => expect(h.listKiosks).toHaveBeenCalledTimes(2)) // invalidated once, after the success
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('revoke: cancelling the step-up shows the neutral message and revokes nothing', async () => {
    const user = userEvent.setup()
    h.revokeKiosk.mockRejectedValue(await mfaRequired())
    renderPage()
    await startRevoke(user)
    await cancelStepUp(user)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(NEUTRAL)
    expect(alert.textContent).not.toMatch(/mfa|aal/i)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(h.revokeKiosk).toHaveBeenCalledTimes(1)
    expect(h.listKiosks).toHaveBeenCalledTimes(1)
    // the terminal is still listed and can be revoked again later
    expect(screen.getByRole('button', { name: 'Revoke Front counter' })).toBeInTheDocument()
  })

  it('register: a second refusal after the retry shows the message and waits for the admin (no loop)', async () => {
    const user = userEvent.setup()
    h.registerKiosk
      .mockRejectedValueOnce(await mfaRequired()) // 1: asks for the code
      .mockRejectedValueOnce(await mfaRequired()) // 2: the retry is refused again
      .mockRejectedValueOnce(await mfaRequired()) // 3: the admin presses Register again
      .mockResolvedValueOnce({ id: KIOSK_ID, name: 'Bar tablet', token: TOKEN }) // 4: after the second verification
    renderPage()
    await startRegister(user, 'Bar tablet')
    await verify(user)

    expect(await screen.findByRole('alert')).toHaveTextContent(NEUTRAL)
    expect(screen.queryByRole('dialog')).toBeNull() // not asked again by the page itself
    await settle()
    expect(h.registerKiosk).toHaveBeenCalledTimes(2) // and nothing else runs until the admin acts
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByTestId('kiosk-token')).toBeNull()
    expect(screen.getByLabelText('Terminal name')).toHaveValue('Bar tablet')

    // The admin acts again: a fresh cycle (asks for the code, then the retry succeeds).
    await user.click(screen.getByRole('button', { name: 'Register terminal' }))
    expect(screen.queryByRole('alert')).toBeNull() // the old message is cleared by the new attempt
    await verify(user)
    expect(await screen.findByTestId('kiosk-token')).toHaveTextContent(TOKEN)
    expect(h.registerKiosk).toHaveBeenCalledTimes(4)
    expect(h.registerKiosk).toHaveBeenLastCalledWith('Bar tablet')
  })

  it('revoke: a second refusal after the retry shows the message and waits for the admin (no loop)', async () => {
    const user = userEvent.setup()
    h.revokeKiosk
      .mockRejectedValueOnce(await mfaRequired())
      .mockRejectedValueOnce(await mfaRequired())
      .mockResolvedValueOnce(undefined)
    renderPage()
    await startRevoke(user)
    await verify(user)

    expect(await screen.findByRole('alert')).toHaveTextContent(NEUTRAL)
    expect(screen.queryByRole('dialog')).toBeNull()
    await settle()
    expect(h.revokeKiosk).toHaveBeenCalledTimes(2)

    // Pressing Revoke again starts over from the confirmation.
    await startRevoke(user)
    expect(h.revokeKiosk).toHaveBeenCalledTimes(3)
    expect(h.revokeKiosk).toHaveBeenLastCalledWith(KIOSK_ID)
    await waitFor(() => expect(h.listKiosks).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  describe('a step-up that verifies by itself (no admin action at all) cannot make the page loop', () => {
    beforeEach(() => {
      h.autoVerify.on = true
    })

    it('register: refused, verified, retried once, refused again: stops with the message', async () => {
      const user = userEvent.setup()
      await refuseAlways(h.registerKiosk)
      renderPage()
      await startRegister(user, 'Bar tablet')
      expect(await screen.findByRole('alert')).toHaveTextContent(NEUTRAL)
      await settle()
      expect(h.registerKiosk).toHaveBeenCalledTimes(2)
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(screen.queryByTestId('kiosk-token')).toBeNull()
    })

    it('revoke: refused, verified, retried once, refused again: stops with the message', async () => {
      const user = userEvent.setup()
      await refuseAlways(h.revokeKiosk)
      renderPage()
      await startRevoke(user)
      expect(await screen.findByRole('alert')).toHaveTextContent(NEUTRAL)
      await settle()
      expect(h.revokeKiosk).toHaveBeenCalledTimes(2)
      expect(screen.queryByRole('dialog')).toBeNull()
    })
  })

  it('keeps the one-time code and the typed name out of the TanStack mutation cache', async () => {
    const user = userEvent.setup()
    h.registerKiosk
      .mockRejectedValueOnce(await mfaRequired())
      .mockResolvedValueOnce({ id: KIOSK_ID, name: 'Bar tablet', token: TOKEN })
    const { client } = renderPage()
    await startRegister(user, 'Bar tablet')
    await verify(user)
    expect(await screen.findByTestId('kiosk-token')).toHaveTextContent(TOKEN) // on screen, i.e. in component state

    await waitFor(() => {
      const held = JSON.stringify(
        client
          .getMutationCache()
          .getAll()
          .map((m) => [m.state.variables, m.state.data]),
      )
      expect(held).not.toContain(TOKEN)
      expect(held).not.toContain('Bar tablet')
    })
    expect(
      JSON.stringify(
        client
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
      ),
    ).not.toContain(TOKEN)
  })

  it('a code issued after a step-up is handled like any other: copy, overwrite on dismiss, hide after 3 minutes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
      h.registerKiosk
        .mockRejectedValueOnce(await mfaRequired())
        .mockResolvedValueOnce({ id: KIOSK_ID, name: 'X', token: TOKEN })
      renderPage()
      await startRegister(user, 'X')
      await verify(user)
      expect(await screen.findByTestId('kiosk-token')).toHaveTextContent(TOKEN)
      const writeText = vi.fn().mockResolvedValue(undefined)
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
      await user.click(screen.getByRole('button', { name: 'Copy code' }))
      expect(writeText).toHaveBeenCalledWith(TOKEN)

      act(() => {
        vi.advanceTimersByTime(179_000)
      })
      expect(screen.getByTestId('kiosk-token')).toBeInTheDocument()
      act(() => {
        vi.advanceTimersByTime(2_000)
      })
      expect(screen.queryByTestId('kiosk-token')).toBeNull()
      expect(writeText).toHaveBeenLastCalledWith('') // the best-effort clipboard overwrite runs on auto-hide too
      expect(document.body.textContent).not.toContain(TOKEN)
    } finally {
      vi.useRealTimers()
    }
  })
})
