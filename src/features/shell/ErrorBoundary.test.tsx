import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ShellErrorBoundary } from './ErrorBoundary'

let shouldThrow = true
// React (dev) re-dispatches caught render errors as window 'error' events; jsdom would print them. The boundary is under test.
const swallow = (e: ErrorEvent) => e.preventDefault()
function Boom() {
  if (shouldThrow) throw new Error('duplicate key value violates unique constraint "secret_table_pkey"')
  return <p>recovered</p>
}

beforeEach(() => {
  shouldThrow = true
  vi.spyOn(console, 'error').mockImplementation(() => {})
  window.addEventListener('error', swallow)
})
afterEach(() => {
  window.removeEventListener('error', swallow)
  vi.restoreAllMocks()
})

describe('ShellErrorBoundary', () => {
  it('shows a fixed safe message, never the raw error', () => {
    render(
      <ShellErrorBoundary resetKey="/a">
        <Boom />
      </ShellErrorBoundary>,
    )
    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeInTheDocument()
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.queryByText(/secret_table|duplicate key/)).toBeNull()
  })

  it('recovers via Try again and on navigation (resetKey change)', async () => {
    const view = render(
      <ShellErrorBoundary resetKey="/a">
        <Boom />
      </ShellErrorBoundary>,
    )
    shouldThrow = false
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }))
    expect(screen.getByText('recovered')).toBeInTheDocument()

    shouldThrow = true
    view.rerender(
      <ShellErrorBoundary resetKey="/b">
        <Boom />
      </ShellErrorBoundary>,
    )
    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeInTheDocument()
    shouldThrow = false
    view.rerender(
      <ShellErrorBoundary resetKey="/c">
        <Boom />
      </ShellErrorBoundary>,
    )
    expect(screen.getByText('recovered')).toBeInTheDocument()
  })
})
