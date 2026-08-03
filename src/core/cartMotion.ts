export interface AccelerationVector {
  x: number
  y: number
  z: number
}

export interface CartMotionSample {
  at: number
  /** Accélération linéaire, gravité déjà retirée par le navigateur. */
  acceleration?: AccelerationVector
  /** Repli iOS lorsque `acceleration` n'est pas renseigné. */
  accelerationIncludingGravity?: AccelerationVector
}

/** Énergie minimale évitant qu'un capteur presque silencieux déclenche seul. */
const MIN_THRESHOLD = 0.08
const GRAVITY_ALPHA = 0.08
const WINDOW_MS = 1_000
const MIN_WINDOW_SAMPLES = 5

/**
 * Transforme les mesures orientées du téléphone en une intensité indépendante
 * de son sens de montage. Le filtre passe-haut retire progressivement la
 * gravité lorsque Safari ne fournit que `accelerationIncludingGravity`.
 */
export class MotionEnergyMeter {
  private gravity?: AccelerationVector

  sample(input: CartMotionSample): number | undefined {
    if (input.acceleration) return magnitude(input.acceleration)
    const value = input.accelerationIncludingGravity
    if (!value) return undefined

    if (!this.gravity) {
      this.gravity = { ...value }
      return 0
    }

    this.gravity.x += (value.x - this.gravity.x) * GRAVITY_ALPHA
    this.gravity.y += (value.y - this.gravity.y) * GRAVITY_ALPHA
    this.gravity.z += (value.z - this.gravity.z) * GRAVITY_ALPHA
    return magnitude({
      x: value.x - this.gravity.x,
      y: value.y - this.gravity.y,
      z: value.z - this.gravity.z,
    })
  }
}

export type CartMotionTransition = 'moving' | 'stationary'

/**
 * Classe les vibrations par fenêtres et exige une durée continue avant chaque
 * bascule. Un choc de palette ou un téléphone touché une fois ne peut donc pas
 * ouvrir un trajet.
 */
export class CartMotionDetector {
  private readonly samples: Array<{ at: number; energy: number }> = []
  private state: CartMotionTransition = 'stationary'
  private candidateSince?: number
  private candidate?: CartMotionTransition

  constructor(
    private readonly threshold: number,
    private readonly startDelayMs = 2_000,
    private readonly stopDelayMs = 3_500,
  ) {}

  push(at: number, energy: number): CartMotionTransition | undefined {
    this.samples.push({ at, energy })
    while (this.samples[0] && this.samples[0].at < at - WINDOW_MS) this.samples.shift()
    if (this.samples.length < MIN_WINDOW_SAMPLES) return undefined

    const rms = rootMeanSquare(this.samples.map((sample) => sample.energy))
    const next: CartMotionTransition = rms >= this.threshold ? 'moving' : 'stationary'
    if (next === this.state) {
      this.candidate = undefined
      this.candidateSince = undefined
      return undefined
    }

    if (this.candidate !== next) {
      this.candidate = next
      this.candidateSince = at
      return undefined
    }

    const delay = next === 'moving' ? this.startDelayMs : this.stopDelayMs
    if (this.candidateSince === undefined || at - this.candidateSince < delay) return undefined

    this.state = next
    this.candidate = undefined
    this.candidateSince = undefined
    return next
  }

  current(): CartMotionTransition {
    return this.state
  }
}

export function calibrationThreshold(stationary: number, moving: number): number | undefined {
  if (!Number.isFinite(stationary) || !Number.isFinite(moving)) return undefined
  // La mesure roulante doit dépasser franchement le bruit du chariot immobile.
  if (moving < stationary * 1.35 + 0.03) return undefined
  return Math.max(MIN_THRESHOLD, stationary + (moving - stationary) * 0.4)
}

export function rootMeanSquare(values: number[]): number {
  if (values.length === 0) return 0
  return Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length)
}

function magnitude(value: AccelerationVector): number {
  return Math.sqrt(value.x * value.x + value.y * value.y + value.z * value.z)
}
