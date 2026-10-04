import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthenticatorEnroll } from './AuthenticatorEnroll'

const h = vi.hoisted(() => ({
  listFactors: vi.fn(),
  enroll: vi.fn(),
  challengeAndVerify: vi.fn(),
  unenroll: vi.fn(),
}))
vi.mock('@/lib/supabase/client', () => ({
  supabase: {
    auth: {
      mfa: {
        listFactors: h.listFactors,
        enroll: h.enroll,
        challengeAndVerify: h.challengeAndVerify,
        unenroll: h.unenroll,
      },
    },
  },
}))

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><path d="M0 0h1v1z"/></svg>'

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

async function reachCodeStep(onEnrolled: () => Promise<void> | void) {
  const user = userEvent.setup()
  const view = render(<AuthenticatorEnroll onEnrolled={onEnrolled} />)
  await user.click(screen.getByRole('button', { name: 'Set up authenticator' }))
  await screen.findByTestId('authenticator-key')
  await user.type(screen.getByLabelText('Authentication code'), '123456')
  return { user, view }
}

describe('AuthenticatorEnroll', () => {
  beforeEach(() => {
    for (const fn of Object.values(h)) fn.mockReset()
    h.listFactors.mockResolvedValue({ data: { totp: [], all: [] }, error: null })
    h.unenroll.mockResolvedValue({ data: { id: 'x' }, error: null })
    h.enroll.mockResolvedValue({
      data: {
        id: 'f-new',
        type: 'totp',
        totp: { qr_code: SVG, secret: 'JBSWY3DPEHPK3PXP', uri: 'otpauth://x' },
      },
      error: null,
    })
  })

  it('unmounting while a code check is in flight does not discard the factor (the code may be accepted)', async () => {
    const verify = deferred<{ data: object; error: null }>()
    h.challengeAndVerify.mockReturnValue(verify.promise)
    const { user, view } = await reachCodeStep(vi.fn())
    await user.click(screen.getByRole('button', { name: 'Verify and finish' }))
    await waitFor(() => expect(h.challengeAndVerify).toHaveBeenCalledTimes(1))
    view.unmount()
    expect(h.unenroll).not.toHaveBeenCalled()
    await act(async () => {
      verify.resolve({ data: {}, error: null })
      await verify.promise
    })
    expect(h.unenroll).not.toHaveBeenCalled()
  })

  it('leaving mid-verify and then being refused still removes the unfinished factor', async () => {
    const verify = deferred<{ data: null; error: Error }>()
    h.challengeAndVerify.mockReturnValue(verify.promise)
    const { user, view } = await reachCodeStep(vi.fn())
    await user.click(screen.getByRole('button', { name: 'Verify and finish' }))
    await waitFor(() => expect(h.challengeAndVerify).toHaveBeenCalledTimes(1))
    view.unmount()
    expect(h.unenroll).not.toHaveBeenCalled()
    await act(async () => {
      verify.resolve({ data: null, error: new Error('invalid') })
      await verify.promise
    })
    await waitFor(() => expect(h.unenroll).toHaveBeenCalledWith({ factorId: 'f-new' }))
    expect(h.unenroll).toHaveBeenCalledTimes(1)
  })

  it('unmounting before any verify still discards the unfinished factor', async () => {
    const { view } = await reachCodeStep(vi.fn())
    view.unmount()
    expect(h.unenroll).toHaveBeenCalledWith({ factorId: 'f-new' })
  })

  it('does not flash "Starting…" while onEnrolled runs', async () => {
    const done = deferred<void>()
    h.challengeAndVerify.mockResolvedValue({ data: {}, error: null })
    const onEnrolled = vi.fn(() => done.promise)
    const { user } = await reachCodeStep(onEnrolled)
    await user.click(screen.getByRole('button', { name: 'Verify and finish' }))
    await waitFor(() => expect(onEnrolled).toHaveBeenCalledTimes(1))
    expect(screen.queryByText('Starting…')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Finishing…' })).toBeDisabled()
    expect(screen.queryByTestId('authenticator-key')).not.toBeInTheDocument()
    await act(async () => {
      done.resolve()
      await done.promise
    })
    expect(screen.getByRole('button', { name: 'Set up authenticator' })).toBeEnabled()
  })

  it('a throwing onEnrolled is not shown as a failed enrollment', async () => {
    h.challengeAndVerify.mockResolvedValue({ data: {}, error: null })
    const failing = vi.fn().mockRejectedValue(new Error('refresh failed'))
    const { user } = await reachCodeStep(failing)
    await user.click(screen.getByRole('button', { name: 'Verify and finish' }))
    await waitFor(() => expect(failing).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Set up authenticator' })).toBeEnabled())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
