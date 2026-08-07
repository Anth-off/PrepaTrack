import { describe, expect, it } from 'vitest'
import {
  AutomaticTravelGuard,
  calibrationThreshold,
  CartMotionDetector,
  MotionEnergyMeter,
  rootMeanSquare,
} from './cartMotion'

describe('priorité à l’arrêt manuel', () => {
  it('ne réouvre pas le trajet avant un arrêt puis un nouveau départ', () => {
    const guard = new AutomaticTravelGuard()
    expect(guard.desiredMoving('moving', false)).toBe(true)
    expect(guard.desiredMoving('moving', true)).toBe(true)

    // Le trajet vient d'être fermé alors que le capteur voit encore du mouvement.
    expect(guard.desiredMoving('moving', false)).toBe(false)
    expect(guard.desiredMoving('moving', false)).toBe(false)

    expect(guard.desiredMoving('stationary', false)).toBe(false)
    expect(guard.desiredMoving('moving', false)).toBe(true)
  })
})

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

  it('ferme le trajet malgré les vibrations résiduelles du chariot immobile', () => {
    const detector = new CartMotionDetector(0.5, 500, 1_000)
    const transitions: string[] = []

    for (let at = 0; at <= 2_000; at += 100) {
      const transition = detector.push(at, 0.9)
      if (transition) transitions.push(transition)
    }
    // 0,4 est sous le seuil calibré (0,5), mais au-dessus de l'ancien seuil de
    // sortie (0,325) qui laissait le trajet ouvert indéfiniment.
    for (let at = 2_100; at <= 4_500; at += 100) {
      const transition = detector.push(at, 0.4)
      if (transition) transitions.push(transition)
    }

    expect(transitions).toEqual(['moving', 'stationary'])
  })

  it('peut fermer un trajet lorsque iOS ne transmet plus aucun échantillon', () => {
    const detector = new CartMotionDetector(0.5, 500, 1_000)
    for (let at = 0; at <= 2_000; at += 100) detector.push(at, 0.9)
    expect(detector.current()).toBe('moving')
    expect(detector.forceStationary()).toBe('stationary')
    expect(detector.current()).toBe('stationary')
  })

  it('termine un arrêt candidat avec une horloge indépendante des capteurs', () => {
    const detector = new CartMotionDetector(0.5, 500, 1_000)
    for (let at = 0; at <= 2_000; at += 100) detector.push(at, 0.9)
    expect(detector.current()).toBe('moving')

    // iOS ne fournit plus qu'une mesure calme puis espace ses événements.
    detector.push(2_100, 0.05)
    expect(detector.tick(3_200)).toBe('stationary')
  })

  it('ignore les chocs isolés pendant la confirmation de l’arrêt', () => {
    const detector = new CartMotionDetector(0.5, 500, 1_000)
    for (let at = 0; at <= 2_000; at += 100) detector.push(at, 0.9)
    for (let at = 2_100; at <= 2_700; at += 100) detector.push(at, 0.08)
    detector.push(2_800, 0.7)
    for (let at = 2_900; at <= 3_500; at += 100) detector.push(at, 0.08)

    expect(detector.current()).toBe('stationary')
  })

  it('ne termine jamais un trajet dont les vibrations roulantes continuent', () => {
    const detector = new CartMotionDetector(0.5, 500, 1_000)
    for (let at = 0; at <= 8_000; at += 100) detector.push(at, 0.9)
    expect(detector.tick(8_100)).toBeUndefined()
    expect(detector.current()).toBe('moving')
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
