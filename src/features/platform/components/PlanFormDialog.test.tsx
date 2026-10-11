import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Plan, PlanInput } from '@/lib/supabase/platform'
import { formToPlan, PlanFormDialog, planToForm } from './PlanFormDialog'

vi.mock('@/lib/supabase/client', () => ({ supabase: {} }))

const PLAN: Plan = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Basic',
  description: null,
  price_etb_monthly: 500,
  max_staff: 5,
  max_menu_items: null,
  max_stations: 1,
  max_kiosks: null,
  max_storage_bytes: null,
  max_orders_per_month: null,
  features: { installments: false, qr_ordering: true, seats: 40 },
  is_active: true,
  sort_order: 1,
  subscriber_count: 3,
}

function renderDialog(plan: Plan | null) {
  const onSubmit = vi.fn<(p: PlanInput) => void>()
  render(<PlanFormDialog open plan={plan} busy={false} error={null} onSubmit={onSubmit} onClose={() => {}} />)
  return onSubmit
}

describe('plan form features', () => {
  it('a new plan defaults installments on and every other known feature off', () => {
    const v = planToForm(null)
    expect(v.switches).toEqual({ installments: true, multi_station: false })
    expect(formToPlan({ ...v, name: 'X', price: '0' }).features).toEqual({ installments: true, multi_station: false })
  })

  it('an existing plan shows a switch on only for an exact true and keeps unknown keys', () => {
    const v = planToForm({ ...PLAN, features: { installments: 'true', multi_station: true, qr_ordering: true } })
    expect(v.switches).toEqual({ installments: false, multi_station: true })
    expect(v.features).toBe('qr_ordering = true')
  })

  it('renders labelled switches and submits explicit booleans with the unknown keys preserved', async () => {
    const user = userEvent.setup()
    const onSubmit = renderDialog(PLAN)
    const dialog = screen.getByRole('dialog', { name: 'Edit plan Basic' })
    const inst = within(dialog).getByRole('switch', { name: 'Installment vouchers' })
    const multi = within(dialog).getByRole('switch', { name: 'Multiple stations' })
    expect(inst).not.toBeChecked()
    expect(multi).not.toBeChecked()
    expect(inst).toHaveAccessibleDescription(/existing vouchers can still be collected/)
    expect(within(dialog).getByLabelText('Other features')).toHaveValue('qr_ordering = true\nseats = 40')

    await user.click(inst)
    await user.click(within(dialog).getByRole('button', { name: 'Save plan' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0]?.[0].features).toEqual({
      qr_ordering: true,
      seats: 40,
      installments: true,
      multi_station: false,
    })
  })

  it('new plan dialog has installments switched on', () => {
    renderDialog(null)
    expect(screen.getByRole('switch', { name: 'Installment vouchers' })).toBeChecked()
    expect(screen.getByRole('switch', { name: 'Multiple stations' })).not.toBeChecked()
  })

  it('refuses a known feature typed into the free-form list', async () => {
    const user = userEvent.setup()
    const onSubmit = renderDialog(PLAN)
    const other = screen.getByLabelText('Other features')
    await user.clear(other)
    await user.type(other, 'installments = true')
    await user.click(screen.getByRole('button', { name: 'Save plan' }))
    expect(await screen.findByText(/Use the switches above for installments, multi_station/)).toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
