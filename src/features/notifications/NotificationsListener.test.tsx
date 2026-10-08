import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { Toaster, toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthValue } from '@/features/auth/useAuth'
import type { NotificationSubscription, UserNotification } from '@/lib/supabase/notifications'
import { NotificationsListener } from './NotificationsListener'

const ME = '11111111-1111-4111-8111-111111111111'
const STAFF = '22222222-2222-4222-8222-222222222222'

const h = vi.hoisted(() => ({
  fetchUnread: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  markRead: vi.fn(),
  handlers: null as null | NotificationSubscription,
}))
vi.mock('@/lib/supabase/client', () => ({ supabase: {} }))
vi.mock('@/lib/supabase/notifications', () => ({
  fetchUnreadNotifications: h.fetchUnread,
  subscribeToNotifications: h.subscribe,
}))
vi.mock('@/lib/supabase/rpc', () => ({ markNotificationRead: h.markRead }))

let seq = 0
function note(kind: string, payload: Record<string, unknown>): UserNotification {
  seq += 1
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    recipient_id: ME,
    kind,
    payload,
    created_at: '2026-10-04T08:00:00Z',
    read_at: null,
  }
}
const about = (id: string, name = 'Abebe Kebede', extra: Record<string, unknown> = {}) => ({
  profile_id: id,
  user_name: name,
  at: '2026-10-04T08:00:00Z',
  ...extra,
})

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>
}

const refreshContext = vi.fn()
let client: QueryClient

function renderListener(over: Partial<AuthValue> = {}) {
  client = new QueryClient()
  const value: AuthValue = {
    status: 'authenticated',
    session: null,
    context: {
      user: { id: ME, first_name: 'Me', username: 'me' },
      restaurant: { id: 'r', name: 'Demo', slug: 'demo-cafe', status: 'active' },
      permissions: ['users.manage'],
      station_ids: [],
    },
    contextStatus: 'ready',
    can: () => true,
    signOut: vi.fn(),
    refreshContext,
    ...over,
  }
  return render(
    <AuthContext.Provider value={value}>
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/r/demo-cafe']}>
          <Where />
          <NotificationsListener />
          <Toaster closeButton />
        </MemoryRouter>
      </QueryClientProvider>
    </AuthContext.Provider>,
  )
}

const push = (n: UserNotification) => act(() => h.handlers?.onInsert(n))
const toastOf = (text: string) => screen.getByText(text).closest('[data-sonner-toast]') as HTMLElement

// jsdom lacks pointer capture; Sonner calls it on pointerdown inside a toast.
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {}
  Element.prototype.releasePointerCapture = () => {}
}

beforeEach(() => {
  h.fetchUnread.mockReset().mockResolvedValue([])
  h.unsubscribe.mockReset()
  h.subscribe.mockReset().mockImplementation((_uid: string, handlers: NotificationSubscription) => {
    h.handlers = handlers
    return h.unsubscribe
  })
  h.markRead.mockReset().mockResolvedValue(undefined)
  refreshContext.mockClear()
})
afterEach(async () => {
  h.handlers = null
  // Sonner removes a dismissed toast on a timer; let it finish while jsdom still exists, or it can fire after teardown
  // ("window is not defined", an unhandled error that fails the run).
  act(() => {
    toast.dismiss()
  })
  await waitFor(() => expect(document.querySelector('[data-sonner-toast]')).toBeNull())
})

describe('NotificationsListener', () => {
  it('subscribes for the signed-in user and fetches unread on mount and on every (re)subscription', async () => {
    const pending = note('security.pin_change_pending_approval', about(STAFF))
    h.fetchUnread.mockResolvedValue([pending])
    renderListener()
    expect(h.subscribe).toHaveBeenCalledWith(ME, expect.any(Object))
    expect(
      await screen.findByText('Abebe Kebede changed their PIN and is waiting for your approval'),
    ).toBeInTheDocument()
    expect(h.fetchUnread).toHaveBeenCalledWith(ME)
    act(() => h.handlers?.onSubscribed?.())
    await waitFor(() => expect(h.fetchUnread).toHaveBeenCalledTimes(2))
    // same id again (fetch + realtime race): still one toast
    await push(pending)
    await waitFor(() =>
      expect(
        screen.getAllByText('Abebe Kebede changed their PIN and is waiting for your approval'),
      ).toHaveLength(1),
    )
  })

  it('does nothing while signed out or without a tenant user', () => {
    renderListener({ status: 'signed_out', context: null })
    expect(h.subscribe).not.toHaveBeenCalled()
    expect(h.fetchUnread).not.toHaveBeenCalled()
  })

  it('admin: blocked second-device sign-in, kiosk name as plain text', async () => {
    renderListener()
    await push(
      note('security.concurrent_login_blocked', about(STAFF, 'Sara T', { kiosk_name: 'Front counter' })),
    )
    expect(
      await screen.findByText('Sara T was blocked from signing in on a second device'),
    ).toBeInTheDocument()
    expect(screen.getByText('Terminal: Front counter')).toBeInTheDocument()
    expect(refreshContext).not.toHaveBeenCalled()
  })

  it('admin: pending approval toast links to the approvals page, marks read and refreshes the list', async () => {
    const user = userEvent.setup()
    renderListener()
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    const n = note('security.pin_change_pending_approval', about(STAFF))
    await push(n)
    const t = await screen.findByText('Abebe Kebede changed their PIN and is waiting for your approval')
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['pin-approvals'] })
    await user.click(
      within(t.closest('[data-sonner-toast]') as HTMLElement).getByRole('button', { name: 'Review' }),
    )
    expect(screen.getByTestId('where')).toHaveTextContent('/r/demo-cafe/settings/pin-approvals')
    expect(h.markRead).toHaveBeenCalledWith(n.id)
  })

  it('self: blocked sign-in, approved and rejected refresh the session context', async () => {
    renderListener()
    await push(note('security.concurrent_login_blocked', about(ME)))
    expect(await screen.findByText('Your PIN was used on another device')).toBeInTheDocument()
    expect(refreshContext).toHaveBeenCalledTimes(1)
    await push(note('security.pin_change_approved', about(ME)))
    expect(await screen.findByText('Your new PIN was approved')).toBeInTheDocument()
    expect(refreshContext).toHaveBeenCalledTimes(2)
    await push(note('security.pin_change_rejected', about(ME)))
    expect(await screen.findByText('Your new PIN was not approved')).toBeInTheDocument()
    expect(screen.getByText('Please choose a different PIN.')).toBeInTheDocument()
    expect(refreshContext).toHaveBeenCalledTimes(3)
  })

  it('ignores unknown kinds and decisions about someone else (no toast, no mark read, no refresh)', async () => {
    renderListener()
    await push(note('billing.invoice_due', { user_name: 'Should not show' }))
    await push(note('security.pin_change_approved', about(STAFF, 'Not me')))
    await push(note('security.pin_change_pending_approval', about(ME, 'Self pending')))
    await push(note('security.concurrent_login_blocked', about(STAFF, 'Visible')))
    await screen.findByText('Visible was blocked from signing in on a second device')
    expect(screen.queryByText(/Should not show|Not me|Self pending/)).toBeNull()
    expect(screen.queryByText('Your new PIN was approved')).toBeNull()
    expect(refreshContext).not.toHaveBeenCalled()
    expect(h.markRead).not.toHaveBeenCalled()
  })

  it('renders payload values as text only', async () => {
    renderListener()
    const evil = '<img src=x onerror="alert(1)"><b>Bold</b>'
    await push(
      note('security.concurrent_login_blocked', about(STAFF, evil, { kiosk_name: '<script>x</script>' })),
    )
    const toast = await waitFor(() => toastOf(`${evil} was blocked from signing in on a second device`))
    expect(toast.querySelector('img, b, script')).toBeNull()
    expect(document.querySelector('img')).toBeNull()
    expect(screen.getByText('Terminal: <script>x</script>')).toBeInTheDocument()
  })

  it('falls back to neutral copy for a missing or non-string name', async () => {
    renderListener()
    await push(note('security.concurrent_login_blocked', { profile_id: STAFF, user_name: { $: 1 } }))
    expect(
      await screen.findByText('A staff member was blocked from signing in on a second device'),
    ).toBeInTheDocument()
  })

  it('marks a notification read when its toast is dismissed', async () => {
    const user = userEvent.setup()
    renderListener()
    const n = note('security.concurrent_login_blocked', about(STAFF, 'Sara T'))
    await push(n)
    const t = toastOf(
      (await screen.findByText('Sara T was blocked from signing in on a second device')).textContent ?? '',
    )
    await user.click(within(t).getByRole('button', { name: 'Close toast' }))
    expect(h.markRead).toHaveBeenCalledWith(n.id)
    expect(h.markRead).toHaveBeenCalledTimes(1)
  })

  it('on sign-out unsubscribes and removes its toasts (shared terminals)', async () => {
    const view = renderListener()
    await push(note('security.concurrent_login_blocked', about(ME)))
    await screen.findByText('Your PIN was used on another device')
    view.rerender(
      <AuthContext.Provider
        value={{
          status: 'signed_out',
          session: null,
          context: null,
          contextStatus: 'idle',
          can: () => false,
          signOut: vi.fn(),
          refreshContext,
        }}
      >
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <NotificationsListener />
            <Toaster closeButton />
          </MemoryRouter>
        </QueryClientProvider>
      </AuthContext.Provider>,
    )
    expect(h.unsubscribe).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByText('Your PIN was used on another device')).toBeNull())
    expect(h.markRead).not.toHaveBeenCalled()
  })

  it('a failed initial fetch is silent', async () => {
    h.fetchUnread.mockRejectedValue(new Error('notifications_unavailable'))
    renderListener()
    await waitFor(() => expect(h.fetchUnread).toHaveBeenCalled())
    expect(screen.queryByRole('listitem')).toBeNull()
  })
})
