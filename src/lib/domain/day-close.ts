// Day-close variance tones (prototype thresholds, unchanged): cash 0 = balanced, |v| < 50 ETB minor, else major; station stock
// 0 = balanced, |v| < 10 or under 5% of the expected quantity minor, else major. Display only: the variance itself is computed and
// frozen by fn_close_day.

export type VarianceTone = 'balanced' | 'minor' | 'major'

export function cashVarianceTone(v: number): VarianceTone {
  const a = Math.abs(Math.round(v * 100)) / 100
  if (a === 0) return 'balanced'
  return a < 50 ? 'minor' : 'major'
}

export function stockVarianceTone(v: number, expected: number): VarianceTone {
  const a = Math.abs(Math.round(v * 1000)) / 1000
  if (a === 0) return 'balanced'
  return a < 10 || (expected > 0 && a / expected < 0.05) ? 'minor' : 'major'
}
