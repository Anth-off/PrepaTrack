import { describe, expect, it, vi } from 'vitest'
import { playFeedbackBeep } from './audioFeedback'

function fakeContext(initialState: AudioContextState = 'running') {
  let state = initialState
  const oscillator = {
    frequency: { value: 0 },
    type: 'sine',
    connect: vi.fn(),
    disconnect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    addEventListener: vi.fn(),
  }
  const gain = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    gain: {
      setValueAtTime: vi.fn(),
      exponentialRampToValueAtTime: vi.fn(),
    },
  }
  const context = {
    get state() { return state },
    currentTime: 4,
    destination: {},
    resume: vi.fn(async () => { state = 'running' }),
    createOscillator: vi.fn(() => oscillator),
    createGain: vi.fn(() => gain),
  } as unknown as AudioContext
  return { context, oscillator, gain }
}

describe('confirmation sonore', () => {
  it('attend la reprise iOS avant de programmer le son', async () => {
    const { context, oscillator } = fakeContext('suspended')
    await playFeedbackBeep(context)
    expect(context.resume).toHaveBeenCalledOnce()
    expect(oscillator.start).toHaveBeenCalledWith(4.005)
  })

  it('programme chaque bip sur le même contexte déjà actif', async () => {
    const { context } = fakeContext()
    await playFeedbackBeep(context, { times: 3, frequency: 880 })
    expect(context.resume).not.toHaveBeenCalled()
    expect(context.createOscillator).toHaveBeenCalledTimes(3)
  })
})
