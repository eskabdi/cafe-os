import { describe, expect, it } from 'vitest'
import { MAX_PASSWORD, MIN_PASSWORD, PASSWORD_HINT, PASSWORD_SYMBOLS, passwordProblem } from './password'

describe('administrator password policy (config.toml: lower_upper_letters_digits_symbols, 12..72)', () => {
  it('needs length, lower, upper, digit, symbol and a matching repeat', () => {
    expect(passwordProblem('Short1!', 'Short1!')).toMatch(String(MIN_PASSWORD))
    expect(passwordProblem('aA1!'.repeat(19), 'aA1!'.repeat(19))).toMatch(String(MAX_PASSWORD))
    expect(passwordProblem('ONLYUPPER123!', 'ONLYUPPER123!')).toMatch(/lowercase/)
    expect(passwordProblem('onlylower123!', 'onlylower123!')).toMatch(/uppercase/)
    expect(passwordProblem('NoDigitsHere!', 'NoDigitsHere!')).toMatch(/digit/)
    expect(passwordProblem('NoSymbolHere12', 'NoSymbolHere12')).toMatch(/symbol/)
    expect(passwordProblem('Good-password1', 'Good-password2')).toMatch(/differ/)
    expect(passwordProblem('Good-password1', 'Good-password1')).toBeNull()
  })
  it("a space or a non-Latin character is not one of GoTrue's symbols", () => {
    expect(passwordProblem('Good password1', 'Good password1')).toMatch(/symbol/)
    expect(passwordProblem('Good€password1', 'Good€password1')).toMatch(/symbol/)
  })
  it('counts bytes for the 72 limit (bcrypt)', () => {
    const amharic = `Aa1!${'ሀ'.repeat(30)}` // 34 characters, 94 bytes
    expect(passwordProblem(amharic, amharic)).toMatch(/at most 72/)
  })
  it('accepts every GoTrue symbol and describes the policy', () => {
    for (const c of PASSWORD_SYMBOLS) expect(passwordProblem(`Abcdefgh123${c}`, `Abcdefgh123${c}`)).toBeNull()
    expect(PASSWORD_HINT).toMatch(/lowercase.*uppercase.*digit.*symbol/)
  })
})
