import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { it, vi } from 'vitest'
import { StaffLogin } from './StaffLogin'
const pinLogin = vi.hoisted(() => vi.fn())
vi.mock('@/lib/supabase/pin-login', () => ({ pinLogin }))
it('dbg', async () => {
  const user = userEvent.setup()
  pinLogin.mockImplementation(async () => {
    throw new Error('boom')
  })
  render(<StaffLogin slug="demo-cafe" />)
  await user.type(screen.getByLabelText('Username'), 'abebe')
  await user.click(screen.getByRole('button', { name: 'Continue' }))
  try {
    await user.keyboard('1234')
  } catch (e) {
    console.log('T1', String(e))
  }
  try {
    await user.keyboard('{Enter}')
  } catch (e) {
    console.log('T2', String(e))
  }
  console.log('calls', pinLogin.mock.calls.length)
  await new Promise((r) => setTimeout(r, 100))
})
