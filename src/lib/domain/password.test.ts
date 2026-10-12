import { describe, expect, it } from 'vitest'
import { MAX_PASSWORD, MIN_PASSWORD, passwordProblem } from './password'

describe('administrator password policy', () => {
  it('needs length, letters, a digit and a matching repeat', () => {
    expect(passwordProblem('short1', 'short1')).toMatch(String(MIN_PASSWORD))
    expect(passwordProblem('a1'.repeat(40), 'a1'.repeat(40))).toMatch(String(MAX_PASSWORD))
    expect(passwordProblem('onlyletterslong', 'onlyletterslong')).toMatch(/digit/)
    expect(passwordProblem('123456789012', '123456789012')).toMatch(/letters/)
    expect(passwordProblem('goodpassword1', 'goodpassword2')).toMatch(/differ/)
    expect(passwordProblem('goodpassword1', 'goodpassword1')).toBeNull()
  })
})
