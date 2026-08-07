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
const STOP_THRESHOLD_RATIO = 1.15
const SILENCE_STOP_MS = 4_500

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
 * Empêche les vibrations résiduelles de rouvrir un trajet que l'utilisateur
 * vient de fermer. Le réarmement exige d'abord un véritable état immobile.
 */
export class AutomaticTravelGuard {
  private travelWasOpen = false
  private suppressedUntilStationary = false

  desiredMoving(physical: CartMotionTransition, travelOpen: boolean): boolean {
    if (this.travelWasOpen && !travelOpen && physical === 'moving') {
      this.suppressedUntilStationary = true
    }
    if (physical === 'stationary') this.suppressedUntilStationary = false
    this.travelWasOpen = travelOpen
    return physical === 'moving' && !this.suppressedUntilStationary
  }
}

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
  private lastSampleAt?: number

  constructor(
    private readonly threshold: number,
    private readonly startDelayMs = 2_000,
    private readonly stopDelayMs = 3_500,
  ) {}

  push(at: number, energy: number): CartMotionTransition | undefined {
    this.lastSampleAt = at
    this.samples.push({ at, energy })
    while (this.samples[0] && this.samples[0].at < at - WINDOW_MS) this.samples.shift()

    if (this.state === 'moving') {
      const stopThreshold = this.threshold * STOP_THRESHOLD_RATIO

      // La première mesure calme démarre immédiatement le délai d'arrêt sans
      // attendre que les anciennes vibrations roulantes quittent la fenêtre.
      if (this.candidate !== 'stationary') {
        if (energy < stopThreshold) {
          this.candidate = 'stationary'
          this.candidateSince = at
        }
        return undefined
      }

      const candidateEnergies = this.samples
        .filter((sample) => sample.at >= (this.candidateSince ?? at))
        .map((sample) => sample.energy)
      // Plusieurs valeurs franchement roulantes annulent l'arrêt. Une pointe
      // isolée reste tolérée ; un choc extrême annule par prudence.
      const movingAgain = energy >= this.threshold * 2.5 || (
        candidateEnergies.length >= 3 &&
        percentile(candidateEnergies, 0.75) >= stopThreshold
      )
      if (movingAgain) {
        this.candidate = undefined
        this.candidateSince = undefined
        return undefined
      }
      return this.completeCandidate(at)
    }

    if (this.samples.length < MIN_WINDOW_SAMPLES) return undefined

    const energies = this.samples.map((sample) => sample.energy)
    const rms = rootMeanSquare(energies)
    const next: CartMotionTransition = rms >= this.threshold ? 'moving' : 'stationary'
    return this.consider(at, next)
  }

  private consider(at: number, next: CartMotionTransition): CartMotionTransition | undefined {
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

    return this.completeCandidate(at)
  }

  private completeCandidate(at: number): CartMotionTransition | undefined {
    if (!this.candidate || this.candidateSince === undefined) return undefined
    const delay = this.candidate === 'moving' ? this.startDelayMs : this.stopDelayMs
    if (at - this.candidateSince < delay) return undefined

    this.state = this.candidate
    this.candidate = undefined
    this.candidateSince = undefined
    return this.state
  }

  /**
   * Fait progresser les délais même lorsqu'iOS raréfie ou suspend les mesures.
   * Appelé par une horloge indépendante de `devicemotion`.
   */
  tick(at: number): CartMotionTransition | undefined {
    const completed = this.completeCandidate(at)
    if (completed) return completed
    if (
      this.state === 'moving' &&
      this.lastSampleAt !== undefined &&
      at - this.lastSampleAt >= SILENCE_STOP_MS
    ) {
      return this.forceStationary()
    }
    return undefined
  }

  current(): CartMotionTransition {
    return this.state
  }

  forceStationary(): CartMotionTransition | undefined {
    this.samples.length = 0
    this.candidate = undefined
    this.candidateSince = undefined
    if (this.state === 'stationary') return undefined
    this.state = 'stationary'
    return 'stationary'
  }
}

export function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))
  return sorted[index]
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
