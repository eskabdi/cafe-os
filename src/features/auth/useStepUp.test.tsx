import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthValue } from './useAuth'

const h = vi.hoisted(() => ({ listFactors: vi.fn(), challengeAndVerify: vi.fn() }))
vi.mock('@/lib/supabase/client', () => ({
  supabase: { auth: { mfa: { listFactors: h.listFactors, challengeAndVerify: h.challengeAndVerify } } },
}))

const { RpcError } = await import('@/lib/supabase/rpc')
const { useStepUp } = await import('./useStepUp')

let runner: ReturnType<typeof useStepUp> | null = null
function Harness() {
  const s = useStepUp()
  runner = s
  return <>{s.dialog}</>
}

function renderHarness() {
  const value: AuthValue = {
    status: 'authenticated',
    session: null,
    context: null,
    contextStatus: 'ready',
    can: () => true,
    signOut: vi.fn(),
    refreshContext: vi.fn(),
  }
  return render(
    <AuthContext.Provider value={value}>
      <MemoryRouter>
        <Harness />
      </MemoryRouter>
    </AuthContext.Provider>,
  )
}

beforeEach(() => {
  runner = null
  h.listFactors.mockReset().mockResolvedValue({ data: { totp: [{ id: 'f-1' }] }, error: null })
  h.challengeAndVerify.mockReset().mockResolvedValue({ error: null })
})

describe('useStepUp', () => {
  it('passes results and non-mfa errors straight through', async () => {
    renderHarness()
    await expect(runner!.run(async () => 7)).resolves.toBe(7)
    await expect(runner!.run(() => Promise.reject(new RpcError('day_closed')))).rejects.toMatchObject({
      code: 'day_closed',
    })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('on mfa_required prompts, then re-runs the SAME action once after verification', async () => {
    renderHarness()
    const action = vi.fn().mockRejectedValueOnce(new RpcError('mfa_required')).mockResolvedValueOnce('ok')
    let result: Promise<unknown> = Promise.resolve()
    act(() => {
      result = runner!.run(action)
    })
    const code = await screen.findByLabelText('Authentication code')
    await waitFor(() => expect(code).toBeEnabled())
    await userEvent.type(code, '123456')
    await userEvent.click(screen.getByRole('button', { name: 'Verify' }))
    await expect(result).resolves.toBe('ok')
    expect(action).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('a second mfa_required after verification is returned as an error (no loop)', async () => {
    renderHarness()
    const action = vi.fn().mockRejectedValue(new RpcError('mfa_required'))
    let result: Promise<unknown> = Promise.resolve()
    act(() => {
      result = runner!.run(action).catch((e: unknown) => e)
    })
    const code = await screen.findByLabelText('Authentication code')
    await waitFor(() => expect(code).toBeEnabled())
    await userEvent.type(code, '123456')
    await userEvent.click(screen.getByRole('button', { name: 'Verify' }))
    await expect(result).resolves.toMatchObject({ code: 'mfa_required' })
    expect(action).toHaveBeenCalledTimes(2)
  })

  it('cancel rejects with step_up_cancelled and does not re-run', async () => {
    renderHarness()
    const action = vi.fn().mockRejectedValue(new RpcError('mfa_required'))
    let result: Promise<unknown> = Promise.resolve()
    act(() => {
      result = runner!.run(action).catch((e: unknown) => e)
    })
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    await expect(result).resolves.toMatchObject({ code: 'step_up_cancelled' })
    expect(action).toHaveBeenCalledTimes(1)
  })

  it('a second mfa_required while one is pending cancels the first and re-runs only the second', async () => {
    renderHarness()
    const first = vi.fn().mockRejectedValue(new RpcError('mfa_required'))
    const second = vi
      .fn()
      .mockRejectedValueOnce(new RpcError('mfa_required'))
      .mockResolvedValueOnce('second-ok')
    let r1: Promise<unknown> = Promise.resolve()
    let r2: Promise<unknown> = Promise.resolve()
    act(() => {
      r1 = runner!.run(first).catch((e: unknown) => e)
    })
    await screen.findByRole('dialog')
    act(() => {
      r2 = runner!.run(second)
    })
    await expect(r1).resolves.toMatchObject({ code: 'step_up_cancelled' })
    const code = await screen.findByLabelText('Authentication code')
    await waitFor(() => expect(code).toBeEnabled())
    await userEvent.type(code, '123456')
    await userEvent.click(screen.getByRole('button', { name: 'Verify' }))
    await expect(r2).resolves.toBe('second-ok')
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(2)
  })

  it('unmounting rejects a pending step-up with step_up_cancelled', async () => {
    const { unmount } = renderHarness()
    const action = vi.fn().mockRejectedValue(new RpcError('mfa_required'))
    let result: Promise<unknown> = Promise.resolve()
    act(() => {
      result = runner!.run(action).catch((e: unknown) => e)
    })
    await screen.findByRole('dialog')
    unmount()
    await expect(result).resolves.toMatchObject({ code: 'step_up_cancelled' })
    expect(action).toHaveBeenCalledTimes(1)
  })
})
