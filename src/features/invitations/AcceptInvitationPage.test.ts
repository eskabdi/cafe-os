import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase/client', () => ({ supabase: { auth: {} } }))
import { MIN_PASSWORD, passwordProblem } from './AcceptInvitationPage'

describe('invitation password rules (shared administrator policy)', () => {
  it('needs length, lower, upper, digit, symbol and a matching repeat', () => {
    expect(passwordProblem('Short1!', 'Short1!')).toMatch(String(MIN_PASSWORD))
    expect(passwordProblem('onlylower123!', 'onlylower123!')).toMatch(/uppercase/)
    expect(passwordProblem('NoSymbolHere12', 'NoSymbolHere12')).toMatch(/symbol/)
    expect(passwordProblem('NoDigitsHere!', 'NoDigitsHere!')).toMatch(/digit/)
    expect(passwordProblem('Good-password1', 'Good-password2')).toMatch(/differ/)
    expect(passwordProblem('Good-password1', 'Good-password1')).toBeNull()
    expect(passwordProblem('aA1!'.repeat(19), 'aA1!'.repeat(19))).toMatch(/72/)
  })
})
