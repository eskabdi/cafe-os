// The "order fired" sound at a receiving station (owner requirement). Generated with Web Audio (no asset, no network). Browsers
// only allow audio after a user gesture, so the station display arms it from a button press; the choice is a per-device UI pref.
import { readUiPref, writeUiPref } from './ui-prefs'

const PREF = 'kds-sound'
let ctx: AudioContext | null = null

export function soundPreferred(): boolean {
  return readUiPref(PREF) !== 'off'
}

export function setSoundPreferred(on: boolean): void {
  writeUiPref(PREF, on ? 'on' : 'off')
}

/** Call from a click handler: creates / resumes the audio context. Returns false when audio is unavailable. */
export function armChime(): boolean {
  try {
    const Ctor = globalThis.AudioContext ?? (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return false
    ctx = ctx ?? new Ctor()
    void ctx.resume()
    return true
  } catch {
    return false
  }
}

export function chimeArmed(): boolean {
  return ctx !== null && ctx.state === 'running'
}

/** Two short rising tones (about 0.4 s). Silent when not armed. */
export function playChime(): void {
  if (!ctx || ctx.state !== 'running') return
  const start = ctx.currentTime
  for (const [i, freq] of [880, 1320].entries()) {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = freq
    const t0 = start + i * 0.18
    gain.gain.setValueAtTime(0.0001, t0)
    gain.gain.exponentialRampToValueAtTime(0.4, t0 + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.16)
    osc.connect(gain).connect(ctx.destination)
    osc.start(t0)
    osc.stop(t0 + 0.18)
  }
}
