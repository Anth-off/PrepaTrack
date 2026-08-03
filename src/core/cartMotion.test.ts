import { describe, expect, it } from 'vitest'
import {
  calibrationThreshold,
  CartMotionDetector,
  MotionEnergyMeter,
  rootMeanSquare,
} from './cartMotion'

describe('énergie de mouvement du chariot', () => {
  it('calcule une intensité indépendante de l’orientation', () => {
    const meter = new MotionEnergyMeter()
    expect(meter.sample({ at: 0, acceleration: { x: 3, y: 4, z: 0 } })).toBe(5)
  })

  it('retire la gravité quand seule l’accélération brute est disponible', () => {
    const meter = new MotionEnergyMeter()
    expect(
      meter.sample({ at: 0, accelerationIncludingGravity: { x: 0, y: 0, z: 9.81 } }),
    ).toBe(0)
    expect(
      meter.sample({ at: 20, accelerationIncludingGravity: { x: 0, y: 0, z: 9.81 } }),
    ).toBeCloseTo(0)
  })

  it('calcule la moyenne quadratique utilisée pendant la calibration', () => {
    expect(rootMeanSquare([3, 4])).toBeCloseTo(Math.sqrt(12.5))
  })
})

describe('classification immobile / déplacement', () => {
  it('ignore un choc isolé puis déclenche après un mouvement durable', () => {
    const detector = new CartMotionDetector(0.5, 2_000, 3_500)
    const transitions: string[] = []

    for (let at = 0; at <= 1_500; at += 100) {
      const transition = detector.push(at, at === 500 ? 4 : 0.05)
      if (transition) transitions.push(transition)
    }
    expect(transitions).toEqual([])

    for (let at = 1_600; at <= 4_800; at += 100) {
      const transition = detector.push(at, 0.9)
      if (transition) transitions.push(transition)
    }
    expect(transitions).toEqual(['moving'])
  })

  it('attend un arrêt stable avant de fermer le trajet', () => {
    const detector = new CartMotionDetector(0.5, 500, 1_000)
    const transitions: string[] = []

    for (let at = 0; at <= 2_000; at += 100) {
      const transition = detector.push(at, 0.9)
      if (transition) transitions.push(transition)
    }
    for (let at = 2_100; at <= 4_500; at += 100) {
      const transition = detector.push(at, 0.02)
      if (transition) transitions.push(transition)
    }

    expect(transitions).toEqual(['moving', 'stationary'])
    expect(detector.current()).toBe('stationary')
  })
})

describe('calibration', () => {
  it('place le seuil entre le chariot immobile et roulant', () => {
    expect(calibrationThreshold(0.1, 0.6)).toBeCloseTo(0.3)
  })

  it('refuse deux mesures impossibles à distinguer', () => {
    expect(calibrationThreshold(0.1, 0.14)).toBeUndefined()
  })
})
