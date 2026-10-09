import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase/client', () => ({ supabase: { auth: {} } }))
import { MIN_PASSWORD, passwordProblem } from './AcceptInvitationPage'

describe('invitation password rules', () => {
  it('needs length, letters, a digit and a matching repeat', () => {
    expect(passwordProblem('short1', 'short1')).toMatch(String(MIN_PASSWORD))
    expect(passwordProblem('onlyletterslong', 'onlyletterslong')).toMatch(/digit/)
    expect(passwordProblem('123456789012', '123456789012')).toMatch(/letters/)
    expect(passwordProblem('goodpassword1', 'goodpassword2')).toMatch(/differ/)
    expect(passwordProblem('goodpassword1', 'goodpassword1')).toBeNull()
    expect(passwordProblem('a1'.repeat(40), 'a1'.repeat(40))).toMatch(/72/)
  })
})
