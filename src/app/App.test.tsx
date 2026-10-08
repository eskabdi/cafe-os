import { render, screen } from '@testing-library/react'
import { RouterProvider, createMemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { Providers } from './providers'
import { HomePage } from './HomePage'

describe('App shell', () => {
  it('renders the home page inside providers', () => {
    const router = createMemoryRouter([{ path: '/', element: <HomePage /> }])
    render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    )
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('CafeOS')
  })
})
